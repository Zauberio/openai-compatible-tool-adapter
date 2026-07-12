import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCodexResult, normalizeCodexReview } from "../dist/recipes/clawsweeper/normalize-result.js";

const prompt = `repo: example/clawsweeper
cluster_id: repair-pr-example-clawsweeper-307
mode: autonomous
https://github.com/example/clawsweeper/pull/307
- check_failed: pnpm check failed because format:check reported oxfmt violations in pr-repair-intake.ts
`;

test("normalizer keeps a concrete fix_artifact with validation as planned", () => {
  const result = JSON.parse(
    normalizeCodexResult(
      JSON.stringify({
        status: "planned",
        summary: "Applied oxfmt formatting to pr-repair-intake.ts for format:check.",
        needs_human: [],
        fix_artifact: {
          summary: "Applied oxfmt formatting to src/repair/pr-repair-intake.ts to fix format:check.",
          likely_files: ["src/repair/pr-repair-intake.ts"],
          validation_commands: [
            "corepack pnpm run format:check",
            "npx oxlint src/repair --tsconfig tsconfig.repair.json --deny-warnings",
            "npx tsgo -p tsconfig.repair.json",
          ],
          repair_strategy: "repair_contributor_branch",
          source_prs: ["https://github.com/example/clawsweeper/pull/307"],
          pr_title: "chore: format pr repair intake",
          pr_body: "Fix oxfmt format:check failure in pr-repair-intake.ts.",
        },
      }),
      prompt,
      true,
    ),
  );
  assert.equal(result.status, "planned");
  assert.deepEqual(result.needs_human, []);
  assert.equal(result.fix_artifact?.likely_files?.[0], "src/repair/pr-repair-intake.ts");
  assert.deepEqual(result.fix_artifact?.validation_commands, [
    "pnpm run format:check",
    "pnpm exec oxlint src/repair --tsconfig tsconfig.repair.json --deny-warnings",
    "pnpm exec tsgo -p tsconfig.repair.json",
  ]);
});

test("normalizer accepts build_fix_artifact alias", () => {
  const result = JSON.parse(
    normalizeCodexResult(
      JSON.stringify({
        result: "fix_needed",
        repair_strategy: "repair_contributor_branch",
        source_prs: ["https://github.com/example/clawsweeper/pull/307"],
        build_fix_artifact: {
          summary: "Fix format:check by applying oxfmt to pr-repair-intake.ts.",
          likely_files: ["src/repair/pr-repair-intake.ts"],
          validation_commands: [
            "corepack pnpm run format:check",
            "npx oxlint src/repair --tsconfig tsconfig.repair.json --deny-warnings",
            "npx tsgo -p tsconfig.repair.json",
          ],
          pr_title: "chore: format pr repair intake",
          pr_body: "Fix oxfmt format:check failure in pr-repair-intake.ts.",
        },
      }),
      prompt,
      true,
    ),
  );
  assert.equal(result.status, "planned");
  assert.equal(result.fix_artifact?.repair_strategy, "repair_contributor_branch");
  assert.deepEqual(result.needs_human, []);
});

test("normalizer attaches observed adapter evidence to repair actions", () => {
  const result = JSON.parse(
    normalizeCodexResult(
      JSON.stringify({
        fix_needed: true,
        summary: "Fix format check",
        fix_artifact: {
          summary: "Apply oxfmt to pr-repair-intake.ts.",
          likely_files: ["src/repair/pr-repair-intake.ts"],
          validation_commands: ["pnpm run format:check"],
          pr_title: "chore: format pr repair intake",
          pr_body: "Fix oxfmt format:check failure in pr-repair-intake.ts."
        }
      }),
      prompt,
      true,
      ["read_file_range inspected src/repair/pr-repair-intake.ts:1-80", "run_command status=0"]
    )
  );
  assert.equal(result.status, "planned");
  assert.deepEqual(result.actions[0].evidence, [
    "read_file_range inspected src/repair/pr-repair-intake.ts:1-80",
    "run_command status=0"
  ]);
  assert.equal(result.fix_artifact.evidence_observed, undefined);
});


test("normalizer converts loose review output", () => {
  const result = JSON.parse(
    normalizeCodexReview(
      JSON.stringify({
        verdict: "not_merge_ready",
        reason: "Validation failed",
        blockers: [{ title: "format check failed", detail: "pnpm format:check exited 1" }],
        validation: { command: "pnpm format:check", status: 1 },
      }),
    ),
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.summary, "Validation failed");
  assert.equal(result.findings_addressed, false);
  assert.equal(result.findings[0].severity, "medium");
  assert.equal(result.findings[0].summary, "format check failed");
  assert.deepEqual(result.evidence, ['command: "pnpm format:check"', "status: 1"]);
});

test("normalizer converts mergeable review output", () => {
  const result = JSON.parse(
    normalizeCodexReview(
      JSON.stringify({ mergeable: true, summary: "No blockers found", checks: ["pnpm check passed"] }),
    ),
  );
  assert.equal(result.status, "passed");
  assert.equal(result.findings_addressed, true);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.evidence, ["pnpm check passed"]);
});
