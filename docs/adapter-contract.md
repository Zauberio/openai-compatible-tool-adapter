# External adapter contract

A host calls the adapter as an external command. Provider runtime and host-specific policy remain outside the host project.

## Inputs owned by the host

The host controls:

- target checkout (`--cd`);
- stdin task prompt;
- optional output schema and result path;
- selected recipe;
- allowed write files;
- runtime environment and credentials;
- OS/container sandbox, network policy and resource limits;
- validation and publication gates.

## Generic output

Without an output schema, the adapter returns the model's final message and writes it to `--output-last-message` when requested.

With an output schema, the final message must be valid JSON accepted by Ajv. The adapter may ask the model to repair invalid JSON before failing with exit code 2.

Recipe-specific schemas and normalisers live under `src/recipes/`.

## File capabilities

Repository path tools resolve paths against the real target checkout and reject:

- lexical traversal outside the checkout;
- absolute paths outside the checkout;
- existing symlinks that resolve outside the checkout;
- writes beneath symlinked directories that resolve outside the checkout.

When `OPENAI_COMPATIBLE_ADAPTER_ALLOWED_FILES` is non-empty, it applies to:

- `write_file`;
- `replace_in_file`;
- every file reported by `git apply --numstat` for `apply_patch`.

The allowlist contains exact relative paths. It is not a directory-prefix matcher.

## Privileged command capability

`run_command` is intentionally different from the file tools:

- it runs `bash -lc <command>` in the target checkout;
- it inherits the full adapter process environment;
- it may use runtime tokens required by a recipe;
- it is not limited by `OPENAI_COMPATIBLE_ADAPTER_ALLOWED_FILES`;
- it can read or mutate anything allowed by the outer OS/container sandbox.

Consequently, `run_command` must be treated as privileged code execution, not as part of the file allowlist boundary.

## Credential contract

The adapter receives the API key by environment-variable name. Recipe wrappers may preserve or map additional token aliases.

Credentials must be injected by a secret manager or process supervisor, never committed to recipes. The host should expose only narrowly scoped credentials required for that job.

## Publication boundary

The adapter does not own commit, push, pull-request, merge or deployment policy. Those actions should be separate, deterministic host stages with their own approval and credentials.
