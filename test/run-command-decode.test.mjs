import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const adapter = new URL("../dist/bin/openai-compatible-tool-adapter.js", import.meta.url).pathname;

test("run_command flags invalid UTF-8 bytes as lossy, not a literal U+FFFD", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "adapter-run-command-decode-"));
  try {
    writeFileSync(path.join(repo, "invalid.bin"), Buffer.from([0xff]));
    writeFileSync(path.join(repo, "fffd.txt"), "ok\uFFFDtext\n");

    const invalid = await runCommand(repo, "cat invalid.bin");
    assert.equal(invalid.ok, true, JSON.stringify(invalid));
    assert.equal(invalid.binaryOutput, true);
    assert.match(String(invalid.note ?? ""), /non-UTF-8 bytes/);
    assert.match(String(invalid.stdout ?? ""), /\uFFFD/);

    const literal = await runCommand(repo, "cat fffd.txt");
    assert.equal(literal.ok, true, JSON.stringify(literal));
    assert.equal(literal.binaryOutput, undefined);
    assert.equal(literal.note, undefined);
    assert.equal(literal.stdout, "ok\uFFFDtext\n");

    const clean = await runCommand(repo, "printf hello");
    assert.equal(clean.ok, true, JSON.stringify(clean));
    assert.equal(clean.binaryOutput, undefined);
    assert.equal(clean.stdout, "hello");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("run_command flags invalid UTF-8 on stderr the same way", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "adapter-run-command-decode-err-"));
  try {
    writeFileSync(path.join(repo, "invalid.bin"), Buffer.from([0xc0, 0x80]));
    const result = await runCommand(repo, "cat invalid.bin >&2");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.binaryOutput, true);
    assert.match(String(result.stderr ?? ""), /\uFFFD/);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

async function runCommand(cwd, command) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    requests.push(body);
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
                    id: "call-run-command-decode",
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
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 2);
    const toolMessage = requests[1].messages.find((message) => message.role === "tool");
    assert.ok(toolMessage, "follow-up request missing tool result");
    return JSON.parse(toolMessage.content);
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
