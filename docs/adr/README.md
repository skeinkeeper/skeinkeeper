# Architecture Decision Records

This directory contains the Architecture Decision Records (ADRs) for Skeinkeeper. Each ADR captures a single significant architectural choice — the **context** that forced the decision, the **decision** itself, and the **consequences** that follow from it.

ADRs are append-only and immutable once accepted. If a decision changes, write a new ADR that supersedes the old one and update the old one's status.

## Format

We use a lightweight variant of [Michael Nygard's ADR template](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions):

```
# ADR-NNNN: Short Title

## Status
Proposed | Accepted | Deprecated | Superseded by ADR-XXXX

## Context
What problem are we solving? What forces are at play?

## Decision
What did we decide? State it as an active assertion.

## Consequences
What follows from this decision — good, bad, neutral?
```

## Conventions

- ADRs are numbered sequentially from `0001` with zero-padding to 4 digits.
- One decision per ADR.
- ADRs are short. Most fit on one screen.
- ADRs are about *architecture*, not behavior. DM behavior is captured in [`/behavior/default.md`](../../behavior/default.md).
- New ADRs require status `Proposed` until reviewed and merged as `Accepted`.

## Index

| # | Title | Status |
|---|---|---|
| [0001](./0001-use-foundry-mcp-for-vtt.md) | Use the Foundry MCP module for VTT integration | Proposed |
| [0002](./0002-four-tier-memory-model.md) | Four-tier memory model (hot / warm / cold / episodic) | Proposed |
| [0003](./0003-tool-call-only-state-mutation.md) | All state mutations occur via typed tool calls | Proposed |
| [0004](./0004-plugin-interface-pattern.md) | Plugin interfaces for LLM / Ruleset / VTT / Voice | Proposed |
| [0005](./0005-apache-2-license.md) | Apache License 2.0 | Proposed |
| [0006](./0006-behavior-spec-separate-doc.md) | DM Behavior Spec lives in a separately-versioned document | Proposed |
| [0007](./0007-phandelver-content-operator-supplied.md) | Commercial campaign content stays operator-supplied | Proposed |
| [0008](./0008-tenant-scoping.md) | Tenant scoping in the data model | Proposed |
| [0009](./0009-telemetry-opt-in.md) | Telemetry off by default, opt-in only | Proposed |
| [0010](./0010-privacy-as-architecture.md) | Privacy as architecture, not operational commitment | Proposed |
