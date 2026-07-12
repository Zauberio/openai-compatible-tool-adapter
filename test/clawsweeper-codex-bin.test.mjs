import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

const wrapper = new URL("../bin/clawsweeper-codex-adapter.mjs", import.meta.url).pathname;
const removedLegacyWrapper = new URL("../bin/clawsweeper-repair-adapter.mjs", import.meta.url).pathname;
const recipeReadme = new URL("../recipes/clawsweeper-codex-bin/README.md", import.meta.url).pathname;
const recipeEnv = new URL("../recipes/clawsweeper-codex-bin/adapter.example.env", import.meta.url).pathname;
const packageJson = new URL("../package.json", import.meta.url).pathname;

test("ClawSweeper recipe is documented for CODEX_BIN, not MODEL_COMMAND", () => {
  const text = readFileSync(recipeReadme, "utf8");
  assert.match(text, /CODEX_BIN/);
  assert.match(text, /clawsweeper-codex-adapter\.mjs/);
  assert.doesNotMatch(text, /CLAWSWEEPER_MODEL_COMMAND/);
});

test("ClawSweeper example env uses the public CODEX_BIN wrapper", () => {
  const text = readFileSync(recipeEnv, "utf8");
  assert.match(text, /CODEX_BIN=(?:clawsweeper-codex-adapter|.*clawsweeper-codex-adapter\.mjs)/);
  assert.match(text, /CLAWSWEEPER_OPENAI_COMPATIBLE_BASE_URL=https:\/\/api\.example\.com\/v1/);
  assert.doesNotMatch(text, /CLAWSWEEPER_MODEL_COMMAND/);
});

test("package exports only the ClawSweeper CODEX_BIN wrapper", () => {
  const pkg = JSON.parse(readFileSync(packageJson, "utf8"));
  assert.equal(pkg.bin["clawsweeper-codex-adapter"], "bin/clawsweeper-codex-adapter.mjs");
  assert.equal(pkg.bin["clawsweeper-repair-adapter"], undefined);
});

test("legacy ClawSweeper repair wrapper file is removed", () => {
  assert.equal(existsSync(wrapper), true);
  assert.equal(existsSync(removedLegacyWrapper), false);
});

test("ClawSweeper CODEX_BIN wrapper reaches the adapter", () => {
  const result = spawnSync(process.execPath, [wrapper, "exec"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.notEqual(result.status, null);
  assert.notEqual(result.status, 0);
});
