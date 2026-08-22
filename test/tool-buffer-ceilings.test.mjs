import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const adapter = new URL("../dist/bin/openai-compatible-tool-adapter.js", import.meta.url).pathname;

test("search_files treats ENOBUFS with partial matches as truncated success", async () => {
  let toolResultContent = "";
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    if (body.messages.some((m) => m.role === "tool")) {
      // Second call: the adapter reports the executed tool result.
      const tool = body.messages.filter((m) => m.role === "tool").at(-1);
      toolResultContent = String(tool?.content ?? "");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }));
      return;
    }
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
                  id: "t1",
                  type: "function",
                  function: {
                    name: "search_files",
                    arguments: JSON.stringify({ pattern: "X", path: ".", maxResults: 200 }),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const repo = mkdtempSync(path.join(tmpdir(), "adapter-enobufs-"));
  try {
    // One match line larger than the 16 MiB raw capture cap forces ENOBUFS.
    writeFileSync(path.join(repo, "big.txt"), "X".repeat(17 * 1024 * 1024) + "\n");
    const result = await runAdapter(repo, {
      OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
      ADAPTER_TEST_NO_KEY: "",
      OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "1",
    });
    assert.equal(result.status, 0, result.stderr);
    const toolResult = JSON.parse(toolResultContent);
    // The partial match list must be a truncated success, not a failure.
    assert.equal(toolResult.ok, true, toolResultContent.slice(0, 2000));
    assert.equal(toolResult.truncated, true, toolResultContent.slice(0, 2000));
    assert.ok(toolResult.matches.length >= 1, toolResultContent.slice(0, 2000));
  } finally {
    server.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("git_diff captures diffs beyond the old 2 MiB raw cap", async () => {
  let toolResultContent = "";
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    if (body.messages.some((m) => m.role === "tool")) {
      const tool = body.messages.filter((m) => m.role === "tool").at(-1);
      toolResultContent = String(tool?.content ?? "");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "t1", type: "function", function: { name: "git_diff", arguments: "{}" } },
              ],
            },
          },
        ],
      }),
    );
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const repo = mkdtempSync(path.join(tmpdir(), "adapter-bigdiff-"));
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.invalid"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(path.join(repo, "big.txt"), "old\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "base"]);
    // ~3 MiB of new content: larger than the old 2 MiB raw cap, under the new one.
    writeFileSync(path.join(repo, "big.txt"), "Y".repeat(3 * 1024 * 1024) + "\n");

    const result = await runAdapter(repo, {
      OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
      ADAPTER_TEST_NO_KEY: "",
      OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "1",
      // Let the returned diff pass through untruncated so the assertion
      // proves the raw capture was complete, not the truncation limit.
      OPENAI_COMPATIBLE_ADAPTER_DIFF_OUTPUT_LIMIT: String(8 * 1024 * 1024),
    });
    assert.equal(result.status, 0, result.stderr);
    const toolResult = JSON.parse(toolResultContent);
    assert.equal(toolResult.ok, true, toolResultContent.slice(0, 2000));
    assert.ok(
      toolResult.diff.length > 2 * 1024 * 1024,
      `diff truncated below old raw cap: ${toolResult.diff.length} bytes`,
    );
    // The capture must be complete: the added line (which starts with the
    // "+" hunk marker, then a 3 MiB run of Ys, then its terminating newline)
    // reaches the end of the diff with nothing clipped off the tail.
    assert.ok(toolResult.diff.includes("+" + "Y".repeat(64)), "diff added line missing");
    assert.ok(toolResult.diff.endsWith("Y".repeat(1024) + "\n"), "diff tail missing");
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

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${args.join(" ")} failed: ${result.stderr}`);
}
