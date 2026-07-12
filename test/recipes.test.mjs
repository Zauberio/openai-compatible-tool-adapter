import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRecipe } from "../dist/recipes/index.js";

const options = { env: {} };

test("generic is the default recipe and contains no ClawSweeper policy", () => {
  const recipe = loadRecipe("generic", options);
  assert.equal(recipe.name, "generic");
  const instructions = recipe.systemInstructions({
    rawPrompt: "task",
    cwd: process.cwd(),
    outputSchema: "",
    allowedFiles: [],
    toolsExecuted: 0,
    diffExists: false,
    observedEvidence: [],
    messages: [],
  });
  assert.match(instructions.join("\n"), /implementation agent/);
  assert.doesNotMatch(instructions.join("\n"), /ClawSweeper|pr-repair/);
});

test("ClawSweeper policy is loaded only by explicit recipe name", () => {
  const recipe = loadRecipe("clawsweeper", options);
  assert.equal(recipe.name, "clawsweeper");
  assert.match(
    recipe.systemInstructions({
      rawPrompt: "task",
      cwd: process.cwd(),
      outputSchema: "",
      allowedFiles: [],
      toolsExecuted: 0,
      diffExists: false,
      observedEvidence: [],
      messages: [],
    }).join("\n"),
    /ClawSweeper/,
  );
});

test("unknown recipes fail closed", () => {
  assert.throws(() => loadRecipe("unknown-host", options), /unknown adapter recipe/);
});
