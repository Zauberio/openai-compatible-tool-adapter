import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeToolCalls } from "../dist/core/textual-tools.js";

const ALLOWED = ["run_command", "write_file", "search_files"];

test("rejects a non-array tool_calls input without crashing", () => {
  // malformed provider responses can carry tool_calls as a string/object/number/boolean
  assert.deepEqual(normalizeToolCalls("nope", ALLOWED), []);
  assert.deepEqual(normalizeToolCalls({}, ALLOWED), []);
  assert.deepEqual(normalizeToolCalls(42, ALLOWED), []);
  assert.deepEqual(normalizeToolCalls(true, ALLOWED), []);
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
