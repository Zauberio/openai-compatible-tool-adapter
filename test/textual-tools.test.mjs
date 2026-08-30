import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dsmlToolCalls,
  normalizeToolCalls,
  pseudoToolCalls,
} from "../dist/core/textual-tools.js";

const ALLOWED = ["run_command", "write_file", "search_files"];

const native = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

test("rejects a non-array tool_calls input without crashing", () => {
  // malformed provider responses can carry tool_calls as a string/object/number/boolean
  assert.deepEqual(normalizeToolCalls("nope", ALLOWED), []);
  assert.deepEqual(normalizeToolCalls({}, ALLOWED), []);
  assert.deepEqual(normalizeToolCalls(42, ALLOWED), []);
  assert.deepEqual(normalizeToolCalls(true, ALLOWED), []);
  assert.deepEqual(normalizeToolCalls(null, ALLOWED), []);
});

test("pseudoToolCalls extracts a JSON tool_calls array from content", () => {
  const out = pseudoToolCalls(
    '{"tool_calls":[{"name":"run_command","arguments":{"command":"echo hi"}}]}',
    ALLOWED,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].function.name, "run_command");
  assert.equal(JSON.parse(out[0].function.arguments).command, "echo hi");
});

test("dsmlToolCalls extracts DSML invoke blocks from content", () => {
  const out = dsmlToolCalls(
    'DSML <invoke name="run_command"><parameter name="command">echo hi</parameter></invoke>',
    ALLOWED,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].function.name, "run_command");
  assert.equal(JSON.parse(out[0].function.arguments).command, "echo hi");
});

test("pseudoToolCalls returns [] for non-string or empty content", () => {
  assert.deepEqual(pseudoToolCalls(null, ALLOWED), []);
  assert.deepEqual(pseudoToolCalls(undefined, ALLOWED), []);
  assert.deepEqual(pseudoToolCalls(42, ALLOWED), []);
  assert.deepEqual(pseudoToolCalls({}, ALLOWED), []);
  assert.deepEqual(pseudoToolCalls("", ALLOWED), []);
  assert.deepEqual(pseudoToolCalls("   ", ALLOWED), []);
});

test("normalizes a valid array of calls", () => {
  const out = normalizeToolCalls(
    [{ id: "a", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "echo hi" }) } }],
    ALLOWED,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].function.name, "run_command");
});

test("filters disallowed tools", () => {
  const out = normalizeToolCalls(
    [{ id: "a", type: "function", function: { name: "dangerous_tool", arguments: "{}" } }],
    ALLOWED,
  );
  assert.equal(out.length, 0);
});

test("skips null/undefined holes in tool_calls without crashing", () => {
  const valid = {
    id: "ok",
    type: "function",
    function: { name: "run_command", arguments: JSON.stringify({ command: "true" }) },
  };
  assert.deepEqual(normalizeToolCalls([null], ALLOWED), []);
  assert.deepEqual(normalizeToolCalls([undefined], ALLOWED), []);
  const mixed = normalizeToolCalls([null, valid, undefined, 42, "x"], ALLOWED);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].function.name, "run_command");
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

test("keeps two distinct native calls with identical arguments", () => {
  const calls = [
    native("a", "run_command", { command: "echo hi" }),
    native("b", "run_command", { command: "echo hi" }),
  ];
  const out = normalizeToolCalls(calls, ALLOWED);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "a");
  assert.equal(out[1].id, "b");
});

test("dedupes a pseudo echo whose arguments use a different key order than the native call", () => {
  const calls = [
    native("a", "run_command", { command: "echo hi", timeoutMs: 30 }),
    ...pseudoToolCalls(
      '<｜DSML｜tool_calls><invoke name="run_command"><parameter name="timeoutMs">30</parameter><parameter name="command">echo hi</parameter></invoke></｜DSML｜tool_calls>',
      ALLOWED,
    ),
  ];
  const out = normalizeToolCalls(calls, ALLOWED);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "a");
});
