import {
  buildFinalizationPrompt,
  isPrematureNeedsHuman,
  looksLikeCodexResultCandidate,
  normalizeCodexResult,
  normalizeCodexReview,
} from "./normalize-result.js";
import { buildClawSweeperEvidencePrelude } from "./evidence-pack.js";
import type { AdapterRecipe, RecipeLoadOptions } from "../types.js";

export function createClawSweeperRecipe(options: RecipeLoadOptions): AdapterRecipe {
  const evidencePackEnabled = truthyEnv(
    options.env.OPENAI_COMPATIBLE_ADAPTER_CLAWSWEEPER_EVIDENCE_PACK,
  );
  const evidencePackMaxHunks = positiveNumberEnv(
    options.env.OPENAI_COMPATIBLE_ADAPTER_EVIDENCE_PACK_MAX_HUNKS,
    6,
  );
  const evidencePackMaxHunkBytes = positiveNumberEnv(
    options.env.OPENAI_COMPATIBLE_ADAPTER_EVIDENCE_PACK_MAX_HUNK_BYTES,
    12000,
  );
  return {
    name: "clawsweeper",
    preparePrompt(rawPrompt, cwd) {
      const compactPrompt = compactRepairOnlyPrompt(rawPrompt);
      const evidencePrelude = buildClawSweeperEvidencePrelude(rawPrompt, cwd, {
        enabled: evidencePackEnabled,
        maxHunks: evidencePackMaxHunks,
        maxHunkBytes: evidencePackMaxHunkBytes,
      });
      if (evidencePrelude) {
        process.stderr.write(
          "[openai-compatible-tools] clawsweeper_evidence_pack=attached\n",
        );
      }
      return evidencePrelude ? `${evidencePrelude}\n\n${compactPrompt}` : compactPrompt;
    },
    systemInstructions() {
      return [
        "You are emulating `codex exec` for ClawSweeper.",
        "Follow the stdin prompt exactly; do not invent a different workflow or role.",
        "The target checkout, branch, and sandbox have already been prepared by ClawSweeper.",
        "When the repair prompt asks for repository inspection with rg/sed/git, use the available tools: search_files, read_file_range, run_command, and git_diff.",
        "If the repair prompt names a pull request or source_pr URL and read-only gh is available, inspect PR comments, reviews, review threads, and check status with gh before deciding what to edit.",
        "Make the narrowest concrete edit that satisfies the fix artifact.",
        "Prefer replace_in_file for localized edits. Use write_file only for intended whole-file replacement.",
        "Do not push, open PRs, comment, label, merge, or inspect secrets.",
        "Before returning, ensure git_diff reflects the intended change and summarize the validation you ran.",
        "Use tools to inspect and edit files. Do not pretend to use tools.",
        "Repair-only mode: the prompt already identifies the PR and concrete repair signals. Do not perform a broad repository audit.",
        "Inspect only the source PR/comment/check evidence and the smallest relevant file ranges needed to fix that signal.",
        "After a concrete issue is verified, edit immediately, run narrow validation, then stop and return the required JSON.",
        "If you cannot verify and edit within a small number of tool calls, return a schema-valid blocked/needs_human result instead of continuing exploration.",
        "For pr-repair-intake jobs, do not emit keep_canonical/merge/close verdicts. The deterministic intake already found a current repair signal.",
        "For pr-repair-intake jobs, emit fix_needed plus build_fix_artifact when repair is possible; otherwise emit needs_human with exact blocker evidence.",
      ];
    },
    normalizeCandidate(content, context) {
      if (context.outputSchema.endsWith("codex-review.schema.json")) {
        return { content: normalizeCodexReview(content) };
      }
      if (
        context.outputSchema.endsWith("codex-result.schema.json") &&
        looksLikeCodexResultCandidate(content)
      ) {
        const normalized = normalizeCodexResult(
          content,
          context.rawPrompt,
          context.diffExists,
          context.observedEvidence,
        );
        const retryPrompt = isPrematureNeedsHuman(
          normalized,
          context.rawPrompt,
          context.toolsExecuted,
        )
          ? [
              "Do not return needs_human before inspecting the prepared source PR ref.",
              "The prompt includes Source PR refs. Use run_command/read_file_range/git diff/git show to inspect them now.",
              "Only return needs_human after tool evidence proves an exact blocker.",
            ].join("\n")
          : undefined;
        return { content: normalized, retryPrompt };
      }
      return null;
    },
    normalizeFinal(content, context) {
      if (context.outputSchema.endsWith("codex-review.schema.json")) {
        return normalizeCodexReview(content);
      }
      if (context.outputSchema.endsWith("codex-result.schema.json")) {
        process.stderr.write(
          "[openai-compatible-tools] codex_result_normalization=normalize_candidate\n",
        );
        return normalizeCodexResult(
          content,
          context.rawPrompt,
          context.diffExists,
          context.observedEvidence,
        );
      }
      return content;
    },
    buildExhaustionFinalization(context) {
      if (
        !context.outputSchema.endsWith("codex-result.schema.json") ||
        context.toolsExecuted === 0
      ) {
        return null;
      }
      return [
        {
          role: "system",
          content: [
            "You are producing the final ClawSweeper repair result.",
            "Tools are unavailable. Do not call tools. Do not emit DSML/tool_calls.",
            "Return JSON only. No markdown. No prose outside JSON.",
          ].join("\n"),
        },
        {
          role: "user",
          content: buildFinalizationPrompt(
            context.rawPrompt,
            context.messages,
            context.diffExists,
            context.outputSchema,
          ),
        },
      ];
    },
    allowSchemaRepair(context) {
      return !context.outputSchema.endsWith("codex-result.schema.json");
    },
    schemaRepairInstructions() {
      return [
        "You are emulating `codex exec --output-schema` for ClawSweeper.",
        "Repair the provided JSON so it satisfies the requested JSON schema.",
        "Return only the corrected JSON object. Do not use markdown or explanatory prose.",
        "Do not add properties that are not allowed by the schema.",
      ];
    },
    rewriteCommand(command) {
      return rewriteUnsupportedGhPrView(command);
    },
    allowExhaustedWithoutDiff(context) {
      return context.outputSchema.endsWith("codex-result.schema.json");
    },
  };
}

function compactRepairOnlyPrompt(prompt: string): string {
  if (!prompt.includes("source: pr-repair-intake") && !prompt.includes("# Repair-only PR intake")) {
    return prompt;
  }
  const jobStart = prompt.indexOf("## Job file");
  const evidenceStart = prompt.indexOf("## Repair evidence pack");
  const preflightStart = prompt.indexOf("## Cluster preflight artifact");
  const jobSectionEnd = [evidenceStart, preflightStart]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const jobSection = jobStart >= 0 ? prompt.slice(jobStart, jobSectionEnd) : prompt;
  const evidencePack =
    evidenceStart >= 0
      ? prompt.slice(
          evidenceStart,
          preflightStart >= 0 ? preflightStart : evidenceStart + 36000,
        )
      : "";
  const preflight =
    preflightStart >= 0 ? prompt.slice(preflightStart, preflightStart + 6000) : "";
  const sourceRefsStart = prompt.indexOf("## Source PR refs");
  const requiredOutputStart = prompt.indexOf("## Required final output");
  const sourceRefs =
    sourceRefsStart >= 0
      ? prompt.slice(
          sourceRefsStart,
          requiredOutputStart >= 0 ? requiredOutputStart : sourceRefsStart + 4000,
        )
      : "";
  return [
    "# Compact repair-only ClawSweeper prompt",
    "",
    "This is a deterministic pr-repair-intake job. A current repair signal already exists.",
    "Do not perform a normal review verdict. Do not return keep_canonical just because the PR is approved or clean.",
    "Required outcome: produce a schema-valid repair result with fix_needed/build_fix_artifact, or needs_human/blocked with exact blocker evidence.",
    "Focus on the repair evidence pack first: repair_signals, evidence_gates, likely_files, changed_files, and relevant_hunks.",
    "If evidence_gates.source_pr_diff_read/actionable_signal_read/relevant_hunk_read are true, you may return final JSON immediately without exploratory tools.",
    "Do not waste tool turns on git branch, git log, or generic status checks; those are not repair evidence.",
    "If you use tools, inspect only the source diff or relevant file hunks named by the evidence pack, for example git diff <diff_ref> -- <likely_files>.",
    "If a source PR branch needs repair, use repair_strategy=repair_contributor_branch and source_prs with the full PR URL.",
    "Do not push, merge, close, comment, or label.",
    "",
    evidencePack.trim(),
    "",
    jobSection.trim(),
    "",
    sourceRefs.trim(),
    "",
    preflight.trim(),
  ]
    .filter(Boolean)
    .join("\n");
}

function rewriteUnsupportedGhPrView(command: string): string | null {
  if (!/\bgh\s+pr\s+view\b/.test(command)) return null;
  if (!/--json\s+[^\n]*(reviews|reviewRequests|comments)/.test(command)) return null;
  const number = command.match(/\bgh\s+pr\s+view\s+(\d+)\b/)?.[1];
  const repo = command.match(/--repo\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/)?.[1];
  if (!number) return null;
  const repoSetup = repo
    ? ""
    : "REPO=$(git remote get-url origin 2>/dev/null | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\\.git$##'); if [ -z \"$REPO\" ]; then echo '{\"source\":\"gh_api_rest_rewrite\",\"error\":\"repo_inference_failed\"}'; exit 2; fi; BASE=\"repos/$REPO\"";
  const base = repo ? shellQuote(`repos/${repo}`) : '"$BASE"';
  const pr = shellQuote(number);
  return [
    repoSetup,
    "echo '{\"source\":\"gh_api_rest_rewrite\",\"reason\":\"gh pr view review/comment fields use GraphQL fields that can require extra org scopes; using REST with the same GH_TOKEN\",\"review_comments\":'",
    `gh api ${base}/pulls/${pr}/comments --jq '[.[] | {path,line,side,user:.user.login,body,html_url,created_at}]'`,
    "echo ',\"reviews\":'",
    `gh api ${base}/pulls/${pr}/reviews --jq '[.[] | {state,user:.user.login,body,html_url,submitted_at}]'`,
    "echo ',\"issue_comments\":'",
    `gh api ${base}/issues/${pr}/comments --jq '[.[] | {user:.user.login,body,html_url,created_at}]'`,
    "echo '}'",
  ]
    .filter(Boolean)
    .join(" && ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function truthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function positiveNumberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
