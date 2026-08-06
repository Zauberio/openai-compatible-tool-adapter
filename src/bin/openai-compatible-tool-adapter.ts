#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadRecipe, type RecipeContext } from "../recipes/index.js";
import { normalizeToolCalls, pseudoToolCalls } from "../core/textual-tools.js";
import { compileJsonSchema } from "../core/schema-validator.js";
import { WorkspaceGuard } from "../core/workspace-guard.js";

type Message = {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};
type ToolCall = { id: string; function: { name: string; arguments?: string } };

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  printHelp();
  process.exit(0);
}
if (rawArgs.includes("--version") || rawArgs.includes("-V")) {
  process.stdout.write(`${readPackageVersion()}\n`);
  process.exit(0);
}
const args = normalizeCodexExecArgs(rawArgs);
const cd = stringArg("--cd", process.cwd());
const outputLastMessage = stringArg("--output-last-message", "");
const outputSchema = stringArg("--output-schema", "");
const outputSchemaAbs = outputSchema ? path.resolve(outputSchema) : "";
if (outputSchemaAbs && !fs.existsSync(outputSchemaAbs)) {
  throw new Error(`output schema not found: ${outputSchemaAbs}`);
}
const outputSchemaJson =
  outputSchemaAbs && fs.existsSync(outputSchemaAbs)
    ? JSON.parse(fs.readFileSync(outputSchemaAbs, "utf8"))
    : null;
const outputSchemaValidator = outputSchemaJson ? compileJsonSchema(outputSchemaJson) : null;
const cwd = path.resolve(cd);
const baseUrl = requiredEnv("OPENAI_COMPATIBLE_ADAPTER_BASE_URL").replace(/\/$/, "");
const model = requiredEnv("OPENAI_COMPATIBLE_ADAPTER_MODEL");
const apiKeyEnv = process.env.OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV || "OPENAI_API_KEY";
const apiKey = process.env[apiKeyEnv] || "";
const apiKeyOptional = truthyEnv("OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL");
const extraHeaders = jsonObjectEnv("OPENAI_COMPATIBLE_ADAPTER_HEADERS_JSON");
const maxTurns = numberEnvZeroMeansUnlimited("OPENAI_COMPATIBLE_ADAPTER_MAX_TURNS", 20);
const maxRetries = numberEnv("OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES", 3);
const readLimit = numberEnv("OPENAI_COMPATIBLE_ADAPTER_READ_LIMIT", 200000);
const commandTimeoutMs = numberEnv("OPENAI_COMPATIBLE_ADAPTER_COMMAND_TIMEOUT_MS", 120000);
const requestTimeoutMs = numberEnv("OPENAI_COMPATIBLE_ADAPTER_REQUEST_TIMEOUT_MS", 600000);
const maxTokens = numberEnvAllowZero("OPENAI_COMPATIBLE_ADAPTER_MAX_TOKENS", 0);
const commandOutputLimit = numberEnv("OPENAI_COMPATIBLE_ADAPTER_COMMAND_OUTPUT_LIMIT", 200000);
const diffOutputLimit = numberEnv("OPENAI_COMPATIBLE_ADAPTER_DIFF_OUTPUT_LIMIT", 200000);
const recipe = loadRecipe(process.env.OPENAI_COMPATIBLE_ADAPTER_RECIPE || "generic", {
  env: process.env,
});
const allowed = String(process.env.OPENAI_COMPATIBLE_ADAPTER_ALLOWED_FILES || "")
  .split(/[,:]/)
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => path.normalize(entry));
const workspace = new WorkspaceGuard(cwd, allowed);

if (!apiKey && !apiKeyOptional) throw new Error(`missing API key in ${apiKeyEnv}`);

const optionalToolArgs = new Set([
  "start",
  "end",
  "offset",
  "limit",
  "timeoutMs",
  "path",
  "maxResults",
  "replaceAll",
]);

const tools = [
  tool(
    "read_file",
    "Read a UTF-8 text file under the target repository. Optional offset/limit are 1-based line controls.",
    {
      path: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
      start: { type: "number" },
      end: { type: "number" },
    },
  ),
  tool("read_file_range", "Read a UTF-8 text file line range under the target repository.", {
    path: { type: "string" },
    start: { type: "number" },
    end: { type: "number" },
  }),
  tool(
    "write_file",
    "Write a complete UTF-8 text file under the target repository. Use only when whole-file replacement is intended.",
    {
      path: { type: "string" },
      content: { type: "string" },
    },
  ),
  tool(
    "replace_in_file",
    "Replace an exact string in a file. Safer than write_file for small localized edits.",
    {
      path: { type: "string" },
      search: { type: "string" },
      replacement: { type: "string" },
      replaceAll: { type: "boolean" },
    },
  ),
  tool("run_command", "Run a short validation command in the target repository.", {
    command: { type: "string" },
    timeoutMs: { type: "number" },
  }),
  tool(
    "search_files",
    "Search repository text with grep. Use this instead of broad shell exploration.",
    {
      pattern: { type: "string" },
      path: { type: "string" },
      maxResults: { type: "number" },
    },
  ),
  tool("apply_patch", "Apply a unified diff patch to the target repository.", {
    patch: { type: "string" },
  }),
  tool("git_diff", "Return git status and git diff for the target repository.", {}),
];
const allowedToolNames = tools.map((toolEntry) => toolEntry.function.name);
const observedEvidence: string[] = [];

async function main() {
  const rawPrompt = fs.readFileSync(0, "utf8");
  const prompt = recipe.preparePrompt(rawPrompt, cwd);
  const schemaInstruction = outputSchema
    ? `The final answer must be valid JSON matching the requested output schema path: ${outputSchema}. Do not wrap JSON in markdown.`
    : "For implementation tasks, summarize the changes made and validation run.";
  let toolsExecuted = 0;
  const messages: Message[] = [
    {
      role: "system",
      content: [
        ...recipe.systemInstructions(
          makeRecipeContext(rawPrompt, [], toolsExecuted, worktreeHasDiff()),
        ),
        `Target repository cwd: ${cwd}.`,
        `Allowed write files: ${allowed.join(", ") || "all files under cwd"}.`,
        schemaInstruction,
      ].join("\n"),
    },
    { role: "user", content: prompt },
  ];
  let finalContent = "";
  let exhausted = true;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const data = await chat(messages, turn + 1, true);
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("missing assistant message");
    messages.push(msg);
    if (msg.content) {
      finalContent = String(msg.content);
      process.stdout.write(`assistant:\n${finalContent}\n`);
    }
    const calls = normalizeToolCalls(
      // Providers may emit tool_calls as null, a string, an object, a number
      // or a boolean on malformed responses. Only arrays are valid; anything
      // else must be treated as "no calls" - an unchecked `?? []` only guards
      // null/undefined and would crash (or corrupt the concat) on the rest.
      (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).concat(pseudoToolCalls(msg.content, allowedToolNames)),
      allowedToolNames,
    );
    process.stderr.write(`[openai-compatible-tools] turn=${turn + 1} tool_calls=${calls.length}\n`);
    if (calls.length === 0) {
      const validationErrors = validateFinalContent(finalContent);
      if (outputSchema && validationErrors.length > 0) {
        const candidate = recipe.normalizeCandidate?.(
          finalContent,
          makeRecipeContext(rawPrompt, messages, toolsExecuted, worktreeHasDiff()),
        );
        if (candidate) {
          const normalizedErrors = validateFinalContent(candidate.content);
          if (normalizedErrors.length === 0) {
            if (candidate.retryPrompt) {
              messages.push({ role: "user", content: candidate.retryPrompt });
              finalContent = "";
              continue;
            }
            finalContent = candidate.content;
            exhausted = false;
            break;
          }
        }
        messages.push({
          role: "user",
          content: [
            "Your previous final answer did not satisfy the requested structured output contract.",
            `Return only valid JSON matching this schema path: ${outputSchema}.`,
            "Do not use markdown. Do not include explanatory prose outside the JSON object.",
            "Validation failures:",
            ...validationErrors.slice(0, 20).map((error: string) => `- ${error}`),
          ].join("\n"),
        });
        continue;
      }
      exhausted = false;
      break;
    }
    for (const call of calls) {
      process.stdout.write(`tool_call: ${call.function.name} ${call.function.arguments || "{}"}\n`);
      const result = executeTool(call);
      toolsExecuted += 1;
      recordObservedEvidence(call, result);
      process.stdout.write(`tool_result: ${truncate(result.content, 2000)}\n`);
      messages.push(result);
    }
  }
  const diffExistsAtEnd = worktreeHasDiff();
  const exhaustionContext = makeRecipeContext(
    rawPrompt,
    messages,
    toolsExecuted,
    diffExistsAtEnd,
  );
  const recipeFinalization = exhausted
    ? recipe.buildExhaustionFinalization?.(exhaustionContext) ?? null
    : null;
  if (exhausted && recipeFinalization) {
    process.stderr.write(
      `[openai-compatible-tools] finalization_start recipe=${recipe.name} reason=max_turns_after_tools\n`,
    );
    const data = await chat(recipeFinalization, maxTurns + 1, false);
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("missing final assistant message");
    finalContent = String(msg.content ?? "");
    if (finalContent) process.stdout.write(`assistant_finalization:\n${finalContent}\n`);
    exhausted = false;
  } else if (exhausted && outputSchema) {
    messages.push({
      role: "user",
      content: [
        "Tool budget is exhausted. Do not call tools again.",
        `Return only valid JSON matching this schema path: ${outputSchema}.`,
        "Base the decision on the evidence already collected and the current git diff.",
        "If evidence or changes are insufficient, return a conservative blocked or needs_human result that still satisfies the schema.",
        "Do not use markdown. Do not include prose outside the JSON object.",
      ].join("\n"),
    });
    const data = await chat(messages, maxTurns + 1, false);
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("missing final assistant message");
    finalContent = String(msg.content ?? "");
    if (finalContent) process.stdout.write(`assistant:\n${finalContent}\n`);
  } else if (exhausted) {
    finalContent = JSON.stringify({
      status: diffExistsAtEnd ? "completed_with_diff" : "blocked",
      reason: `openai-compatible-tools max_turns_exhausted after ${maxTurns} turns`,
      partial_summary: finalContent || null,
    });
  }
  finalContent =
    recipe.normalizeFinal?.(
      finalContent,
      makeRecipeContext(rawPrompt, messages, toolsExecuted, diffExistsAtEnd),
    ) ?? finalContent;
  let finalValidationErrors = validateFinalContent(finalContent);
  if (
    outputSchema &&
    finalValidationErrors.length > 0 &&
    finalContent.trim() &&
    (recipe.allowSchemaRepair?.(
      makeRecipeContext(rawPrompt, messages, toolsExecuted, diffExistsAtEnd),
    ) ?? true)
  ) {
    process.stderr.write(
      "[openai-compatible-tools] schema_repair_start errors=" +
        JSON.stringify(finalValidationErrors.slice(0, 20)) +
        "\n",
    );
    const repairMessages: Message[] = [
      {
        role: "system",
        content: (
          recipe.schemaRepairInstructions?.(
            makeRecipeContext(rawPrompt, messages, toolsExecuted, diffExistsAtEnd),
          ) ?? [
            "Repair the provided JSON so it satisfies the requested JSON schema.",
            "Return only the corrected JSON object. Do not use markdown or explanatory prose.",
            "Do not add properties that are not allowed by the schema.",
          ]
        ).join("\n"),
      },
      {
        role: "user",
        content: [
          `Schema path: ${outputSchema}`,
          "Validation failures:",
          ...finalValidationErrors.slice(0, 40).map((error: string) => `- ${error}`),
          "Current JSON candidate:",
          normalizeFinalContent(finalContent).trim(),
        ].join("\n"),
      },
    ];
    const repair = await chat(repairMessages, maxTurns + 2, false);
    const repairMsg = repair.choices?.[0]?.message;
    if (repairMsg?.content) {
      finalContent = String(repairMsg.content);
      process.stdout.write(`assistant_schema_repair:\n${finalContent}\n`);
      finalValidationErrors = validateFinalContent(finalContent);
    }
  }
  if (outputSchema && finalValidationErrors.length > 0) {
    process.stderr.write(
      "[openai-compatible-tools] schema_invalid errors=" +
        JSON.stringify(finalValidationErrors.slice(0, 20)) +
        "\n",
    );
    finalDiffSummary();
    process.exit(2);
  }
  if (outputLastMessage) {
    fs.mkdirSync(path.dirname(path.resolve(outputLastMessage)), { recursive: true });
    fs.writeFileSync(outputLastMessage, normalizeFinalContent(finalContent));
  }
  finalDiffSummary();
  if (
    exhausted &&
    !diffExistsAtEnd &&
    !recipe.allowExhaustedWithoutDiff?.(
      makeRecipeContext(rawPrompt, messages, toolsExecuted, diffExistsAtEnd),
    )
  ) {
    process.exit(2);
  }
}

async function chat(messages: Message[], turn: number, allowTools: boolean): Promise<any> {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const payload: Record<string, unknown> = {
      model,
      messages,
      temperature: 0,
    };
    if (maxTokens > 0) payload.max_tokens = maxTokens;
    if (allowTools) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }
    if (outputSchema && !allowTools) payload.response_format = { type: "json_object" };
    const body = JSON.stringify(payload);
    const startedAt = Date.now();
    process.stderr.write(
      `[openai-compatible-tools] chat_start turn=${turn} attempt=${attempt}/${maxRetries} messages=${messages.length} bytes=${Buffer.byteLength(body)} timeout_ms=${requestTimeoutMs} max_tokens=${maxTokens > 0 ? maxTokens : "provider_default"}\n`,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let res: Response;
    let text = "";
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...extraHeaders,
      };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      text = await res.text();
    } catch (error) {
      const elapsed = Date.now() - startedAt;
      process.stderr.write(
        `[openai-compatible-tools] chat_error turn=${turn} attempt=${attempt}/${maxRetries} elapsed_ms=${elapsed} error=${truncate(error instanceof Error ? error.message : String(error), 300)}\n`,
      );
      if (attempt < maxRetries) {
        await sleep(retryDelayMs(null, attempt));
        continue;
      }
      throw new Error(
        `OpenAI-compatible backend request failed after ${elapsed}ms: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      clearTimeout(timer);
    }
    const elapsed = Date.now() - startedAt;
    process.stderr.write(
      `[openai-compatible-tools] chat_done turn=${turn} attempt=${attempt}/${maxRetries} status=${res.status} elapsed_ms=${elapsed} response_bytes=${Buffer.byteLength(text)}\n`,
    );
    if (!res.ok) {
      if ([408, 429, 500, 502, 503, 504].includes(res.status) && attempt < maxRetries) {
        await sleep(retryDelayMs(res, attempt));
        continue;
      }
      throw new Error(`OpenAI-compatible backend HTTP ${res.status}: ${truncate(text, 1000)}`);
    }
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `OpenAI-compatible backend returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }; body=${truncate(text, 1000)}`,
      );
    }
    if (!parsed?.choices?.[0]?.message) {
      throw new Error(
        `OpenAI-compatible backend response is missing choices[0].message: ${truncate(text, 1000)}`,
      );
    }
    return parsed;
  }
  throw new Error("OpenAI-compatible backend retry exhausted");
}

function makeRecipeContext(
  rawPrompt: string,
  messages: Message[],
  toolsExecuted: number,
  diffExists: boolean,
): RecipeContext {
  return {
    rawPrompt,
    cwd,
    outputSchema,
    allowedFiles: allowed,
    toolsExecuted,
    diffExists,
    observedEvidence,
    messages,
  };
}

function commandFromArgs(parsed: Record<string, unknown>): string {
  const direct = typeof parsed.command === "string" ? parsed.command.trim() : "";
  if (direct && direct !== "undefined") return direct;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value.trim() && value.trim() !== "command") continue;
    const candidate = key.trim();
    if (/^(git|sed|awk|grep|cat|head|tail|bash|sh|npm|pnpm|python3?|node)\b/.test(candidate))
      return candidate;
  }
  return "";
}


function recordObservedEvidence(call: ToolCall, result: Message) {
  const name = call.function.name;
  let obj: any = {};
  try { obj = JSON.parse(String(result.content || "{}")); } catch { obj = {}; }
  const filePath = obj.path ? String(obj.path) : "";
  let text = name;
  if (name === "read_file" || name === "read_file_range") {
    text = name + " inspected " + (filePath || "unknown path") + ":" + String(obj.start ?? "?") + "-" + String(obj.end ?? "?");
  } else if (name === "run_command") {
    text = "run_command status=" + String(obj.status ?? "unknown");
  } else if (name === "git_diff") {
    const changed = String(obj.status || "").trim().split(/\r?\n/).filter(Boolean).slice(0, 10).join("; ");
    text = "git_diff observed " + (changed || "no changed files");
  } else if (filePath) {
    text = name + " " + filePath;
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text && !observedEvidence.includes(text)) observedEvidence.push(text.slice(0, 500));
}

function executeTool(call: ToolCall): Message {
  let parsed: any = {};
  try {
    parsed = JSON.parse(call.function.arguments || "{}");
  } catch (error) {
    return toolResult(call.id, { ok: false, error: `bad JSON args: ${String(error)}` });
  }
  try {
    if (call.function.name === "read_file") {
      const { rel, abs } = assertPath(parsed.path, false);
      const range = lineRange(parsed);
      if (range) return readFileRange(call.id, rel, abs, range.start, range.end);
      return readFileRange(call.id, rel, abs, 1, defaultReadLineEnd(abs));
    }
    if (call.function.name === "read_file_range") {
      const { rel, abs } = assertPath(parsed.path, false);
      const start = Math.max(1, Number(parsed.start || 1));
      const end = Math.max(start, Number(parsed.end || start));
      return readFileRange(call.id, rel, abs, start, end);
    }
    if (call.function.name === "write_file") {
      const { rel, abs } = assertPath(parsed.path, true);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(parsed.content ?? ""));
      return toolResult(call.id, {
        ok: true,
        path: rel,
        bytes: Buffer.byteLength(String(parsed.content ?? "")),
      });
    }
    if (call.function.name === "replace_in_file") {
      const { rel, abs } = assertPath(parsed.path, true);
      const search = String(parsed.search ?? "");
      const replacement = String(parsed.replacement ?? "");
      const replaceAll = parsed.replaceAll === true;
      if (!search) return toolResult(call.id, { ok: false, error: "missing search" });
      const before = fs.readFileSync(abs, "utf8");
      const occurrences = before.split(search).length - 1;
      if (occurrences === 0)
        return toolResult(call.id, { ok: false, path: rel, error: "search string not found" });
      if (occurrences > 1 && !replaceAll) {
        return toolResult(call.id, {
          ok: false,
          path: rel,
          error: `search string matched ${occurrences} times; set replaceAll=true or use a more specific search`,
        });
      }
      const after = replaceAll
        ? before.split(search).join(replacement)
        : before.replace(search, replacement);
      fs.writeFileSync(abs, after);
      return toolResult(call.id, {
        ok: true,
        path: rel,
        occurrences,
        replaceAll,
        bytes: Buffer.byteLength(after),
      });
    }
    if (call.function.name === "run_command") {
      let command = commandFromArgs(parsed);
      if (!command) return toolResult(call.id, { ok: false, error: "missing command" });
      command = recipe.rewriteCommand?.(command) ?? command;
      const timeout = boundedCommandTimeout(parsed.timeoutMs, commandTimeoutMs);
      const result = spawnSync("bash", ["-lc", command], {
        cwd,
        encoding: "utf8",
        timeout,
        maxBuffer: 1024 * 1024,
      });
      return toolResult(call.id, {
        ok: result.status === 0,
        status: result.status,
        signal: result.signal,
        stdout: truncate(result.stdout, commandOutputLimit),
        stderr: truncate(result.stderr, commandOutputLimit),
      });
    }
    if (call.function.name === "search_files") {
      const relPath = parsed.path ? assertPath(String(parsed.path), false).rel : ".";
      const maxResults = Math.max(1, Math.min(Number(parsed.maxResults || 50), 200));
      const pattern = String(parsed.pattern || "");
      if (!pattern.trim()) return toolResult(call.id, { ok: false, error: "missing pattern" });
      const result = spawnSync("grep", ["-RIn", "--exclude-dir=.git", "--", pattern, relPath], {
        cwd,
        encoding: "utf8",
        timeout: Math.min(commandTimeoutMs, 30000),
        maxBuffer: 1024 * 1024,
      });
      const lines = String(result.stdout || "")
        .split(/\n/)
        .filter(Boolean)
        .slice(0, maxResults);
      return toolResult(call.id, {
        ok: result.status === 0 || result.status === 1,
        status: result.status,
        pattern,
        path: relPath,
        matches: lines,
        truncated: lines.length >= maxResults,
        stderr: truncate(result.stderr, Math.min(commandOutputLimit, 2000)),
      });
    }
    if (call.function.name === "apply_patch") {
      const patch = String(parsed.patch || "");
      if (!patch.trim()) return toolResult(call.id, { ok: false, error: "missing patch" });
      const paths = workspace.assertPatch(patch);
      const result = spawnSync("git", ["apply", "--whitespace=nowarn", "-"], {
        cwd,
        input: patch,
        encoding: "utf8",
        timeout: Math.min(commandTimeoutMs, 30000),
        maxBuffer: 1024 * 1024,
      });
      return toolResult(call.id, {
        ok: result.status === 0,
        status: result.status,
        stdout: truncate(result.stdout, commandOutputLimit),
        stderr: truncate(result.stderr, commandOutputLimit),
        paths,
      });
    }
    if (call.function.name === "git_diff") {
      const status = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf8" });
      const diff = spawnSync("git", ["diff", "--", "."], {
        cwd,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      });
      return toolResult(call.id, {
        ok: true,
        status: status.stdout,
        diff: truncate(diff.stdout, diffOutputLimit),
      });
    }
    return toolResult(call.id, { ok: false, error: `unknown tool ${call.function.name}` });
  } catch (error) {
    return toolResult(call.id, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function lineRange(parsed: Record<string, unknown>): { start: number; end: number } | null {
  const rawStart = parsed.start ?? parsed.offset;
  const rawEnd = parsed.end;
  const rawLimit = parsed.limit;
  if (rawStart === undefined && rawEnd === undefined && rawLimit === undefined) return null;
  const start = Math.max(1, Number(rawStart ?? 1));
  if (rawEnd !== undefined) return { start, end: Math.max(start, Number(rawEnd)) };
  const limit = Math.max(1, Number(rawLimit ?? 120));
  return { start, end: start + limit - 1 };
}

function defaultReadLineEnd(abs: string): number {
  const maxLines = numberEnv("OPENAI_COMPATIBLE_ADAPTER_READ_LINES", 1000);
  const lineCount = fs.readFileSync(abs, "utf8").split(/\n/).length;
  return Math.min(lineCount, maxLines);
}

function readFileRange(id: string, rel: string, abs: string, start: number, end: number): Message {
  const lines = fs.readFileSync(abs, "utf8").split(/\n/);
  const boundedEnd = Math.min(Math.max(start, end), lines.length);
  const content = lines
    .slice(start - 1, boundedEnd)
    .map((line, i) => `${start + i}: ${line}`)
    .join("\n");
  return toolResult(id, {
    ok: true,
    path: rel,
    start,
    end: boundedEnd,
    total_lines: lines.length,
    truncated_before: start > 1,
    truncated_after: boundedEnd < lines.length,
    content: truncate(content, readLimit),
  });
}

function tool(name: string, description: string, properties: Record<string, any>) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required: Object.keys(properties).filter((key) => !optionalToolArgs.has(key)),
      },
    },
  };
}

function toolResult(id: string, obj: unknown): Message {
  return { role: "tool", tool_call_id: id, content: JSON.stringify(obj) };
}

function assertPath(input: string, write: boolean) {
  return workspace.assertPath(input, write);
}

function normalizeFinalContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "\n";
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced?.[1] ?? extractJsonObject(trimmed) ?? trimmed).trim();
  return `${candidate}\n`;
}

function extractJsonObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return null;
}

function boundedCommandTimeout(value: unknown, fallbackMs: number): number {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return fallbackMs;
  return Math.max(1, Math.min(Math.floor(requested), fallbackMs));
}

function validateFinalContent(content: string): string[] {
  if (!outputSchema) return [];
  const normalized = normalizeFinalContent(content).trim();
  if (!normalized) return ["final output is empty"];
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch (error) {
    return [
      `final output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  return outputSchemaValidator ? outputSchemaValidator(parsed) : [];
}

function worktreeHasDiff(): boolean {
  const diff = spawnSync("git", ["diff", "--quiet", "--", "."], { cwd, encoding: "utf8" });
  return diff.status === 1;
}

function finalDiffSummary() {
  const status = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf8" });
  const stat = spawnSync("git", ["diff", "--stat"], { cwd, encoding: "utf8" });
  process.stdout.write(`RUNNER_FINAL_DIFF_EXISTS=${worktreeHasDiff() ? "1" : "0"}\n`);
  if (status.stdout) process.stdout.write(`RUNNER_FINAL_STATUS:\n${status.stdout}`);
  if (stat.stdout) process.stdout.write(`RUNNER_FINAL_DIFF_STAT:\n${stat.stdout}`);
}


function normalizeCodexExecArgs(argv: string[]): string[] {
  const normalized = [...argv];
  if (normalized[0] === "exec") normalized.shift();
  if (normalized[0] && !normalized[0].startsWith("-")) {
    throw new Error(`unsupported adapter subcommand: ${normalized[0]}`);
  }
  return normalized.filter((arg, index) => {
    if (arg === "--json") return false;
    if (arg === "-" && index === normalized.length - 1) return false;
    return true;
  });
}

function stringArg(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? String(args[index + 1]) : fallback;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw !== undefined && raw.trim() === "") return fallback;
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function numberEnvZeroMeansUnlimited(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (value === 0) return Number.POSITIVE_INFINITY;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a positive integer or 0 for unlimited`);
  }
  return value;
}

function jsonObjectEnv(name: string): Record<string, string> {
  const raw = process.env[name]?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must contain a valid JSON object: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must contain a JSON object`);
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, String(value)]),
  );
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30000);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, Math.min(dateMs - Date.now(), 30000));
  }
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 10000) + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truthyEnv(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || "").trim());
}

function numberEnvAllowZero(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw !== undefined && raw.trim() === "") return 0;
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function truncate(value: unknown, limit = 12000): string {
  const text = String(value ?? "");
  return text.length > limit
    ? `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`
    : text;
}


function readPackageVersion(): string {
  const packagePath = new URL("../../package.json", import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  return String(pkg.version || "0.0.0");
}

function printHelp(): void {
  process.stdout.write(`openai-compatible-tool-adapter

Usage:
  openai-compatible-tool-adapter exec [options] -

Options:
  --cd <path>                    Target repository checkout
  --output-last-message <path>   Write the final assistant message
  --output-schema <path>         Validate final JSON against a schema
  --json                         Codex-compatible accepted flag
  --help, -h                     Show this help
  --version, -V                  Show package version

Required environment:
  OPENAI_COMPATIBLE_ADAPTER_BASE_URL
  OPENAI_COMPATIBLE_ADAPTER_MODEL
  OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV (defaults to OPENAI_API_KEY)

The API key may be omitted only when OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL=1.
The default recipe is generic; wrappers may select another recipe.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
