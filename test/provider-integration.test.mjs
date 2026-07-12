import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const adapter = new URL("../dist/bin/openai-compatible-tool-adapter.js", import.meta.url).pathname;

test("generic CLI retries a transient provider error and sends configured headers", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ headers: request.headers, body: JSON.parse(body), url: request.url });
    if (requests.length === 1) {
      response.writeHead(503, { "Content-Type": "application/json", "Retry-After": "0" });
      response.end(JSON.stringify({ error: "temporary" }));
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

  const repo = mkdtempSync(path.join(tmpdir(), "adapter-provider-"));
  try {
    const result = await runAdapter(repo, {
      OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
      ADAPTER_TEST_NO_KEY: "",
      OPENAI_COMPATIBLE_ADAPTER_HEADERS_JSON: '{"X-Test-Project":"adapter"}',
      OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "2",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "/v1/chat/completions");
    assert.equal(requests[1].headers["x-test-project"], "adapter");
    assert.equal(requests[1].headers.authorization, undefined);
    assert.equal(requests[1].body.model, "test/model");
    assert.match(requests[1].body.messages[0].content, /implementation agent/);
    assert.doesNotMatch(requests[1].body.messages[0].content, /ClawSweeper/);
    assert.match(result.stdout, /completed/);
  } finally {
    server.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("generic CLI reports a malformed successful provider response", async () => {
  const server = createServer(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [] }));
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const repo = mkdtempSync(path.join(tmpdir(), "adapter-provider-bad-"));
  try {
    const result = await runAdapter(repo, {
      OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
      ADAPTER_TEST_NO_KEY: "",
      OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "1",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing choices\[0\]\.message/);
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
