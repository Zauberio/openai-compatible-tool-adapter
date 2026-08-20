import assert from "node:assert/strict";
import test from "node:test";
import { dsmlToolCalls, normalizeToolCalls } from "../dist/core/textual-tools.js";

const ALLOWED = [
  "read_file",
  "read_file_range",
  "write_file",
  "replace_in_file",
  "run_command",
  "search_files",
  "apply_patch",
  "git_diff",
];

test("DSML boolean parameters are parsed as real booleans", () => {
  const content = `<｜DSML｜tool_calls>
<antml:invoke name="replace_in_file">
<antml:parameter name="path">src/a.ts</antml:parameter>
<antml:parameter name="search">x</antml:parameter>
<antml:parameter name="replacement">y</antml:parameter>
<antml:parameter name="replaceAll">true</antml:parameter>
</antml:invoke>
<｜/DSML｜>`;
  const calls = dsmlToolCalls(content, ALLOWED);
  assert.equal(calls.length, 1);
  const args = JSON.parse(calls[0].function.arguments || "{}");
  assert.equal(args.replaceAll, true);
  assert.equal(typeof args.replaceAll, "boolean");
});

test("DSML numeric and string parameters keep their types", () => {
  const content = `<｜DSML｜tool_calls>
<antml:invoke name="search_files">
<antml:parameter name="pattern">foo</antml:parameter>
<antml:parameter name="maxResults">25</antml:parameter>
</antml:invoke>
<｜/DSML｜>`;
  const calls = dsmlToolCalls(content, ALLOWED);
  assert.equal(calls.length, 1);
  const args = JSON.parse(calls[0].function.arguments || "{}");
  assert.equal(args.maxResults, 25);
  assert.equal(typeof args.maxResults, "number");
  assert.equal(args.pattern, "foo");
});

test("DSML string parameters preserve boolean-looking literals", () => {
  const content = `<｜DSML｜tool_calls>
<antml:invoke name="search_files">
<antml:parameter name="pattern">true</antml:parameter>
<antml:parameter name="path">false</antml:parameter>
</antml:invoke>
<｜/DSML｜>`;
  const calls = dsmlToolCalls(content, ALLOWED);
  assert.equal(calls.length, 1);
  const args = JSON.parse(calls[0].function.arguments || "{}");
  assert.equal(args.pattern, "true");
  assert.equal(typeof args.pattern, "string");
  assert.equal(args.path, "false");
  assert.equal(typeof args.path, "string");
});

test("normalizeToolCalls preserves native boolean replaceAll", () => {
  const calls = normalizeToolCalls(
    [
      {
        id: "call-1",
        function: {
          name: "replace_in_file",
          arguments: JSON.stringify({ path: "a", search: "x", replacement: "y", replaceAll: false }),
        },
      },
    ],
    ALLOWED,
  );
  const args = JSON.parse(calls[0].function.arguments || "{}");
  assert.equal(args.replaceAll, false);
  assert.equal(typeof args.replaceAll, "boolean");
});
