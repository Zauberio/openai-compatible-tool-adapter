import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const adapter = new URL("../dist/bin/openai-compatible-tool-adapter.js", import.meta.url).pathname;

test("run_command succeeds when output exceeds the old 1 MiB capture buffer", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ headers: request.headers, body: JSON.parse(body), url: request.url });
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
                    id: "call-run-command-1mib",
                    type: "function",
                    function: {
                      name: "run_command",
                      arguments: JSON.stringify({ command: "yes x | head -c 1500000" }),
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

  const repo = mkdtempSync(path.join(tmpdir(), "adapter-run-command-buffer-"));
  try {
    const result = await runAdapter(repo, {
      OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
      ADAPTER_TEST_NO_KEY: "",
      OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "1",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 2);
    const toolMessage = requests[1].body.messages.find((message) => message.role === "tool");
    assert.ok(toolMessage, "follow-up request missing tool result");
    const toolResult = JSON.parse(toolMessage.content);
    assert.equal(toolResult.ok, true, JSON.stringify({
      status: toolResult.status,
      signal: toolResult.signal,
      error: toolResult.error,
    }));
    const stdout = String(toolResult.stdout ?? "");
    const prefix = stdout.replace(/\n\.\.\.\[truncated \d+ chars\]$/, "");
    assert.ok(prefix.length <= 200000, `stdout not truncated to COMMAND_OUTPUT_LIMIT: ${stdout.length}`);
  } finally {
    server.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("run_command fails when output exceeds the 16 MiB raw capture floor", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ headers: request.headers, body: JSON.parse(body), url: request.url });
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
                    id: "call-run-command-16mib",
                    type: "function",
                    function: {
                      name: "run_command",
                      arguments: JSON.stringify({ command: "yes x | head -c 17000000" }),
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

  const repo = mkdtempSync(path.join(tmpdir(), "adapter-run-command-cap-"));
  try {
    const result = await runAdapter(repo, {
      OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
      ADAPTER_TEST_NO_KEY: "",
      OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "1",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 2);
    const toolMessage = requests[1].body.messages.find((message) => message.role === "tool");
    assert.ok(toolMessage, "follow-up request missing tool result");
    const toolResult = JSON.parse(toolMessage.content);
    assert.equal(toolResult.ok, false, JSON.stringify({
      status: toolResult.status,
      signal: toolResult.signal,
      error: toolResult.error,
    }));
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
