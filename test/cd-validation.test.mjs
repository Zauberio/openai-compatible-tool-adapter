import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const adapter = new URL("../dist/bin/openai-compatible-tool-adapter.js", import.meta.url).pathname;

const cdEnv = {
  OPENAI_COMPATIBLE_ADAPTER_BASE_URL: "http://127.0.0.1:1/v1",
  OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
  OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
  OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
  ADAPTER_TEST_NO_KEY: "",
};

function runCd(cdPath, extraEnv = {}) {
  return spawnSync(process.execPath, [adapter, "exec", "--cd", cdPath, "--json", "-"], {
    cwd: process.cwd(),
    env: { ...process.env, ...cdEnv, ...extraEnv },
    encoding: "utf8",
    input: "Inspect the project and finish without tools.\n",
    timeout: 15000,
  });
}

test("CLI rejects a nonexistent --cd path before provider access", () => {
  const missing = path.join(tmpdir(), `adapter-missing-cd-${process.pid}-${Date.now()}`);
  const result = runCd(missing);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /--cd target does not exist/);
  assert.match(result.stderr, new RegExp(escapeRegExp(path.resolve(missing))));
});

test("CLI rejects a regular file passed as --cd", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-cd-file-"));
  try {
    const file = path.join(root, "not-a-dir.txt");
    writeFileSync(file, "x");
    const result = runCd(file);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /--cd target is not a directory/);
    assert.match(result.stderr, new RegExp(escapeRegExp(path.resolve(file))));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI accepts a valid --cd directory and reaches the provider", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ url: request.url, body: JSON.parse(body) });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "completed" } }] }),
    );
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const repo = mkdtempSync(path.join(tmpdir(), "adapter-cd-dir-"));
  try {
    const result = await runAdapter(repo, {
      ...cdEnv,
      OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /--cd target/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/chat/completions");
    assert.match(result.stdout, /completed/);
  } finally {
    server.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
