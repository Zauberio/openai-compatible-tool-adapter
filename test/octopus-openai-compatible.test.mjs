import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const wrapper = new URL("../bin/octopus-openai-compatible-adapter.mjs", import.meta.url).pathname;
const recipeReadme = new URL("../recipes/octopus-openai-compatible/README.md", import.meta.url).pathname;
const source = readFileSync(wrapper, "utf8");

test("legacy Octopus wrapper reaches the generic adapter CLI", () => {
  const result = spawnSync(process.execPath, [wrapper, "--help"], {
    cwd: process.cwd(),
    env: { ...process.env },
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

test("legacy wrapper maps Octopus provider variables", () => {
  for (const variable of [
    "BASE_URL",
    "MODEL",
    "API_KEY_ENV",
    "MAX_TURNS",
    "MAX_TOKENS",
    "MAX_RETRIES",
    "ALLOWED_FILES",
  ]) {
    assert.match(
      source,
      new RegExp(`OCTOPUS_OPENAI_COMPATIBLE_${variable}.*OPENAI_COMPATIBLE_ADAPTER_${variable}`),
    );
  }
});

test("legacy wrapper preserves GitHub token aliases", () => {
  assert.match(source, /env\.GH_TOKEN \|\| env\.GITHUB_TOKEN \|\| env\.OCTOPUS_GITHUB_TOKEN/);
  assert.match(source, /env\.GH_TOKEN \|\|=/);
  assert.match(source, /env\.GITHUB_TOKEN \|\|=/);
  assert.match(source, /env\.OCTOPUS_GITHUB_TOKEN \|\|=/);
});

test("Octopus recipe is explicitly marked as legacy", () => {
  const readme = readFileSync(recipeReadme, "utf8");
  assert.match(readme, /Legacy compatibility/i);
  assert.match(readme, /invoke the generic adapter directly/i);
});
