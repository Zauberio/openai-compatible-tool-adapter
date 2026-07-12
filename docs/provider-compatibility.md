# Provider compatibility

The adapter targets the OpenAI-compatible Chat Completions shape:

```text
POST <OPENAI_COMPATIBLE_ADAPTER_BASE_URL>/chat/completions
```

It is intentionally narrower than “every API that resembles OpenAI”. Validate a provider against the checklist below before using it in automation.

## Required behavior

A compatible endpoint must:

1. Accept a JSON request containing `model` and `messages`.
2. Return JSON with an assistant message at `choices[0].message`.
3. Accept messages with `role: "tool"` after a tool call.
4. Preserve enough conversation history for a multi-turn tool loop.

For useful coding-agent behavior, the model must also understand the supplied tool definitions and return either:

- native `tool_calls`; or
- a textual tool-call form recognized by the adapter normalizer.

Native OpenAI-style tool calls are preferred.

## Request fields

Depending on the task, the adapter may send:

```json
{
  "model": "provider/model",
  "messages": [],
  "tools": [],
  "tool_choice": "auto",
  "max_tokens": 4096,
  "response_format": { "type": "json_object" }
}
```

`max_tokens` is omitted when `OPENAI_COMPATIBLE_ADAPTER_MAX_TOKENS=0`.

Structured output uses JSON instructions and final local schema validation. A provider does not need to implement full JSON Schema response formats, but it must tolerate or support `response_format: {"type":"json_object"}` when that field is used.

## Authentication

Default authentication:

```http
Authorization: Bearer <value from configured environment variable>
Content-Type: application/json
```

The adapter never takes the secret value directly in its own configuration. It takes the name of the secret environment variable:

```bash
export OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV=PROVIDER_API_KEY
export PROVIDER_API_KEY=replace-with-your-secret
```

For a trusted local endpoint without authentication:

```bash
export OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL=1
export OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV=UNUSED_LOCAL_KEY
unset UNUSED_LOCAL_KEY
```

Additional headers:

```bash
export OPENAI_COMPATIBLE_ADAPTER_HEADERS_JSON='{
  "X-Project": "example",
  "X-Provider-Version": "2026-01-01"
}'
```

Header values are converted to strings. Do not place reusable secrets directly in shell history; inject them through a process manager or secret store where possible.

## Retry behavior

The adapter retries these statuses within `OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES`:

```text
408 429 500 502 503 504
```

It honors `Retry-After` as seconds or an HTTP date, capped at 30 seconds. Otherwise it uses bounded exponential backoff with jitter.

Network failures are retried. Permanent 4xx responses other than 408 and 429 fail immediately.

## Compatibility smoke test

Start with a read-only task and a short budget:

```bash
export OPENAI_COMPATIBLE_ADAPTER_MAX_TURNS=3
export OPENAI_COMPATIBLE_ADAPTER_REQUEST_TIMEOUT_MS=60000

printf '%s\n' \
  'Read package.json and return the package name. Do not modify files.' | \
  openai-compatible-tool-adapter exec \
    --cd /path/to/repository \
    --json -
```

A successful smoke should demonstrate:

- the provider receives `/chat/completions` requests;
- the first assistant turn either answers or requests a tool;
- tool results are accepted in later turns;
- the final message appears on stdout;
- no files are changed for a read-only task.

Confirm the last point with:

```bash
git status --short
```

## Common incompatibilities

### Endpoint returns HTTP 404

The configured base URL may already include `/chat/completions`. Supply the API root instead:

```text
correct:   https://provider.example/v1
requested: https://provider.example/v1/chat/completions
```

### Endpoint returns HTTP 200 but no `choices[0].message`

The provider may implement a Responses-style API rather than Chat Completions, or may wrap the payload in another object. This adapter currently requires Chat Completions output.

### Model returns prose instead of tool calls

Confirm that the provider forwards the `tools` field and that the selected model supports function/tool calling. Try a stronger tool-capable model before relying on textual fallback normalization.

### Provider rejects `response_format`

Run without `--output-schema` to verify the basic tool loop. If unstructured tasks work but schema tasks fail at request time, the provider may reject JSON-object response formatting.

### Provider requires custom headers

Use `OPENAI_COMPATIBLE_ADAPTER_HEADERS_JSON`. Confirm that the provider does not require query-string secrets or a non-Bearer authentication scheme unsupported by the adapter.

## Conformance tests

Repository integration tests include a local HTTP server that verifies:

- retries after a transient 503;
- `Retry-After` handling;
- custom headers;
- optional authentication;
- rejection of malformed successful payloads;
- generic recipe isolation.

Run them with:

```bash
corepack pnpm run build
node --test test/provider-integration.test.mjs
```
