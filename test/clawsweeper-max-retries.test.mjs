import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const adapter = new URL("../dist/bin/openai-compatible-tool-adapter.js", import.meta.url).pathname;

const requiredEnv = {
  OPENAI_COMPATIBLE_ADAPTER_BASE_URL: "http://127.0.0.1:1/v1",
  OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
  OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
  OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
  ADAPTER_TEST_NO_KEY: "",
};

function rejectRetries(value) {
  return spawnSync(process.execPath, [adapter, "exec", "-"], {
    input: "Inspect the project and finish without tools.\n",
    encoding: "utf8",
    env: {
      ...process.env,
      ...requiredEnv,
      OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: value,
    },
  });
}

test("OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES=0x10 is rejected", () => {
  const result = rejectRetries("0x10");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-negative integer/);
});

test("OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES=1e3 is rejected", () => {
  const result = rejectRetries("1e3");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-negative integer/);
});

test("OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES whitespace-padded value is rejected", () => {
  const result = rejectRetries(" 3 ");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-negative integer/);
});

test("OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES=0 starts one request and succeeds", async () => {
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

  const repo = mkdtempSync(path.join(tmpdir(), "adapter-retries-zero-"));
  try {
    const result = await runAdapter(repo, {
      OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
      ADAPTER_TEST_NO_KEY: "",
      OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "0",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 1);
    assert.equal(requests[0], "/v1/chat/completions");
    assert.match(result.stdout, /completed/);
  } finally {
    server.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES=3 starts a request successfully", async () => {
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

  const repo = mkdtempSync(path.join(tmpdir(), "adapter-retries-three-"));
  try {
    const result = await runAdapter(repo, {
      OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
      ADAPTER_TEST_NO_KEY: "",
      OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "3",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 1);
    assert.equal(requests[0], "/v1/chat/completions");
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
