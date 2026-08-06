import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeToolCalls, pseudoToolCalls } from "../dist/core/textual-tools.js";

const ALLOWED = ["run_command", "write_file", "search_files"];

const native = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

test("dedupes a native call against an identical DSML invoke, keeping the native id", () => {
  const calls = [
    native("call_native_1", "run_command", { command: "echo hi" }),
    ...pseudoToolCalls(
      '<｜DSML｜tool_calls><invoke name="run_command"><parameter name="command">echo hi</parameter></invoke></｜DSML｜tool_calls>',
      ALLOWED,
    ),
  ];
  const out = normalizeToolCalls(calls, ALLOWED);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "call_native_1");
});

test("keeps two DIFFERENT commands as separate calls", () => {
  const calls = [
    native("a", "run_command", { command: "echo one" }),
    native("b", "run_command", { command: "echo two" }),
  ];
  const out = normalizeToolCalls(calls, ALLOWED);
  assert.equal(out.length, 2);
});

test("dedupes two identical pseudo entries", () => {
  const pseudo = pseudoToolCalls(
    '<｜DSML｜tool_calls><invoke name="write_file"><parameter name="path">a.txt</parameter><parameter name="content">x</parameter></invoke><invoke name="write_file"><parameter name="path">a.txt</parameter><parameter name="content">x</parameter></invoke></｜DSML｜tool_calls>',
    ALLOWED,
  );
  const out = normalizeToolCalls(pseudo, ALLOWED);
  assert.equal(out.length, 1);
});

test("dedupes across key-order variants (arguments are re-serialized deterministically)", () => {
  const calls = [
    native("a", "run_command", { command: "echo hi", timeoutMs: 30 }),
    native("b", "run_command", { timeoutMs: 30, command: "echo hi" }),
  ];
  const out = normalizeToolCalls(calls, ALLOWED);
  assert.equal(out.length, 1);
});
