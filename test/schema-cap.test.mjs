import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const adapter = new URL("../dist/bin/openai-compatible-tool-adapter.js", import.meta.url).pathname;

const schemaEnv = {
  OPENAI_COMPATIBLE_ADAPTER_BASE_URL: "http://127.0.0.1:1/v1",
  OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
  OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
  OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
  ADAPTER_TEST_NO_KEY: "",
};

test("CLI rejects a directory passed as --output-schema", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "adapter-schema-dir-"));
  try {
    const result = spawnSync(
      process.execPath,
      [adapter, "exec", "--cd", repo, "--output-schema", repo, "--json", "-"],
      {
        cwd: repo,
        env: { ...process.env, ...schemaEnv },
        encoding: "utf8",
        input: "Inspect the project and finish without tools.\n",
        timeout: 15000,
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /must be a regular file/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI rejects an --output-schema file larger than the byte cap", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "adapter-schema-big-"));
  try {
    const schemaPath = path.join(repo, "huge.schema.json");
    writeFileSync(schemaPath, Buffer.alloc(257 * 1024, "{} "));
    const result = spawnSync(
      process.execPath,
      [adapter, "exec", "--cd", repo, "--output-schema", schemaPath, "--json", "-"],
      {
        cwd: repo,
        env: {
          ...process.env,
          ...schemaEnv,
          OPENAI_COMPATIBLE_ADAPTER_MAX_SCHEMA_BYTES: "1024",
        },
        encoding: "utf8",
        input: "Inspect the project and finish without tools.\n",
        timeout: 15000,
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /exceeds OPENAI_COMPATIBLE_ADAPTER_MAX_SCHEMA_BYTES/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI rejects a FIFO passed as --output-schema without blocking", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "adapter-schema-fifo-"));
  try {
    const fifoPath = path.join(repo, "schema.fifo");
    const mkfifo = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
    assert.equal(mkfifo.status, 0, mkfifo.stderr);
    const result = spawnSync(
      process.execPath,
      [adapter, "exec", "--cd", repo, "--output-schema", fifoPath, "--json", "-"],
      {
        cwd: repo,
        env: { ...process.env, ...schemaEnv },
        encoding: "utf8",
        input: "Inspect the project and finish without tools.\n",
        timeout: 15000,
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.signal, null, "child must exit on its own before the timeout");
    assert.match(result.stderr, /must be a regular file/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("write_file refuses content over OPENAI_COMPATIBLE_ADAPTER_MAX_WRITE_BYTES", async () => {
  const oversized = Buffer.alloc(2 * 1024 * 1024 + 8, "x").toString();
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    requests.push(body);
    if (body.messages.some((message) => message.role === "tool")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }),
      );
      return;
    }
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
                  id: "t1",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ path: "big.txt", content: oversized }),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const repo = mkdtempSync(path.join(tmpdir(), "adapter-write-cap-"));
  try {
    const result = await runAdapter(repo, {
      OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
      ADAPTER_TEST_NO_KEY: "",
      OPENAI_COMPATIBLE_ADAPTER_ALLOWED_FILES: "big.txt",
      OPENAI_COMPATIBLE_ADAPTER_MAX_WRITE_BYTES: "1024",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(requests.length >= 2, "expected a follow-up request after the tool call");
    const toolMessage = requests[1].messages.find((message) => message.role === "tool");
    assert.ok(toolMessage, "follow-up request must include the write_file tool result");
    const toolResult = JSON.parse(toolMessage.content);
    assert.equal(toolResult.ok, false, toolMessage.content);
    assert.match(String(toolResult.error), /exceeds OPENAI_COMPATIBLE_ADAPTER_MAX_WRITE_BYTES/);
    assert.equal(existsSync(path.join(repo, "big.txt")), false, "oversized write must not create the file");
  } finally {
    server.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

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
