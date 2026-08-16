# Technical Design Docs (TDDs)

This directory contains the **Technical Design Docs** for Skeinkeeper. Where an
[ADR](../adr/INDEX.md) captures a single architectural *decision*, a TDD captures the *design*
of a feature or subsystem — the approach, components & interfaces, data & state, sequencing,
failure modes, and requirement traceability back to the [PRD](../PRD.md).

TDDs follow the template in [`TEMPLATE.md`](./TEMPLATE.md). Each carries plain-line frontmatter
(`Status:` / `PRD refs:` / `PRD-rev:` / `ADR constraints:`), where `Status` is one of
`draft` / `ready` / `implemented`, `PRD refs` lists the [PRD](../PRD.md) requirements the
design satisfies, `PRD-rev` is the PRD commit it was designed against, and `ADR constraints`
names the accepted [ADRs](../adr/INDEX.md) it respects.

Like ADRs, TDDs are **append-only on substance**: a substantive revision is a *new* TDD that
supersedes the old one (with a `Supersedes:` line); the old one keeps its content and gets a
pointer. Draft docs may be restructured in place. See [CONTRIBUTING.md](../../CONTRIBUTING.md)
and the [ADR index](../adr/INDEX.md) for the supersede-don't-edit convention.

> **History note.** These docs were originally `docs/design/*` under a different template; they
> were retrofitted to the TDD template during the docs migration (lossless — the Telemetry /
> Privacy / Eval implications and Open-questions sections were retained). All shipped docs carry
> `Status: implemented`. Four cross-cutting decisions that previously lived inside a doc were
> promoted to ADRs during the migration: 0002→[ADR-0019](../adr/0019-per-column-pii-encryption.md),
> 0007→[ADR-0018](../adr/0018-foundry-source-of-truth.md),
> 0026→[ADR-0020](../adr/0020-single-scene-invariant.md),
> 0028→[ADR-0021](../adr/0021-cascaded-voice-not-s2s.md).

## Conventions

- Numbered sequentially from `0001`, zero-padded to 4 digits, matching the file name.
- One feature/subsystem per TDD.
- Use [`TEMPLATE.md`](./TEMPLATE.md) for new TDDs.
- TDDs are about *how a feature is built*; cross-cutting architectural decisions belong in an
  [ADR](../adr/INDEX.md).

## Index

All docs below are `Status: implemented` unless the Notes column says otherwise. Supersession notes are kept for the historical map.

| # | Title | Notes |
|---|---|---|
| [0001](./0001-telemetry-library.md) | Telemetry Library | |
| [0002](./0002-privacy-foundation.md) | Privacy Foundation | encryption decision → [ADR-0019](../adr/0019-per-column-pii-encryption.md) |
| [0003](./0003-erasure-and-export.md) | Erasure and Export | |
| [0004](./0004-eval-harness.md) | Eval Harness | |
| [0005](./0005-state-schema.md) | State Schema | parts superseded by [0007](./0007-foundry-as-source-of-truth.md) |
| [0006](./0006-tool-registry.md) | Tool Registry | |
| [0007](./0007-foundry-as-source-of-truth.md) | Foundry-as-Source-of-Truth | supersedes parts of [0005](./0005-state-schema.md); decision → [ADR-0018](../adr/0018-foundry-source-of-truth.md) |
| [0008](./0008-llm-provider-interface.md) | LLM Provider Interface | |
| [0009](./0009-behavior-spec-loader.md) | Behavior Spec Loader | |
| [0010](./0010-audio-extensible-llm-interface.md) | Audio-Extensible LLMProvider Interface | |
| [0011](./0011-orchestrator-turn-loop.md) | Orchestrator Turn Loop | |
| [0012](./0012-voice-io.md) | Voice IO — Interface, Consent, Session Loop | |
| [0013](./0013-dialogue-persistence-session-lifecycle.md) | Dialogue Persistence + Session Lifecycle | |
| [0014](./0014-mcp-foundry-client.md) | McpFoundryClient | superseded by [0041](./0041-first-party-foundry-addon.md) |
| [0015](./0015-always-listening-voice-loop.md) | Always-Listening Voice Loop | |
| [0016](./0016-player-character-identity-mapping.md) | Player↔Character Identity Mapping | |
| [0017](./0017-voice-assignment.md) | DM + NPC Voice Assignment | |
| [0018](./0018-streaming-stt.md) | Streaming Speech-to-Text | |
| [0019](./0019-cold-episodic-memory.md) | Cold & Episodic Memory | |
| [0020](./0020-operator-app.md) | Operator App | |
| [0021](./0021-compendium-cold-ingestion.md) | Compendium-Backed Cold Ingestion | |
| [0022](./0022-dm-action-coverage-audit.md) | DM-Action Coverage Audit (Foundry + MCP bridges) | superseded by [0041](./0041-first-party-foundry-addon.md) / [0042](./0042-foundry-mechanical-writes.md) |
| [0023](./0023-session-onboarding-presence-operator-channel.md) | Session-Start Onboarding, Voice Presence, Operator-in-Discord Channel | §4 superseded by [0024](./0024-operator-self-designation.md) |
| [0024](./0024-operator-self-designation.md) | Operator Self-Designation (Console + Slash Command) | supersedes §4 of [0023](./0023-session-onboarding-presence-operator-channel.md) |
| [0025](./0025-operator-control-parity.md) | Operator Control Parity (Console ↔ Slash) + Live State Sync | |
| [0026](./0026-player-dm-side-channels.md) | 1:1 Player↔DM Side-Channels (private Q&A + private actions) | single-scene invariant → [ADR-0020](../adr/0020-single-scene-invariant.md) |
| [0027](./0027-mcp-bridge-gap-reaudit-upstream-proposal.md) | MCP Bridge Gap Re-Audit + Upstream Proposal (extends [0022](./0022-dm-action-coverage-audit.md)) | superseded by [0037](./0037-bridge-dependencies-surface-model-critical-batch.md) |
| [0028](./0028-real-time-voice-latency.md) | Real-Time Voice Latency (streaming, barge-in, latency masking) | cascade-not-S2S decision → [ADR-0021](../adr/0021-cascaded-voice-not-s2s.md) |
| [0029](./0029-sealed-credential-store.md) | Sealed Credential Store | store lives in `server` (not `app`) — dep-cycle |
| [0030](./0030-pii-column-encryption.md) | Per-Column PII Encryption | supersedes ADR-0019 → [0022](../adr/0022-pii-encryption-node-crypto.md) |
| [0031](./0031-session-intake-and-intake-report.md) | Session Intake & Intake Report | draft |
| [0032](./0032-autonomous-pre-game-setup-actions.md) | Autonomous Pre-Game Setup Actions | draft |
| [0033](./0033-live-state-perception-and-triggered-actions.md) | Live State Perception & Triggered Actions | draft |
| [0034](./0034-surface-routing-and-io-abstraction.md) | Surface Routing & I/O Abstraction | draft |
| [0035](./0035-side-channels-via-foundry-whisper.md) | Side-Channels via Foundry Whisper | draft; supersedes [0026](./0026-player-dm-side-channels.md) |
| [0036](./0036-onboarding-and-foundry-user-preflight.md) | Onboarding & Foundry-User Pre-Flight | draft; supersedes [0023](./0023-session-onboarding-presence-operator-channel.md) + [0016](./0016-player-character-identity-mapping.md) |
| [0037](./0037-bridge-dependencies-surface-model-critical-batch.md) | MCP Bridge Dependencies | superseded by [0041](./0041-first-party-foundry-addon.md) |
| [0038](./0038-per-audience-erasure-cascade-to-foundry.md) | Per-Audience Erasure Cascade to Foundry | draft |
| [0039](./0039-foundry-down-session-lifecycle.md) | Foundry-Down Session Lifecycle | draft |
| [0040](./0040-operator-control-parity-foundry-chat-commands.md) | Operator Control Parity — Foundry Chat Commands | draft; supersedes [0025](./0025-operator-control-parity.md) |
| [0041](./0041-first-party-foundry-addon.md) | First-party Foundry add-on, gateway, and table-text client | draft; supersedes [0014](./0014-mcp-foundry-client.md) + [0037](./0037-bridge-dependencies-surface-model-critical-batch.md) |
| [0042](./0042-foundry-mechanical-writes.md) | Foundry mechanical writes (combat, damage, fog, tokens) | draft |
