import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const adapter = new URL("../dist/bin/openai-compatible-tool-adapter.js", import.meta.url).pathname;

function adapterEnv(port, extra = {}) {
  return {
    OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${port}/v1`,
    OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
    OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
    OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
    ADAPTER_TEST_NO_KEY: "",
    OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "1",
    OPENAI_COMPATIBLE_ADAPTER_MAX_PROMPT_BYTES: "100",
    ...extra,
  };
}

test("CLI rejects a stdin prompt that exceeds OPENAI_COMPATIBLE_ADAPTER_MAX_PROMPT_BYTES", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "adapter-prompt-over-"));
  try {
    const result = await runAdapter(repo, adapterEnv(9), "x".repeat(200));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /stdin prompt exceeds OPENAI_COMPATIBLE_ADAPTER_MAX_PROMPT_BYTES/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI accepts a stdin prompt under OPENAI_COMPATIBLE_ADAPTER_MAX_PROMPT_BYTES", async () => {
  const server = createServer(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "completed" } }] }),
    );
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const repo = mkdtempSync(path.join(tmpdir(), "adapter-prompt-under-"));
  try {
    const result = await runAdapter(repo, adapterEnv(address.port), "x".repeat(50));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /completed/);
  } finally {
    server.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

async function runAdapter(cwd, env, prompt) {
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
  child.stdin.end(prompt);
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
