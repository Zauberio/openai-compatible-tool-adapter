import assert from "node:assert/strict";
import test from "node:test";
import { trimMessagesForProvider } from "../dist/core/context-trim.js";

const msg = (role, content, extra = {}) => ({ role, content, ...extra });
const bytes = (m) => Buffer.byteLength(JSON.stringify(m));

test("messages under the budget are returned unchanged", () => {
  const messages = [msg("system", "sys"), msg("user", "hi")];
  const out = trimMessagesForProvider(messages, 1024);
  assert.deepEqual(out, messages);
});

test("zero budget disables trimming", () => {
  const messages = [msg("system", "sys"), msg("user", "hi"), msg("assistant", "x")];
  assert.equal(trimMessagesForProvider(messages, 0).length, 3);
});

test("orphaned tool results are stripped even when under budget", () => {
  const messages = [
    msg("system", "sys"),
    msg("user", "prompt"),
    msg("tool", "orphan-result", { tool_call_id: "call-missing" }),
    msg("assistant", "hello"),
  ];
  const out = trimMessagesForProvider(messages, 1024 * 1024);
  assert.ok(!JSON.stringify(out).includes("orphan-result"));
  assert.equal(out.length, 3);
});

test("oldest complete tool_call/tool_result pairs are dropped, system+user kept", () => {
  const messages = [
    msg("system", "sys"),
    msg("user", "prompt"),
    msg("assistant", null, { tool_calls: [{ id: "call-1" }] }),
    msg("tool", "result-1", { tool_call_id: "call-1" }),
    msg("assistant", "progress"),
    msg("assistant", null, { tool_calls: [{ id: "call-2" }] }),
    msg("tool", "result-2", { tool_call_id: "call-2" }),
    msg("assistant", "final"),
  ];
  const block1Bytes = bytes(messages[2]) + bytes(messages[3]);
  const budget = messages.reduce((a, m) => a + bytes(m), 0) - block1Bytes;
  const out = trimMessagesForProvider(messages, budget);
  const serialized = JSON.stringify(out);
  assert.equal(out[0].role, "system");
  assert.equal(out[1].role, "user");
  assert.ok(!serialized.includes("call-1"), "oldest pair dropped");
  assert.ok(!serialized.includes("result-1"));
  assert.ok(serialized.includes("call-2"), "newest pair kept");
  assert.ok(serialized.includes("final"));
  assert.ok(serialized.includes("progress"));
});

test("textual tool-call results with synthetic ids survive trimming", () => {
  const messages = [
    msg("system", "sys"),
    msg("user", "prompt"),
    msg("assistant", '{"tool_calls":[{"type":"read_file","path":"a.txt"}]}'),
    msg("tool", "file contents", { tool_call_id: "pseudo-123-0" }),
    msg("assistant", "done"),
  ];
  const out = trimMessagesForProvider(messages, 1024 * 1024);
  const serialized = JSON.stringify(out);
  assert.ok(serialized.includes("file contents"), "synthetic result kept");
  assert.ok(serialized.includes("pseudo-123-0"));
  assert.equal(out.length, 5);
});

test("synthetic tool results are kept when real pairs are dropped for budget", () => {
  const messages = [
    msg("system", "sys"),
    msg("user", "prompt"),
    msg("assistant", null, { tool_calls: [{ id: "call-1" }] }),
    msg("tool", "r1", { tool_call_id: "call-1" }),
    msg("assistant", '{"tool_calls":[{"type":"read_file","path":"b.txt"}]}'),
    msg("tool", "r2-pseudo", { tool_call_id: "tool-456-0" }),
    msg("assistant", "final"),
  ];
  const block1Bytes = bytes(messages[2]) + bytes(messages[3]);
  const budget = messages.reduce((a, m) => a + bytes(m), 0) - block1Bytes;
  const out = trimMessagesForProvider(messages, budget);
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes("call-1"), "real pair dropped first");
  assert.ok(!serialized.includes('"r1"'));
  assert.ok(serialized.includes("r2-pseudo"), "synthetic result kept under pressure");
  assert.ok(serialized.includes("final"));
});

test("aggressive budget drops multiple pairs oldest-first", () => {
  const messages = [
    msg("system", "sys"),
    msg("user", "prompt"),
    msg("assistant", null, { tool_calls: [{ id: "call-1" }] }),
    msg("tool", "r1", { tool_call_id: "call-1" }),
    msg("assistant", null, { tool_calls: [{ id: "call-2" }] }),
    msg("tool", "r2", { tool_call_id: "call-2" }),
    msg("assistant", null, { tool_calls: [{ id: "call-3" }] }),
    msg("tool", "r3", { tool_call_id: "call-3" }),
    msg("assistant", "final"),
  ];
  const block1Bytes = bytes(messages[2]) + bytes(messages[3]);
  const block2Bytes = bytes(messages[4]) + bytes(messages[5]);
  const budget = messages.reduce((a, m) => a + bytes(m), 0) - block1Bytes - block2Bytes;
  const out = trimMessagesForProvider(messages, budget);
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes("call-1"));
  assert.ok(!serialized.includes("call-2"));
  assert.ok(serialized.includes("call-3"), "newest pair kept");
  assert.ok(serialized.includes("final"));
});
