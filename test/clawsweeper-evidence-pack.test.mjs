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
    assert.equal(pack.source_prs[0].relevant_hunks[0].read_failed, false);
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

test("missing source PR ref leaves hunks unread and gates false", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "adapter-evidence-missing-"));
  try {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "test@example.invalid"]);
    git(dir, ["config", "user.name", "Test"]);
    writeFileSync(path.join(dir, "README.md"), "ok\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "base"]);

    const prompt = `repo: example/clawsweeper
https://github.com/example/clawsweeper/pull/404
## Repair signals:
- check_failed: format failed in \`src/file.ts\`
`;
    const pack = buildClawSweeperEvidencePack(prompt, dir);
    assert.equal(pack.source_prs[0].number, 404);
    assert.equal(pack.source_prs[0].diff_ref, "");
    assert.deepEqual(pack.source_prs[0].changed_files, []);
    assert.deepEqual(pack.source_prs[0].relevant_hunks, []);
    assert.equal(pack.evidence_gates.source_pr_ref_found, false);
    assert.equal(pack.evidence_gates.source_pr_diff_read, false);
    assert.equal(pack.evidence_gates.actionable_signal_read, true);
    assert.equal(pack.evidence_gates.relevant_hunk_read, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty hunk excerpt from oversized git diff is read_failed and does not pass the gate", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "adapter-evidence-big-"));
  const writes = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (...args) => {
    writes.push(String(args[0]));
    return origWrite(...args);
  };
  try {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "test@example.invalid"]);
    git(dir, ["config", "user.name", "Test"]);
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "keep.ts"), "export const value = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "base"]);
    const base = gitOut(dir, ["rev-parse", "HEAD"]);
    // Unified diffs over 4MB trip gitText's maxBuffer (ENOBUFS, empty excerpt).
    writeFileSync(path.join(dir, "src", "big.txt"), `${"x".repeat(1024)}\n`.repeat(5 * 1024));
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "source"]);
    const source = gitOut(dir, ["rev-parse", "HEAD"]);
    git(dir, ["update-ref", "refs/remotes/clawsweeper/source-pr-99", source]);
    git(dir, ["checkout", "-q", "-B", "main", base]);

    const prompt = `repo: example/clawsweeper
https://github.com/example/clawsweeper/pull/99
## Repair signals:
- check_failed: lint failed in \`src/big.txt\`
`;
    const pack = buildClawSweeperEvidencePack(prompt, dir);
    const hunk = pack.source_prs[0].relevant_hunks.find((entry) => entry.file === "src/big.txt");
    assert.ok(hunk, "expected a relevant hunk for the oversized source file");
    assert.equal(hunk.excerpt, "");
    assert.equal(hunk.read_failed, true);
    assert.deepEqual(pack.source_prs[0].changed_files, ["src/big.txt"]);
    assert.equal(pack.evidence_gates.source_pr_ref_found, true);
    assert.equal(pack.evidence_gates.source_pr_diff_read, true);
    assert.equal(pack.evidence_gates.actionable_signal_read, true);
    assert.equal(pack.evidence_gates.relevant_hunk_read, false);
    assert.match(writes.join(""), /buffer exceeded/);
  } finally {
    process.stderr.write = origWrite;
    rmSync(dir, { recursive: true, force: true });
  }
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
