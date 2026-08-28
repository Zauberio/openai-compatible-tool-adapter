import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const adapter = new URL("../dist/bin/openai-compatible-tool-adapter.js", import.meta.url).pathname;

test("truncate backs up at a high surrogate and reports the actual removed units", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "adapter-truncate-surrogate-"));
  try {
    // "a😀bc" is 5 UTF-16 units (a, high, low, b, c). Limit 2 lands after the
    // high surrogate, so the cut must back up to 1 and the marker must count
    // from that cut (4), not from the requested limit (which would say 3).
    writeFileSync(path.join(repo, "emoji.txt"), "a😀bc", "utf8");
    const { payload, rawBody } = await runCommand(repo, "cat emoji.txt", {
      OPENAI_COMPATIBLE_ADAPTER_COMMAND_OUTPUT_LIMIT: "2",
    });

    assert.equal(payload.stdout, "a\n...[truncated 4 chars]");
    assert.equal(payload.stdout.isWellFormed(), true);
    assert.equal(Buffer.from(payload.stdout, "utf8").toString("utf8"), payload.stdout);
    assertUtf8JsonConsumable(rawBody, payload.stdout);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("truncate keeps a complete surrogate pair and reports ASCII removals from the cut", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "adapter-truncate-pair-ascii-"));
  try {
    writeFileSync(path.join(repo, "emoji.txt"), "a😀bc", "utf8");
    writeFileSync(path.join(repo, "ascii.txt"), "hello world", "utf8");

    const complete = await runCommand(repo, "cat emoji.txt", {
      OPENAI_COMPATIBLE_ADAPTER_COMMAND_OUTPUT_LIMIT: "3",
    });
    assert.equal(complete.payload.stdout, "a😀\n...[truncated 2 chars]");
    assert.equal(complete.payload.stdout.isWellFormed(), true);
    assert.equal(complete.payload.stdout.includes("😀"), true);

    const ascii = await runCommand(repo, "cat ascii.txt", {
      OPENAI_COMPATIBLE_ADAPTER_COMMAND_OUTPUT_LIMIT: "5",
    });
    assert.equal(ascii.payload.stdout, "hello\n...[truncated 6 chars]");
    assert.doesNotMatch(ascii.payload.stdout, /truncated 5 chars/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

async function runCommand(cwd, command, extraEnv = {}) {
  const requests = [];
  const rawBodies = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    rawBodies.push(body);
    requests.push(JSON.parse(body));
    if (requests.length === 1) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call-truncate-surrogate",
                    type: "function",
                    function: {
                      name: "run_command",
                      arguments: JSON.stringify({ command }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "completed" } }] }),
    );
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await runAdapter(cwd, {
      OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
      ADAPTER_TEST_NO_KEY: "",
      OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "1",
      ...extraEnv,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 2);
    const toolMessage = requests[1].messages.find((message) => message.role === "tool");
    assert.ok(toolMessage, "follow-up request missing tool result");
    return { payload: JSON.parse(toolMessage.content), rawBody: rawBodies[1] };
  } finally {
    server.close();
  }
}

async function runAdapter(cwd, env) {
  const child = spawn(process.execPath, [adapter, "exec", "--cd", cwd, "--json", "-"], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end("Inspect the project and finish without tools.\n");
  const [status, signal] = await once(child, "close");
  return { status, signal, stdout, stderr };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}

async function readBody(request) {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) body += chunk;
  return body;
}

function assertUtf8JsonConsumable(rawBody, stdout) {
  assert.equal(rawBody.isWellFormed(), true);
  assert.equal(Buffer.from(rawBody, "utf8").toString("utf8"), rawBody);
  JSON.parse(rawBody);

  const python = spawnSync(
    "python3",
    [
      "-c",
      [
        "import json, sys",
        "body = json.loads(sys.stdin.read())",
        "tool = next(m for m in body['messages'] if m.get('role') == 'tool')",
        "payload = json.loads(tool['content'])",
        "payload['stdout'].encode('utf-8')",
        "print(payload['stdout'])",
      ].join("; "),
    ],
    { input: rawBody, encoding: "utf8" },
  );
  if (python.error && python.error.code === "ENOENT") return;
  assert.equal(python.status, 0, python.stderr);
  assert.equal(python.stdout, `${stdout}\n`);
}
