# Recipe: ClawSweeper via CODEX_BIN

This recipe connects ClawSweeper repair/edit/review flows to the generic OpenAI-compatible tool adapter through ClawSweeper's existing `CODEX_BIN` executable override.

The goal is to keep ClawSweeper upstream-clean and Codex-specific from the host project's point of view. ClawSweeper still calls a Codex-shaped command; this recipe supplies a `codex`-compatible executable that delegates provider/runtime work to this adapter.

## Files

```text
bin/clawsweeper-codex-adapter.mjs
recipes/clawsweeper-codex-bin/adapter.example.env
```

## Host configuration

Point ClawSweeper's existing Codex executable override at the wrapper:

```bash
export CODEX_BIN=/path/to/openai-compatible-tool-adapter/bin/clawsweeper-codex-adapter.mjs
```

Keep ClawSweeper's normal Codex backend selected:

```bash
export CLAWSWEEPER_MODEL_BACKEND=codex-cli
```

Then configure the provider using ClawSweeper-flavoured environment names:

```bash
export CLAWSWEEPER_OPENAI_COMPATIBLE_BASE_URL="https://api.example.com/v1"
export CLAWSWEEPER_OPENAI_COMPATIBLE_MODEL="provider/model"
export CLAWSWEEPER_OPENAI_COMPATIBLE_API_KEY_ENV="PROVIDER_API_KEY"
export PROVIDER_API_KEY="...real secret..."
export CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TURNS=0
export CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TOKENS=0
```

`0` for max turns means unlimited turns inside the adapter. Use the host process timeout as the real budget.

## Why CODEX_BIN

ClawSweeper already supports `CODEX_BIN` as its executable substitution point. This recipe intentionally uses that supported seam instead of requiring ClawSweeper to add a second worker-command setting.

From ClawSweeper's perspective, it still launches a Codex-compatible command with the same argv/stdin contract. Provider clients, model routing, tool-loop policy and result normalization remain in this adapter repository.

## GitHub tokens

For repair flows that inspect PRs, provide a normal GitHub token in the process environment:

```bash
export GH_TOKEN="..."
export GITHUB_TOKEN="$GH_TOKEN"
```

The wrapper preserves or fills these aliases when possible:

```text
GH_TOKEN
GITHUB_TOKEN
CLAWSWEEPER_INVENTORY_TOKEN
CLAWSWEEPER_DISPATCH_TOKEN
```

Do not commit tokens into `adapter.example.env`, recipe files, allowlist files, or shell history.

## Optional deterministic evidence pack

The wrapper can ask the adapter to prepend a provider-neutral evidence block to the model prompt:

```bash
export CLAWSWEEPER_REPAIR_EVIDENCE_PACK=1
export CLAWSWEEPER_REPAIR_EVIDENCE_PACK_MAX_HUNKS=6
export CLAWSWEEPER_REPAIR_EVIDENCE_PACK_MAX_HUNK_BYTES=12000
```

When enabled, the adapter reads only the prepared checkout and refs already fetched by ClawSweeper, especially refs shaped like:

```text
refs/remotes/clawsweeper/source-pr-<number>
```

It emits deterministic JSON with source PR refs, changed files, diff stat, relevant hunks, prompt repair signals, likely files and validation hints. This is evidence for the model, not a publish decision. ClawSweeper still owns validation, committing, pushing, commenting and policy gates.

The evidence pack is intentionally provider-neutral. It does not add provider clients, model routing, PR comments, labels, pushes, or GitHub mutations to ClawSweeper.

## Expected host command shape

ClawSweeper can call the wrapper using the same shape it would use for `codex exec`:

```bash
printf "$PROMPT" | \
  /path/to/openai-compatible-tool-adapter/bin/clawsweeper-codex-adapter.mjs \
    exec \
    --cd /tmp/clawsweeper-target/repo \
    --output-last-message /tmp/clawsweeper-summary.json \
    --output-schema /path/to/schema/repair/codex-result.schema.json \
    --json -
```

The wrapper maps `CLAWSWEEPER_OPENAI_COMPATIBLE_*` to `OPENAI_COMPATIBLE_ADAPTER_*` and then calls the generic adapter.

## Recipe input expectations

The prompt/job should be job-scoped and include only what the repair worker needs:

```text
task: repair_edit or review_fix
target_dir: temporary checkout
fix_artifact.likely_files
fix_artifact.validation_commands
repair_contract.must_touch
repair_contract.must_not_touch
repair_contract.must_prove
allowed_files
allowed_pr_refs
validation_commands
```

The adapter does not publish. ClawSweeper remains responsible for validation, committing, pushing, commenting, and all policy gates.

## Validation smoke

After building this package, a no-network wrapper reachability smoke should fail fast with a missing configuration error rather than a spawn error:

```bash
cd /path/to/openai-compatible-tool-adapter
corepack pnpm run build
node bin/clawsweeper-codex-adapter.mjs exec
```

For a real provider smoke, run through a supervised host/job runner with `CODEX_BIN` set to the wrapper and with provider secrets supplied by the runtime environment.
