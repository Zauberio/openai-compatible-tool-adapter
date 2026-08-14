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

const warningRe = (name, value, kind, fallback) =>
  new RegExp(
    `\\[openai-compatible-tools\\] warning: ${name}="${value}" is not a valid ${kind} number, using default ${fallback}`,
  );

test("invalid MAX_RETRIES warns and falls back to 3 attempts", async () => {
  const result = await runWithProvider({ OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "abc" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    warningRe("OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES", "abc", "positive", 3),
  );
  assert.match(result.stderr, /chat_start turn=1 attempt=1\/3 /);
  assert.equal(result.requests.length, 1);
});

test("MAX_RETRIES=0 warns and falls back to 3 attempts", async () => {
  const result = await runWithProvider({ OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "0" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    warningRe("OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES", "0", "positive", 3),
  );
  assert.match(result.stderr, /chat_start turn=1 attempt=1\/3 /);
});

test("valid MAX_RETRIES is used and does not warn", async () => {
  const result = await runWithProvider({ OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "5" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /MAX_RETRIES=.*using default/);
  assert.match(result.stderr, /chat_start turn=1 attempt=1\/5 /);
});

test("blank MAX_RETRIES keeps the default without warning", async () => {
  const result = await runWithProvider({ OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /MAX_RETRIES=.*using default/);
  assert.match(result.stderr, /chat_start turn=1 attempt=1\/3 /);
});

test("invalid COMMAND_TIMEOUT_MS warns and names the documented default", async () => {
  const result = await runWithProvider({ OPENAI_COMPATIBLE_ADAPTER_COMMAND_TIMEOUT_MS: "-1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    warningRe("OPENAI_COMPATIBLE_ADAPTER_COMMAND_TIMEOUT_MS", "-1", "positive", 120000),
  );
});

test("COMMAND_TIMEOUT_MS=0 warns and names the documented default", async () => {
  const result = await runWithProvider({ OPENAI_COMPATIBLE_ADAPTER_COMMAND_TIMEOUT_MS: "0" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    warningRe("OPENAI_COMPATIBLE_ADAPTER_COMMAND_TIMEOUT_MS", "0", "positive", 120000),
  );
});

test("invalid REQUEST_TIMEOUT_MS warns and falls back to 600000", async () => {
  const result = await runWithProvider({ OPENAI_COMPATIBLE_ADAPTER_REQUEST_TIMEOUT_MS: "-1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    warningRe("OPENAI_COMPATIBLE_ADAPTER_REQUEST_TIMEOUT_MS", "-1", "positive", 600000),
  );
  assert.match(result.stderr, /chat_start .* timeout_ms=600000 /);
});

test("invalid MAX_TOKENS warns and omits max_tokens", async () => {
  const result = await runWithProvider({ OPENAI_COMPATIBLE_ADAPTER_MAX_TOKENS: "-1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    warningRe("OPENAI_COMPATIBLE_ADAPTER_MAX_TOKENS", "-1", "non-negative", 0),
  );
  assert.match(result.stderr, /chat_start .* max_tokens=provider_default/);
  assert.equal(result.requests[0].body.max_tokens, undefined);
});

test("MAX_TOKENS=0 is accepted without warning", async () => {
  const result = await runWithProvider({ OPENAI_COMPATIBLE_ADAPTER_MAX_TOKENS: "0" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /MAX_TOKENS=.*using default/);
  assert.match(result.stderr, /chat_start .* max_tokens=provider_default/);
  assert.equal(result.requests[0].body.max_tokens, undefined);
});

test("blank MAX_TOKENS is 0 without warning", async () => {
  const result = await runWithProvider({ OPENAI_COMPATIBLE_ADAPTER_MAX_TOKENS: "" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /MAX_TOKENS=.*using default/);
  assert.match(result.stderr, /chat_start .* max_tokens=provider_default/);
});

test("valid MAX_TOKENS is forwarded and does not warn", async () => {
  const result = await runWithProvider({ OPENAI_COMPATIBLE_ADAPTER_MAX_TOKENS: "128" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /MAX_TOKENS=.*using default/);
  assert.match(result.stderr, /chat_start .* max_tokens=128/);
  assert.equal(result.requests[0].body.max_tokens, 128);
});

test("unset numeric env vars do not emit fallback warnings", async () => {
  const result = await runWithProvider({});
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /\[openai-compatible-tools\] warning:/);
  assert.match(result.stderr, /chat_start turn=1 attempt=1\/3 /);
  assert.match(result.stderr, /timeout_ms=600000 /);
  assert.match(result.stderr, /max_tokens=provider_default/);
});

async function runWithProvider(extraEnv) {
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

  const repo = mkdtempSync(path.join(tmpdir(), "adapter-env-warn-"));
  try {
    const result = await runAdapter(repo, {
      ...requiredEnv,
      OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      ...extraEnv,
    });
    return { ...result, requests };
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
