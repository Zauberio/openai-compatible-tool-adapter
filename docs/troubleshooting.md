# Troubleshooting

Run the CLI help first to confirm the build and command path:

```bash
openai-compatible-tool-adapter --version
openai-compatible-tool-adapter --help
```

From a source checkout without `npm link`:

```bash
node dist/bin/openai-compatible-tool-adapter.js --version
```

## Installation and build

### `corepack: command not found`

Install Node.js 20 or newer, then enable Corepack:

```bash
corepack enable
corepack pnpm --version
```

### The built CLI does not exist

Run a clean build:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run build
ls -l dist/bin/openai-compatible-tool-adapter.js
```

### `openai-compatible-tool-adapter: command not found`

Either invoke the built JavaScript file directly or link the package:

```bash
npm link
command -v openai-compatible-tool-adapter
```

## Provider configuration

### `missing required env: OPENAI_COMPATIBLE_ADAPTER_BASE_URL`

Set both required provider values:

```bash
export OPENAI_COMPATIBLE_ADAPTER_BASE_URL=https://api.example.com/v1
export OPENAI_COMPATIBLE_ADAPTER_MODEL=provider/model
```

### `missing API key in ...`

The error names the environment variable the adapter tried to read. Set that variable:

```bash
export OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV=PROVIDER_API_KEY
export PROVIDER_API_KEY=replace-with-your-secret
```

For a trusted local endpoint without authentication:

```bash
export OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL=1
```

### HTTP 401 or 403

Check:

- the variable named by `OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV` is present in the same process environment;
- the provider expects Bearer authentication;
- the key has access to the selected model;
- extra required headers are supplied through `OPENAI_COMPATIBLE_ADAPTER_HEADERS_JSON`.

Do not print a production token while diagnosing. Confirm only whether the variable is set:

```bash
test -n "${PROVIDER_API_KEY:-}" && echo set || echo missing
```

### HTTP 404

The adapter appends `/chat/completions`. Configure the API root, not the full endpoint:

```text
OPENAI_COMPATIBLE_ADAPTER_BASE_URL=https://provider.example/v1
```

### `missing choices[0].message`

The provider returned HTTP success but not a Chat Completions payload. Inspect the provider documentation and confirm it supports:

```text
choices[0].message
```

Responses-style APIs are not currently supported.

### Invalid JSON from provider

A proxy may be returning HTML, a login page or a streaming format. Confirm the endpoint returns one JSON object for a normal non-streaming Chat Completions request.

## Tool loop

### The model never calls tools

- Confirm the model supports tool/function calling.
- Confirm the provider forwards `tools` and `tool_choice`.
- Try a direct task such as “read package.json and return its name”.
- Use a model known to follow multi-turn tool protocols.

### `max_turns_exhausted`

The default budget is 20 turns. Narrow the task or increase it:

```bash
export OPENAI_COMPATIBLE_ADAPTER_MAX_TURNS=40
```

Use `0` only when an outer process timeout is guaranteed:

```bash
export OPENAI_COMPATIBLE_ADAPTER_MAX_TURNS=0
```

### A command times out

Increase the per-command budget only as far as the task requires:

```bash
export OPENAI_COMPATIBLE_ADAPTER_COMMAND_TIMEOUT_MS=300000
```

The caller should still enforce a stricter overall wall-clock timeout.

### Command output or diff is truncated

Increase the relevant cap:

```bash
export OPENAI_COMPATIBLE_ADAPTER_COMMAND_OUTPUT_LIMIT=400000
export OPENAI_COMPATIBLE_ADAPTER_DIFF_OUTPUT_LIMIT=400000
```

Large output can consume model context quickly. Prefer narrower commands and file ranges.

## File access

### `write denied for ...`

The exact relative path is missing from the allowed-file list:

```bash
export OPENAI_COMPATIBLE_ADAPTER_ALLOWED_FILES="src/index.ts,test/index.test.ts"
```

The list is exact, not a directory-prefix allowlist.

### `path outside cwd`

The tool requested an absolute or relative path outside the directory selected by `--cd`. Start the adapter at the correct checkout and use paths relative to that checkout.

### `path escapes cwd through symlink`

The requested file or one of its parent directories resolves outside the real checkout. Replace the symlink with an in-checkout path or use a different isolated checkout.

### `invalid patch`

`apply_patch` pre-scans patches with Git before applying them. Check that the patch is valid unified diff syntax and that all target files exist in the expected state.

## Structured output

### Final JSON fails schema validation

- Validate the schema itself with a JSON Schema tool.
- Start with a small schema and `additionalProperties: false` only where necessary.
- Confirm the model can produce reliable JSON.
- Inspect the adapter's validation messages for the exact path and keyword.
- Run once without `--output-schema` to distinguish provider/tool-loop problems from schema problems.

### Provider rejects `response_format`

Some compatible endpoints do not accept JSON-object response formatting. Basic unstructured tasks may still work. See [provider-compatibility.md](./provider-compatibility.md).

## Recipes

### ClawSweeper wrapper does not start

Build the package and check the wrapper path:

```bash
corepack pnpm run build
node bin/clawsweeper-codex-adapter.mjs --help
```

Confirm `CODEX_BIN` points to an executable wrapper and that the required `CLAWSWEEPER_OPENAI_COMPATIBLE_*` provider variables are present.

### `unknown adapter recipe`

Use a supported recipe name:

```text
generic
clawsweeper
```

Wrappers normally set the recipe automatically.

## Verification

Before reporting a bug, run:

```bash
corepack pnpm run verify
git status --short
node --version
```

Include the Node version, provider family, sanitized error message and a minimal reproduction. Never include API keys, tokens, complete private prompts or sensitive repository contents.
