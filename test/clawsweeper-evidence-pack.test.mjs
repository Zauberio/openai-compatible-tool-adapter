import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  buildClawSweeperEvidencePack,
  buildClawSweeperEvidencePrelude,
} from "../dist/recipes/clawsweeper/evidence-pack.js";

test("builds deterministic ClawSweeper evidence from prepared source PR ref", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "adapter-evidence-"));
  try {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "test@example.invalid"]);
    git(dir, ["config", "user.name", "Test"]);
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "file.ts"), "export const value = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "base"]);
    const base = gitOut(dir, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(dir, "src", "file.ts"), "export const value = 2;\n");
    git(dir, ["commit", "-q", "-am", "source"]);
    const source = gitOut(dir, ["rev-parse", "HEAD"]);
    git(dir, ["update-ref", "refs/remotes/clawsweeper/source-pr-123", source]);
    git(dir, ["checkout", "-q", "-B", "main", base]);

    const prompt = `repo: example/clawsweeper
https://github.com/example/clawsweeper/pull/123
## Repair signals:
- check_failed: format failed in \`src/file.ts\`
`;
    const pack = buildClawSweeperEvidencePack(prompt, dir);
    assert.equal(pack.repo, "example/clawsweeper");
    assert.equal(pack.source_prs[0].number, 123);
    assert.equal(pack.source_prs[0].local_ref, "refs/remotes/clawsweeper/source-pr-123");
    assert.deepEqual(pack.source_prs[0].changed_files, ["src/file.ts"]);
    assert.equal(pack.evidence_gates.source_pr_ref_found, true);
    assert.equal(pack.evidence_gates.source_pr_diff_read, true);
    assert.equal(pack.evidence_gates.actionable_signal_read, true);
    assert.equal(pack.evidence_gates.relevant_hunk_read, true);
    assert.deepEqual(pack.likely_files, ["src/file.ts"]);
    assert.match(pack.source_prs[0].relevant_hunks[0].excerpt, /export const value = 2/);

    const prelude = buildClawSweeperEvidencePrelude(prompt, dir, { enabled: true });
    assert.match(prelude, /Adapter-provided deterministic repair evidence/);
    assert.match(prelude, /"changed_files": \[/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evidence prelude is opt-in", () => {
  const prelude = buildClawSweeperEvidencePrelude("repo: example/clawsweeper", process.cwd());
  assert.equal(prelude, "");
});

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${args.join(" ")} failed: ${result.stderr}`);
}

function gitOut(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}
