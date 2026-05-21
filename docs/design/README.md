# Design Docs

This directory contains the feature **design docs** for Skeinkeeper. Where an [ADR](../adr/) captures a single architectural *decision*, a design doc captures the *design* of a feature or subsystem — the context, the approach, alternatives considered, and the implications (privacy, eval, telemetry).

Like ADRs, accepted design docs are **append-only**: a substantive revision is a *new* design doc that supersedes the old one (and adds a `Supersedes:` line); the old one keeps its content and gets a pointer. Draft docs may be restructured in place. See [CONTRIBUTING.md](../../CONTRIBUTING.md) and the [ADR README](../adr/README.md) for the supersede-don't-edit convention.

## Conventions

- Numbered sequentially from `0001`, zero-padded to 4 digits, matching the file name.
- One feature/subsystem per doc.
- Use [`TEMPLATE.md`](./TEMPLATE.md) for new docs.
- Design docs are about *how a feature is built*; cross-cutting architectural decisions belong in an [ADR](../adr/).

## Index

| # | Title | Status |
|---|---|---|
| [0001](./0001-telemetry-library.md) | Telemetry Library | Accepted |
| [0002](./0002-privacy-foundation.md) | Privacy Foundation | Accepted |
| [0003](./0003-erasure-and-export.md) | Erasure and Export | Accepted |
| [0004](./0004-eval-harness.md) | Eval Harness | Accepted |
| [0005](./0005-state-schema.md) | State Schema | Accepted; parts superseded by [0007](./0007-foundry-as-source-of-truth.md) |
| [0006](./0006-tool-registry.md) | Tool Registry | Accepted |
| [0007](./0007-foundry-as-source-of-truth.md) | Foundry-as-Source-of-Truth | Accepted; supersedes parts of [0005](./0005-state-schema.md) |
| [0008](./0008-llm-provider-interface.md) | LLM Provider Interface | Accepted |
| [0009](./0009-behavior-spec-loader.md) | Behavior Spec Loader | Accepted |
| [0010](./0010-audio-extensible-llm-interface.md) | Audio-Extensible LLMProvider Interface | Accepted |
| [0011](./0011-orchestrator-turn-loop.md) | Orchestrator Turn Loop | Accepted |
| [0012](./0012-voice-io.md) | Voice IO — Interface, Consent, Session Loop | Accepted |
| [0013](./0013-dialogue-persistence-session-lifecycle.md) | Dialogue Persistence + Session Lifecycle | Accepted |
| [0014](./0014-mcp-foundry-client.md) | McpFoundryClient | Accepted |
| [0015](./0015-always-listening-voice-loop.md) | Always-Listening Voice Loop | Accepted |
| [0016](./0016-player-character-identity-mapping.md) | Player↔Character Identity Mapping | Accepted |
| [0017](./0017-voice-assignment.md) | DM + NPC Voice Assignment | Accepted |
| [0018](./0018-streaming-stt.md) | Streaming Speech-to-Text | Accepted |
| [0019](./0019-cold-episodic-memory.md) | Cold & Episodic Memory | Accepted |
| [0020](./0020-operator-app.md) | Operator App | Accepted |
| [0021](./0021-compendium-cold-ingestion.md) | Compendium-Backed Cold Ingestion | Accepted |
| [0022](./0022-dm-action-coverage-audit.md) | DM-Action Coverage Audit (Foundry + MCP bridges) | Accepted |
| [0023](./0023-session-onboarding-presence-operator-channel.md) | Session-Start Onboarding, Voice Presence, Operator-in-Discord Channel | Accepted; §4 superseded by [0024](./0024-operator-self-designation.md) |
| [0024](./0024-operator-self-designation.md) | Operator Self-Designation (Console + Slash Command) | Accepted; supersedes §4 of [0023](./0023-session-onboarding-presence-operator-channel.md) |
| [0025](./0025-operator-control-parity.md) | Operator Control Parity (Console ↔ Slash) + Live State Sync | Accepted |
| [0026](./0026-player-dm-side-channels.md) | 1:1 Player↔DM Side-Channels (private Q&A + private actions) | Accepted |
| [0027](./0027-mcp-bridge-gap-reaudit-upstream-proposal.md) | MCP Bridge Gap Re-Audit + Upstream Proposal (extends [0022](./0022-dm-action-coverage-audit.md)) | Accepted |
| [0028](./0028-real-time-voice-latency.md) | Real-Time Voice Latency (streaming, barge-in, latency masking) | Accepted |
