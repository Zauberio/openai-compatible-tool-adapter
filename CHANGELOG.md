# Changelog

## Unreleased

- Separate the generic adapter core from the ClawSweeper recipe.
- Validate output with Ajv instead of a partial hand-written JSON Schema validator.
- Reject symlink path escapes and enforce allowed files for `apply_patch`.
- Add a safe default of 20 tool turns; `0` remains explicit unlimited mode.
- Add CLI help/version, optional unauthenticated providers and additional HTTP headers.
- Improve HTTP retries and malformed provider-response diagnostics.
- Add reproducible npm packaging, package installation smoke tests and CI.
- Add a complete public quick start, configuration reference, provider guide, architecture guide, troubleshooting guide and runnable examples.
- Document `run_command` as a privileged capability that inherits runtime tokens.
- Retain Octopus integration files as legacy compatibility material.

## 0.1.0

Initial public extraction of the OpenAI-compatible tool adapter and ClawSweeper wrapper.
