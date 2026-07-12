import { spawnSync } from "node:child_process";

export type ClawSweeperEvidencePack = {
  repo: string;
  source_prs: EvidenceSourcePullRequest[];
  repair_signals: EvidenceRepairSignal[];
  evidence_gates: {
    source_pr_ref_found: boolean;
    source_pr_diff_read: boolean;
    actionable_signal_read: boolean;
    relevant_hunk_read: boolean;
  };
  likely_files: string[];
  validation_hints: string[];
  operator_notes: string[];
};

type EvidenceSourcePullRequest = {
  number: number;
  url: string;
  local_ref: string;
  base_ref: string;
  diff_ref: string;
  changed_files: string[];
  diff_stat: string;
  relevant_hunks: EvidenceHunk[];
};

type EvidenceRepairSignal = {
  kind: string;
  text: string;
  mentioned_files: string[];
};

type EvidenceHunk = {
  file: string;
  reason: string;
  excerpt: string;
};

type EvidenceOptions = {
  enabled?: boolean;
  maxHunks?: number;
  maxHunkBytes?: number;
};

export function buildClawSweeperEvidencePrelude(
  prompt: string,
  targetDir: string,
  options: EvidenceOptions = {},
): string {
  if (!options.enabled) return "";
  const pack = buildClawSweeperEvidencePack(prompt, targetDir, options);
  if (pack.source_prs.length === 0 && pack.repair_signals.length === 0) return "";
  return [
    "## Adapter-provided deterministic repair evidence",
    "",
    "This JSON block was generated locally from the prepared checkout and prompt. It is evidence, not a model conclusion. Use it to inspect the source PR diff and objective repair signals before returning a final ClawSweeper result.",
    "",
    "```json",
    JSON.stringify(pack, null, 2),
    "```",
  ].join("\n");
}

export function buildClawSweeperEvidencePack(
  prompt: string,
  targetDir: string,
  options: EvidenceOptions = {},
): ClawSweeperEvidencePack {
  const repo = repoFromPrompt(prompt);
  const signals = extractRepairSignals(prompt);
  const signalFiles = unique(signals.flatMap((signal) => signal.mentioned_files));
  const baseRef = targetBaseRef(targetDir);
  const maxHunks = Math.max(0, Math.min(Math.floor(options.maxHunks ?? 6), 20));
  const maxHunkBytes = Math.max(500, Math.min(Math.floor(options.maxHunkBytes ?? 12000), 50000));
  const sourcePrs = sourcePullRequests(prompt, repo).map(({ number, url }) => {
    const localRef = sourcePullRequestRemoteRef(number);
    const refFound = gitRefExists(targetDir, localRef);
    const diffRef = refFound
      ? hasMergeBase(targetDir, baseRef, localRef)
        ? `${baseRef}...${localRef}`
        : `${baseRef}..${localRef}`
      : "";
    const changedFiles = diffRef ? gitLines(targetDir, ["diff", "--name-only", diffRef]) : [];
    const relevantFiles = selectRelevantFiles(changedFiles, signalFiles);
    return {
      number,
      url,
      local_ref: localRef,
      base_ref: baseRef,
      diff_ref: diffRef,
      changed_files: changedFiles,
      diff_stat: diffRef ? gitText(targetDir, ["diff", "--stat", diffRef]) : "",
      relevant_hunks: relevantFiles.slice(0, maxHunks).map((file) => ({
        file,
        reason: signalFiles.includes(file) ? "mentioned_by_repair_signal_and_changed" : "changed_in_source_pr",
        excerpt: truncate(gitText(targetDir, ["diff", "--unified=60", diffRef, "--", file]), maxHunkBytes),
      })),
    };
  });
  const changedFiles = unique(sourcePrs.flatMap((pr) => pr.changed_files));
  const likelyFiles = selectRelevantFiles(changedFiles, signalFiles);
  return {
    repo,
    source_prs: sourcePrs,
    repair_signals: signals,
    evidence_gates: {
      source_pr_ref_found: sourcePrs.some((pr) => gitRefExists(targetDir, pr.local_ref)),
      source_pr_diff_read: sourcePrs.some((pr) => pr.changed_files.length > 0),
      actionable_signal_read: signals.length > 0,
      relevant_hunk_read: sourcePrs.some((pr) => pr.relevant_hunks.length > 0),
    },
    likely_files: likelyFiles,
    validation_hints: validationHints(likelyFiles),
    operator_notes: [
      "Evidence pack is deterministic and generic; it is not a model conclusion.",
      "Base repair-only decisions on source PR diffs, objective repair signals and relevant hunks before finalizing.",
      "If evidence_gates show missing refs or diffs, use available tools to inspect or return a schema-valid needs_human blocker.",
    ],
  };
}

export function extractRepairSignals(body: string): EvidenceRepairSignal[] {
  const lines = body.split(/\r?\n/);
  const out: EvidenceRepairSignal[] = [];
  let inSignals = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(?:##\s+)?Repair signals:?$/i.test(trimmed)) {
      inSignals = true;
      continue;
    }
    if (inSignals && (/^##\s+/.test(trimmed) || /^[A-Z][A-Za-z ]+:$/.test(trimmed))) break;
    if (!inSignals) continue;
    const match = line.match(/^\s*-\s+([^:]+):\s*(.+)$/);
    if (!match) continue;
    const text = (match[2] ?? "").trim();
    out.push({
      kind: (match[1] ?? "repair_signal").trim(),
      text,
      mentioned_files: mentionedFiles(text),
    });
  }
  if (out.length > 0) return out;
  return fallbackRepairSignals(body);
}

function fallbackRepairSignals(body: string): EvidenceRepairSignal[] {
  const out: EvidenceRepairSignal[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-") || !/(check_failed|comment_actionable|requires_human|review|failed|format|lint|test)/i.test(trimmed)) continue;
    const text = trimmed.replace(/^[-*]\s*/, "");
    out.push({ kind: "prompt_signal", text, mentioned_files: mentionedFiles(text) });
  }
  return out.slice(0, 12);
}

function sourcePullRequests(prompt: string, repo: string): { number: number; url: string }[] {
  const refs = new Map<number, string>();
  const prUrl = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g;
  for (const match of prompt.matchAll(prUrl)) {
    const foundRepo = match[1] ?? "";
    const number = Number(match[2]);
    if (!number) continue;
    if (!repo || foundRepo.toLowerCase() === repo.toLowerCase()) refs.set(number, `https://github.com/${foundRepo}/pull/${number}`);
  }
  if (repo) {
    for (const match of prompt.matchAll(/(?:source_prs?|canonical|candidates?)\s*[:=][^\n#]*(?:#|pull\/?)(\d+)/gi)) {
      const number = Number(match[1]);
      if (number && !refs.has(number)) refs.set(number, `https://github.com/${repo}/pull/${number}`);
    }
  }
  return [...refs].map(([number, url]) => ({ number, url }));
}

function repoFromPrompt(prompt: string): string {
  const direct = prompt.match(/^\s*repo\s*:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*$/im)?.[1];
  if (direct) return direct;
  return prompt.match(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/\d+/)?.[1] ?? "";
}

function sourcePullRequestRemoteRef(number: number): string {
  return `refs/remotes/clawsweeper/source-pr-${number}`;
}

function mentionedFiles(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/`@?([^`]+)`/g)) addFileMentions(out, match[1] ?? "");
  for (const match of text.matchAll(/@?([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.@-]+)+)/g)) addFileMentions(out, match[1] ?? "");
  return unique(out);
}

function addFileMentions(out: string[], value: string): void {
  for (const part of value.split(/[\s,]+/)) {
    const cleaned = part.trim().replace(/^@/, "").replace(/^\/+/, "").replace(/[).:,;]+$/, "");
    if (!cleaned || cleaned.includes("http") || cleaned.startsWith("github.com/") || cleaned.startsWith("www.")) continue;
    if (!cleaned.includes("/")) continue;
    if (/^[A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@-]+$/.test(cleaned) && !cleaned.includes(".")) continue;
    out.push(cleaned);
  }
}

function selectRelevantFiles(changedFiles: string[], signalFiles: string[]): string[] {
  const exact = changedFiles.filter((file) => signalFiles.includes(file));
  const parentMatches = changedFiles.filter((file) =>
    signalFiles.some((signalFile) =>
      file.startsWith(`${signalFile.replace(/\/$/, "")}/`) || signalFile.startsWith(`${file.replace(/\/$/, "")}/`),
    ),
  );
  return unique([...exact, ...parentMatches, ...changedFiles]).slice(0, 12);
}

function validationHints(files: string[]): string[] {
  const hints = new Set<string>();
  if (files.some((file) => file.endsWith(".sh"))) hints.add("bash -n <changed shell scripts>");
  if (files.some((file) => /\.(ts|tsx|js|jsx)$/.test(file))) hints.add("run the narrowest package test/lint command for changed JS/TS files");
  if (files.some((file) => file.startsWith("test/") || file.includes("/test") || file.includes("tests/"))) hints.add("run the touched or nearest tests when available");
  if (hints.size === 0 && files.length > 0) hints.add("run the narrowest repo-native validation for the touched files");
  return [...hints];
}

function targetBaseRef(targetDir: string): string {
  const ref = gitText(targetDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim();
  if (ref) return ref;
  return gitStatus(targetDir, ["rev-parse", "--verify", "HEAD"]) === 0 ? "HEAD" : "";
}

function hasMergeBase(targetDir: string, baseRef: string, localRef: string): boolean {
  if (!baseRef) return false;
  return gitStatus(targetDir, ["merge-base", baseRef, localRef]) === 0;
}

function gitRefExists(targetDir: string, ref: string): boolean {
  return gitStatus(targetDir, ["rev-parse", "--verify", ref]) === 0;
}

function gitLines(targetDir: string, args: string[]): string[] {
  return gitText(targetDir, args)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function gitText(targetDir: string, args: string[]): string {
  const result = spawnSync("git", ["-C", targetDir, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 * 4 });
  return result.status === 0 ? result.stdout : "";
}

function gitStatus(targetDir: string, args: string[]): number | null {
  const result = spawnSync("git", ["-C", targetDir, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  return result.status ?? null;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]` : value;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
