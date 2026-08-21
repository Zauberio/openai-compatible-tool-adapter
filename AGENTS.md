# AGENTS.md

## Vision

This project exists to let any OpenAI-compatible provider be used in any product through a common adapter, including real code-reading and code-editing workflows.

The provider-agnostic path is the product. Provider-specific optimizations are welcome when they improve capability or performance without degrading the generic path.

## Guardrails

- Keep OpenAI-compatible interoperability as the primary contract.
- Code editing is a core capability, not an optional extra.
- Provider-specific optimizations must preserve functional correctness and competitive performance for generic providers.
- The adapter does not own sandboxing. Isolation belongs to the environment that runs it.
- Codex-shaped interfaces are a convenience, not an architectural constraint; they may change if a better common interface emerges.
- Keep this project an adapter. Do not turn it into an orchestrator, workflow engine, autonomous agent, or policy layer.
