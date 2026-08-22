import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const adapter = new URL("../dist/bin/openai-compatible-tool-adapter.js", import.meta.url).pathname;

const sharedEnv = {
  OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
  OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
  OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
  ADAPTER_TEST_NO_KEY: "",
  OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "1",
};

test("rejects file: base URL at startup", async () => {
  const result = await runAdapter({
    ...sharedEnv,
    OPENAI_COMPATIBLE_ADAPTER_BASE_URL: "file:///etc/passwd",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /must use http:\/\/ or https:\/\//);
});

test("rejects ftp: base URL at startup", async () => {
  const result = await runAdapter({
    ...sharedEnv,
    OPENAI_COMPATIBLE_ADAPTER_BASE_URL: "ftp://example.com",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /must use http:\/\/ or https:\/\//);
});

test("rejects a malformed base URL at startup", async () => {
  const result = await runAdapter({
    ...sharedEnv,
    OPENAI_COMPATIBLE_ADAPTER_BASE_URL: "not a url",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /must be a valid URL/);
});

test("accepts an http base URL with a trailing slash", async () => {
  const result = await runAdapter({
    ...sharedEnv,
    OPENAI_COMPATIBLE_ADAPTER_BASE_URL: "http://127.0.0.1:1/v1/",
    OPENAI_COMPATIBLE_ADAPTER_REQUEST_TIMEOUT_MS: "2000",
  });
  assert.doesNotMatch(result.stderr, /must use http|must be a valid URL/);
});

async function runAdapter(env) {
  const repo = mkdtempSync(path.join(tmpdir(), "adapter-base-url-"));
  try {
    const child = spawn(process.execPath, [adapter, "exec", "--cd", repo, "--json", "-"], {
      cwd: repo,
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
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}
