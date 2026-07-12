import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const adapter = new URL("../dist/bin/openai-compatible-tool-adapter.js", import.meta.url).pathname;

test("CLI fails before provider access when output schema is missing", () => {
  const result = spawnSync(
    process.execPath,
    [adapter, "exec", "--output-schema", "/definitely/missing/adapter-schema.json", "-"],
    { input: "test\n", encoding: "utf8", env: { ...process.env } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /output schema not found/);
});
