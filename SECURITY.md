# Security policy

## Reporting a vulnerability

Please use the repository's GitHub Security Advisories feature to report vulnerabilities privately. Do not open a public issue containing exploit details, credentials or production paths.

## Threat model

The adapter processes model-generated tool calls and repository content that may contain prompt injection. The model system prompt is guidance, not a security boundary.

The path-based tools are restricted to the real target checkout. Optional allowed-file controls also cover every path touched by `apply_patch`.

`run_command` remains privileged arbitrary shell execution. It inherits the adapter environment, including any provider or GitHub tokens supplied by the host, and is not constrained by the allowed-file list.

## Recommended deployment

For untrusted prompts or repositories:

- run in an ephemeral container or VM;
- mount only the intended checkout;
- use a non-root user;
- limit CPU, memory, process count and execution time;
- restrict network egress;
- provide read-only, short-lived and narrowly scoped credentials;
- keep publishing credentials out of the adapter runtime;
- inspect and validate diffs before a separate publish stage.

Do not expose the adapter directly as an unauthenticated network service.
