import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const adapter = new URL("../dist/bin/openai-compatible-tool-adapter.js", import.meta.url).pathname;
const compiled = readFileSync(adapter, "utf8");
const retryDelaySource = compiled.match(/function retryDelayMs\([\s\S]*?\n\}/)?.[0];
assert.ok(retryDelaySource, "compiled adapter must contain retryDelayMs");
const retryDelayMs = new Function(`${retryDelaySource}; return retryDelayMs;`)();

function retryAfterResponse(value) {
  return { headers: { get: (name) => (name.toLowerCase() === "retry-after" ? value : null) } };
}

test("HTTP-date Retry-After computes a positive delay from one clock sample", () => {
  const nowCalls = [];
  const realNow = Date.now;
  Date.now = () => {
    nowCalls.push(nowCalls.length === 0 ? 1_000_000 : 1_000_002);
    return nowCalls[nowCalls.length - 1];
  };
  try {
    const delay = retryDelayMs(retryAfterResponse(new Date(1_000_001).toISOString()), 1);
    assert.equal(nowCalls.length, 1);
    assert.equal(delay, 1);
  } finally {
    Date.now = realNow;
  }
});

test("past HTTP-date Retry-After falls through to exponential backoff", () => {
  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    const delay = retryDelayMs(retryAfterResponse("Thu, 01 Jan 1970 00:00:00 GMT"), 1);
    assert.equal(delay, 1000);
  } finally {
    Math.random = realRandom;
  }
});

test("generic CLI honors a future HTTP-date Retry-After and retries", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    await readBody(request);
    requests.push(Date.now());
    if (requests.length === 1) {
      response.writeHead(503, {
        "Content-Type": "application/json",
        "Retry-After": new Date(Date.now() + 2000).toISOString(),
      });
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

  const repo = mkdtempSync(path.join(tmpdir(), "adapter-retry-after-future-"));
  try {
    const result = await runAdapter(repo, {
      OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
      ADAPTER_TEST_NO_KEY: "",
      OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "2",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 2);
    const waited = requests[1] - requests[0];
    assert.ok(waited >= 1700, `expected HTTP-date delay, waited ${waited}ms\n${result.stderr}`);
    assert.ok(waited < 2800, `expected HTTP-date delay below the 30s cap, waited ${waited}ms\n${result.stderr}`);
    assert.match(result.stderr, /chat_done turn=1 attempt=1\/2 status=503/);
    assert.match(result.stderr, /chat_done turn=1 attempt=2\/2 status=200/);
    assert.match(result.stdout, /completed/);
  } finally {
    server.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("generic CLI does not immediately retry a stale HTTP-date Retry-After", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    await readBody(request);
    requests.push(Date.now());
    if (requests.length === 1) {
      response.writeHead(503, {
        "Content-Type": "application/json",
        "Retry-After": "Thu, 01 Jan 1970 00:00:00 GMT",
      });
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

  const repo = mkdtempSync(path.join(tmpdir(), "adapter-retry-after-past-"));
  try {
    const result = await runAdapter(repo, {
      OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
      ADAPTER_TEST_NO_KEY: "",
      OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "2",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 2);
    const waited = requests[1] - requests[0];
    assert.ok(waited >= 1000, `expected backoff, waited ${waited}ms\n${result.stderr}`);
    assert.match(result.stderr, /chat_done turn=1 attempt=1\/2 status=503/);
    assert.match(result.stderr, /chat_done turn=1 attempt=2\/2 status=200/);
    assert.match(result.stdout, /completed/);
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
