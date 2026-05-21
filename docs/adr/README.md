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
| [0001](./0001-use-foundry-mcp-for-vtt.md) | Use the Foundry MCP module for VTT integration | Superseded by [0011](./0011-prefer-oss-foundry-mcp-bridges.md) |
| [0002](./0002-four-tier-memory-model.md) | Four-tier memory model (hot / warm / cold / episodic) | Accepted; warm-tier contents superseded by [0013](./0013-warm-tier-after-foundry-source-of-truth.md) |
| [0003](./0003-tool-call-only-state-mutation.md) | All state mutations occur via typed tool calls | Accepted |
| [0004](./0004-plugin-interface-pattern.md) | Plugin interfaces for LLM / Ruleset / VTT / Voice | Accepted; Ruleset portion superseded by [0012](./0012-drop-ruleset-plugin-interface.md) |
| [0005](./0005-apache-2-license.md) | Apache License 2.0 | Accepted |
| [0006](./0006-behavior-spec-separate-doc.md) | DM Behavior Spec lives in a separately-versioned document | Accepted |
| [0007](./0007-phandelver-content-operator-supplied.md) | Commercial campaign content stays operator-supplied | Accepted |
| [0008](./0008-tenant-scoping.md) | Tenant scoping in the data model | Accepted |
| [0009](./0009-telemetry-opt-in.md) | Telemetry off by default, opt-in only | Accepted |
| [0010](./0010-privacy-as-architecture.md) | Privacy as architecture, not operational commitment | Accepted |
| [0011](./0011-prefer-oss-foundry-mcp-bridges.md) | Prefer fully-OSS Foundry MCP bridges (supersedes 0001's bridge choice) | Accepted |
| [0012](./0012-drop-ruleset-plugin-interface.md) | Drop the `Ruleset` plugin interface (supersedes 0004's Ruleset portion) | Accepted |
| [0013](./0013-warm-tier-after-foundry-source-of-truth.md) | Warm-tier state after Foundry-as-source-of-truth (supersedes 0002's warm-tier description) | Accepted |
| [0014](./0014-episodic-memory-campaign-scoped-erasure.md) | Episodic memory is campaign-scoped shared content (erasure not per-player) | Accepted; refined by [0017](./0017-per-audience-memory-visibility-erasure.md) |
| [0015](./0015-operator-pregame-ai-performs-in-play-dm-actions.md) | Operator configures pre-game; Skeinkeeper performs all in-play DM actions | Accepted |
| [0016](./0016-operator-control-parity-across-surfaces.md) | Operator controls have parity across the console and Discord, via one write path | Accepted |
| [0017](./0017-per-audience-memory-visibility-erasure.md) | Per-audience memory visibility & erasure (refines 0014 for private side-channels) | Accepted |
