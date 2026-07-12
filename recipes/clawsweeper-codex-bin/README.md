# ClawSweeper recipe

Use an OpenAI-compatible Chat Completions provider as the coding worker behind ClawSweeper's existing `CODEX_BIN` command override.

The wrapper keeps the command shape expected by ClawSweeper, maps recipe-specific environment variables to the generic adapter, and explicitly selects the `clawsweeper` recipe.

## Requirements

- A built or installed copy of OpenAI-Compatible Tool Adapter.
- A ClawSweeper version that supports `CODEX_BIN`.
- An OpenAI-compatible provider and tool-capable model.
- GitHub credentials only when the repair job needs PR inspection.

## Quick start

### 1. Build and expose the wrapper

From the adapter checkout:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run build
npm link
```

Confirm both public commands are available:

```bash
openai-compatible-tool-adapter --version
clawsweeper-codex-adapter --help
```

### 2. Configure ClawSweeper

```bash
export CODEX_BIN="$(command -v clawsweeper-codex-adapter)"
export CLAWSWEEPER_MODEL_BACKEND=codex-cli
```

### 3. Configure the provider

```bash
export CLAWSWEEPER_OPENAI_COMPATIBLE_BASE_URL="https://api.example.com/v1"
export CLAWSWEEPER_OPENAI_COMPATIBLE_MODEL="provider/model"
export CLAWSWEEPER_OPENAI_COMPATIBLE_API_KEY_ENV="PROVIDER_API_KEY"
export PROVIDER_API_KEY="replace-with-your-secret"
```

Safe starting limits:

```bash
export CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TURNS=20
export CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TOKENS=0
export CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_RETRIES=3
```

Set max turns to `0` only when the caller enforces an outer wall-clock timeout.

An example environment file is available at [adapter.example.env](./adapter.example.env).

## What the wrapper maps

| ClawSweeper variable | Adapter variable |
|---|---|
| `CLAWSWEEPER_OPENAI_COMPATIBLE_BASE_URL` | `OPENAI_COMPATIBLE_ADAPTER_BASE_URL` |
| `CLAWSWEEPER_OPENAI_COMPATIBLE_MODEL` | `OPENAI_COMPATIBLE_ADAPTER_MODEL` |
| `CLAWSWEEPER_OPENAI_COMPATIBLE_API_KEY_ENV` | `OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV` |
| `CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TURNS` | `OPENAI_COMPATIBLE_ADAPTER_MAX_TURNS` |
| `CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TOKENS` | `OPENAI_COMPATIBLE_ADAPTER_MAX_TOKENS` |
| `CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_RETRIES` | `OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES` |
| `CLAWSWEEPER_OPENAI_COMPATIBLE_READ_LIMIT` | `OPENAI_COMPATIBLE_ADAPTER_READ_LIMIT` |
| `CLAWSWEEPER_OPENAI_COMPATIBLE_COMMAND_TIMEOUT_MS` | `OPENAI_COMPATIBLE_ADAPTER_COMMAND_TIMEOUT_MS` |
| `CLAWSWEEPER_OPENAI_COMPATIBLE_REQUEST_TIMEOUT_MS` | `OPENAI_COMPATIBLE_ADAPTER_REQUEST_TIMEOUT_MS` |
| `CLAWSWEEPER_OPENAI_COMPATIBLE_COMMAND_OUTPUT_LIMIT` | `OPENAI_COMPATIBLE_ADAPTER_COMMAND_OUTPUT_LIMIT` |
| `CLAWSWEEPER_OPENAI_COMPATIBLE_DIFF_OUTPUT_LIMIT` | `OPENAI_COMPATIBLE_ADAPTER_DIFF_OUTPUT_LIMIT` |
| `CLAWSWEEPER_OPENAI_COMPATIBLE_ALLOWED_FILES` | `OPENAI_COMPATIBLE_ADAPTER_ALLOWED_FILES` |

The wrapper also sets:

```bash
OPENAI_COMPATIBLE_ADAPTER_RECIPE=clawsweeper
```

## GitHub access

Repair jobs that inspect pull requests may need a normal GitHub token:

```bash
export GH_TOKEN="replace-with-a-scoped-token"
export GITHUB_TOKEN="$GH_TOKEN"
```

The wrapper preserves or fills these aliases when possible:

```text
GH_TOKEN
GITHUB_TOKEN
CLAWSWEEPER_INVENTORY_TOKEN
CLAWSWEEPER_DISPATCH_TOKEN
```

`run_command` inherits these values because PR inspection may need `gh`. Use narrowly scoped credentials and do not put tokens in recipe files, command arguments or shell history.

## Optional deterministic evidence pack

Enable the ClawSweeper evidence prelude:

```bash
export CLAWSWEEPER_REPAIR_EVIDENCE_PACK=1
export CLAWSWEEPER_REPAIR_EVIDENCE_PACK_MAX_HUNKS=6
export CLAWSWEEPER_REPAIR_EVIDENCE_PACK_MAX_HUNK_BYTES=12000
```

The recipe reads the prepared checkout and available source-PR refs, then adds deterministic context such as:

- source PR refs;
- changed files and diff stat;
- relevant hunks;
- prompt repair signals;
- likely files;
- validation hints.

This evidence helps the model make a focused repair. It does not publish, push, merge, comment or label anything.

## Expected command shape

ClawSweeper may invoke the wrapper with the same shape used for `codex exec`:

```bash
printf '%s\n' "$PROMPT" | \
  clawsweeper-codex-adapter exec \
    --cd /tmp/repair-checkout \
    --output-last-message /tmp/repair-result.json \
    --output-schema /path/to/codex-result.schema.json \
    --json -
```

The recipe handles ClawSweeper-specific prompt compaction, evidence preparation, finalization and result normalization. Provider access and repository tools remain in the generic adapter core.

## Responsibility split

The adapter may:

- inspect the prepared checkout;
- inspect already available PR refs;
- edit allowed files;
- run validation commands;
- return a schema-valid repair result.

ClawSweeper remains responsible for:

- creating and selecting the checkout;
- deciding allowed files and refs;
- enforcing job timeout and sandbox policy;
- deterministic validation gates;
- commit, push, comment, merge and other publication actions.

## Smoke test

A no-provider reachability check:

```bash
clawsweeper-codex-adapter --help
```

A real smoke should use a disposable checkout and a read-only or narrowly scoped repair task. After the run, inspect:

```bash
git status --short
git diff --check
```

## Troubleshooting

- **Wrapper not found** — run `npm link` or point `CODEX_BIN` to `bin/clawsweeper-codex-adapter.mjs`.
- **Missing provider environment** — verify the three required `CLAWSWEEPER_OPENAI_COMPATIBLE_*` values.
- **GitHub 401/403** — confirm a scoped token is present in the same process environment.
- **No repair evidence** — enable the evidence pack and confirm the prepared checkout contains the expected refs.
- **Turn budget exhausted** — narrow the job or increase `CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TURNS`.

For general provider and filesystem diagnostics, see [../../docs/troubleshooting.md](../../docs/troubleshooting.md).
