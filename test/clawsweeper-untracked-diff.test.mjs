import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const adapter = new URL("../dist/bin/openai-compatible-tool-adapter.js", import.meta.url).pathname;

test("git_diff tool result omits untracked and keeps ?? paths in status", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    requests.push(body);
    if (requests.length === 1) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_git_diff_1",
                    type: "function",
                    function: { name: "git_diff", arguments: "{}" },
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

  const repo = initRepoWithUntracked();
  try {
    const result = await runAdapter(repo, {
      OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
      ADAPTER_TEST_NO_KEY: "",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 2);
    const toolMessage = requests[1].messages.find((message) => message.role === "tool");
    assert.ok(toolMessage, "expected a tool result message on the follow-up turn");
    const payload = JSON.parse(toolMessage.content);
    assert.equal(payload.ok, true);
    assert.equal(Object.hasOwn(payload, "untracked"), false);
    assert.match(String(payload.status), /\?\? untracked\.txt/);
  } finally {
    server.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktreeHasDiff reports an untracked-only worktree as a diff", async () => {
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

  const repo = initRepoWithUntracked();
  try {
    const result = await runAdapter(repo, {
      OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
      OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
      ADAPTER_TEST_NO_KEY: "",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RUNNER_FINAL_DIFF_EXISTS=1/);
  } finally {
    server.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

function initRepoWithUntracked() {
  const repo = mkdtempSync(path.join(tmpdir(), "adapter-untracked-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  writeFileSync(path.join(repo, "untracked.txt"), "new file\n");
  return repo;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${args.join(" ")} failed: ${result.stderr}`);
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
