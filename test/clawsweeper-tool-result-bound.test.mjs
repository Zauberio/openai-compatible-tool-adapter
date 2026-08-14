import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const adapter = new URL("../dist/bin/openai-compatible-tool-adapter.js", import.meta.url).pathname;
const TOOL_RESULT_PREFIX = "tool_result: ";
const TOOL_RESULT_JSON_LIMIT = 2000;

test("search_files with blank maxResults returns the default number of matches", async () => {
  const matchCount = 5;
  const server = createToolServer([
    {
      id: "call_blank_max",
      name: "search_files",
      arguments: { pattern: "MATCHABLE", maxResults: "" },
    },
  ]);
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const repo = mkdtempSync(path.join(tmpdir(), "adapter-blank-max-"));
  try {
    writeFileSync(
      path.join(repo, "notes.txt"),
      Array.from({ length: matchCount }, (_, i) => `MATCHABLE line ${i + 1}`).join("\n") + "\n",
    );

    const result = await runAdapter(repo, address.port);
    assert.equal(result.status, 0, result.stderr);

    const payloads = toolResultPayloads(result.stdout);
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].ok, true);
    assert.ok(
      Array.isArray(payloads[0].matches) && payloads[0].matches.length > 1,
      `expected default maxResults (50) to return more than 1 match, got ${payloads[0].matches?.length}`,
    );
    assert.equal(payloads[0].matches.length, matchCount);
  } finally {
    server.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("tool_result lines stay within 2000 JSON chars and remain valid JSON", async () => {
  const server = createToolServer([
    {
      id: "call_huge_stdout",
      name: "run_command",
      arguments: { command: "cat big.txt" },
    },
  ]);
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const repo = mkdtempSync(path.join(tmpdir(), "adapter-bound-result-"));
  try {
    writeFileSync(path.join(repo, "big.txt"), `${"Q".repeat(60000)}\n`);

    const result = await runAdapter(repo, address.port);
    assert.equal(result.status, 0, result.stderr);

    const lines = result.stdout.split(/\n/).filter((line) => line.startsWith(TOOL_RESULT_PREFIX));
    assert.ok(lines.length >= 1, "expected a tool_result line");
    for (const line of lines) {
      assert.ok(
        line.length <= TOOL_RESULT_JSON_LIMIT + TOOL_RESULT_PREFIX.length,
        `tool_result line exceeded bound: ${line.length}`,
      );
      const json = line.slice(TOOL_RESULT_PREFIX.length);
      assert.doesNotMatch(json, /[\r\n]/);
      const parsed = JSON.parse(json);
      assert.equal(typeof parsed, "object");
      assert.ok(parsed);
    }
  } finally {
    server.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

function createToolServer(calls) {
  let turn = 0;
  return createServer(async (request, response) => {
    await readBody(request);
    turn += 1;
    if (turn === 1) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                })),
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
}

function toolResultPayloads(stdout) {
  return stdout
    .split(/\n/)
    .filter((line) => line.startsWith(TOOL_RESULT_PREFIX))
    .map((line) => {
      const json = line.slice(TOOL_RESULT_PREFIX.length);
      return JSON.parse(json);
    });
}

async function runAdapter(cwd, port) {
  const child = spawn(process.execPath, [adapter, "exec", "--cd", cwd, "--json", "-"], {
    cwd,
    env: {
      ...process.env,
      OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${port}/v1`,
      OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
      ADAPTER_TEST_NO_KEY: "",
      OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "1",
    },
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
