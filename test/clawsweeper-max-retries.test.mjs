import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const adapter = new URL("../dist/bin/openai-compatible-tool-adapter.js", import.meta.url).pathname;

const requiredEnv = {
  OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
  OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
  OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
  ADAPTER_TEST_NO_KEY: "",
};

// Strict decimal parsing stays: values Number() would silently accept as a
// different number (hex, scientific notation, whitespace-padded) must warn
// and fall back to the default per the shared warn-and-fallback contract
// (PR #24) instead of being accepted or throwing.
for (const value of ["0x10", "1e3", " 3 "]) {
  test(`OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES=${JSON.stringify(value)} warns and falls back to 3 attempts`, async () => {
    const { result } = await runWithRetries(value);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stderr,
      new RegExp(
        `\\[openai-compatible-tools\\] warning: OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES="${escapeRegExp(value)}" is not a valid positive number, using default 3`,
      ),
    );
    assert.match(result.stderr, /chat_start turn=1 attempt=1\/3 /);
  });
}

test("OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES=0 warns and falls back to 3 attempts", async () => {
  const { result, requests } = await runWithRetries("0");
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    /\[openai-compatible-tools\] warning: OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES="0" is not a valid positive number, using default 3/,
  );
  assert.match(result.stderr, /chat_start turn=1 attempt=1\/3 /);
  assert.equal(requests.length, 1);
  assert.equal(requests[0], "/v1/chat/completions");
  assert.match(result.stdout, /completed/);
});

test("OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES=3 starts a request successfully", async () => {
  const { result, requests } = await runWithRetries("3");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /MAX_RETRIES=.*using default/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0], "/v1/chat/completions");
  assert.match(result.stdout, /completed/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runWithRetries(value) {
  const requests = [];
  const server = createServer(async (request, response) => {
    await readBody(request);
    requests.push(request.url);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "completed" } }] }),
    );
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const repo = mkdtempSync(path.join(tmpdir(), "adapter-retries-"));
  try {
    const result = await runAdapter(repo, {
      OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      ...requiredEnv,
      OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: value,
    });
    return { result, requests };
  } finally {
    server.close();
    rmSync(repo, { recursive: true, force: true });
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
