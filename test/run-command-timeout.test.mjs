import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const adapter = new URL("../dist/bin/openai-compatible-tool-adapter.js", import.meta.url).pathname;

test("run_command timeout releases the child and pipes so the process can exit", async () => {
  const toolCall = {
    id: "call_1",
    type: "function",
    function: {
      name: "run_command",
      arguments: JSON.stringify({
        command: 'setsid bash -c "sleep 600" & sleep 600',
        timeoutMs: 2000,
      }),
    },
  };
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const parsed = JSON.parse(body);
    if (!parsed.messages?.some((m) => m.role === "tool")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [toolCall] } }] }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }));
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const repo = mkdtempSync(path.join(tmpdir(), "adapter-runcommand-"));
  try {
    const child = spawn(process.execPath, [adapter, "exec", "--cd", repo, "--json", "-"], {
      cwd: repo,
      env: {
        ...process.env,
        OPENAI_COMPATIBLE_ADAPTER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_COMPATIBLE_ADAPTER_MODEL: "test/model",
        OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL: "1",
        OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV: "ADAPTER_TEST_NO_KEY",
        ADAPTER_TEST_NO_KEY: "",
        OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES: "1",
        OPENAI_COMPATIBLE_ADAPTER_COMMAND_TIMEOUT_MS: "3000",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.stdin.end("Run the command and finish.\n");
    const [status, signal] = await once(child, "close");
    assert.equal(signal, null, `process must exit normally, not be signalled: ${stderr}`);
    assert.equal(status, 0, `adapter must exit 0, got ${status}; stderr=${stderr}`);
    assert.match(stdout, /timedOut.*?true/s, `expected timedOut true in output: ${stdout}`);
  } finally {
    server.close();
    killSleep600();
    rmSync(repo, { recursive: true, force: true });
  }
});

// Kill the setsid'd grandchild that escapes the adapter's process group.
function killSleep600() {
  let raw = "";
  try {
    raw = execFileSync(
      "bash",
      ["-c", 'for p in $(pgrep -x sleep); do a=$(tr "\\0" " " < /proc/$p/cmdline 2>/dev/null); [ "$a" = "sleep 600 " ] && echo $p; done'],
      { encoding: "utf8" },
    );
  } catch {
    return;
  }
  for (const p of raw.trim().split(/\s+/).filter(Boolean)) {
    try {
      process.kill(Number(p), "SIGKILL");
    } catch {}
  }
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
