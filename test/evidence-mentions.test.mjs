import assert from "node:assert/strict";
import test from "node:test";
import { extractRepairSignals } from "../dist/recipes/clawsweeper/evidence-pack.js";

test("date-like tokens are not treated as mentioned files", () => {
  const signals = extractRepairSignals(`## Repair signals
- check_failed: CI failed on 12/03/2026 at 14:30; see src/app.ts for the fix
`);
  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0].mentioned_files, ["src/app.ts"]);
});

test("real multi-segment paths are still extracted", () => {
  const signals = extractRepairSignals(`## Repair signals
- review_actionable: fix src/lib/helpers.ts and build/reports/summary.json
`);
  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0].mentioned_files, ["src/lib/helpers.ts", "build/reports/summary.json"]);
});

test("mixed numeric segments that are real paths survive", () => {
  const signals = extractRepairSignals(`## Repair signals
- check_failed: release artifact missing at dist/2026/notes.txt
`);
  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0].mentioned_files, ["dist/2026/notes.txt"]);
});
