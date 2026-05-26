# ADR Index

> Only `accepted` ADRs are binding constraints for new TDDs. Superseded ADRs are kept for the
> historical record but do not bind new design work.

This directory holds the Architecture Decision Records (ADRs) for Skeinkeeper. Each ADR captures
one significant architectural choice — the **context** that forced it, the **decision**, and the
**consequences**.

**Conventions:**

- Numbered sequentially from `0001`, zero-padded to 4 digits, matching the file name.
- One decision per ADR; ADRs are short (most fit on a screen).
- ADRs are about *architecture*, not behavior — DM behavior lives in
  [`/behavior/default.md`](../../behavior/default.md).
- **Append-only on substance.** Once accepted, an ADR's Context/Decision/Consequences are a
  historical record. Editorial touch-ups (typos, links, status flips) are fine; a substantive
  change is a *new* superseding ADR that sets the old one's status to `superseded by NNNN`. Never
  rewrite an accepted decision in place. See [CONTRIBUTING.md](../../CONTRIBUTING.md).
- New ADRs carry `Status:` / `Date:` / `Scope:` frontmatter (the four most recent — 0018–0021
  — use this form). The `Scope` is used by this index and for matching ADRs to relevant TDDs.

| #    | Title                                                              | Status                              | Scope               |
|------|-------------------------------------------------------------------|-------------------------------------|---------------------|
| [0001](./0001-use-foundry-mcp-for-vtt.md) | Use the Foundry MCP module for VTT integration | superseded by [0011](./0011-prefer-oss-foundry-mcp-bridges.md) | vtt-integration |
| [0002](./0002-four-tier-memory-model.md) | Four-tier memory model (hot / warm / cold / episodic) | accepted (warm-tier refined by [0013](./0013-warm-tier-after-foundry-source-of-truth.md)) | memory |
| [0003](./0003-tool-call-only-state-mutation.md) | All state mutations occur via typed tool calls | accepted | state-mutation |
| [0004](./0004-plugin-interface-pattern.md) | Plugin interfaces for LLM / Ruleset / VTT / Voice | accepted (Ruleset superseded by [0012](./0012-drop-ruleset-plugin-interface.md)) | plugin-architecture |
| [0005](./0005-apache-2-license.md) | Apache License 2.0 | accepted | licensing |
| [0006](./0006-behavior-spec-separate-doc.md) | DM Behavior Spec lives in a separately-versioned document | accepted | behavior-spec |
| [0007](./0007-phandelver-content-operator-supplied.md) | Commercial campaign content stays operator-supplied | accepted | content-licensing |
| [0008](./0008-tenant-scoping.md) | Tenant scoping in the data model | accepted | data-model |
| [0009](./0009-telemetry-opt-in.md) | Telemetry off by default, opt-in only | accepted | telemetry |
| [0010](./0010-privacy-as-architecture.md) | Privacy as architecture, not operational commitment | accepted | privacy |
| [0011](./0011-prefer-oss-foundry-mcp-bridges.md) | Prefer fully-OSS Foundry MCP bridges | accepted | vtt-integration |
| [0012](./0012-drop-ruleset-plugin-interface.md) | Drop the `Ruleset` plugin interface | accepted | plugin-architecture |
| [0013](./0013-warm-tier-after-foundry-source-of-truth.md) | Warm-tier state after Foundry-as-source-of-truth | accepted | memory |
| [0014](./0014-episodic-memory-campaign-scoped-erasure.md) | Episodic memory is campaign-scoped (erasure not per-player) | accepted (refined by [0017](./0017-per-audience-memory-visibility-erasure.md)) | memory/privacy |
| [0015](./0015-operator-pregame-ai-performs-in-play-dm-actions.md) | Operator configures pre-game; Skeinkeeper performs all in-play DM actions | superseded by [0023](./0023-operator-as-host-model.md) | operator-model |
| [0016](./0016-operator-control-parity-across-surfaces.md) | Operator controls have parity across console and Discord, via one write path | accepted | operator-controls |
| [0017](./0017-per-audience-memory-visibility-erasure.md) | Per-audience memory visibility & erasure | accepted | memory/privacy |
| [0018](./0018-foundry-source-of-truth.md) | Foundry is the authoritative source of truth for mechanical state | accepted | state-ownership |
| [0019](./0019-per-column-pii-encryption.md) | Per-column AEAD encryption for PII, keyed from OS keyring | superseded by [0022](./0022-pii-encryption-node-crypto.md) | privacy |
| [0020](./0020-single-scene-invariant.md) | Single shared scene invariant (no party-splitting) | accepted | session-model |
| [0021](./0021-cascaded-voice-not-s2s.md) | Cascaded voice architecture, not speech-to-speech | accepted | voice-architecture |
| [0022](./0022-pii-encryption-node-crypto.md) | Per-column PII encryption via Node-crypto AEAD, keyed from the sealed-secret passphrase | accepted (supersedes [0019](./0019-per-column-pii-encryption.md)) | privacy |
| [0023](./0023-operator-as-host-model.md) | Operator-as-host model (host pre-flight only; AI does all DM work including pre-game setup) | accepted (supersedes [0015](./0015-operator-pregame-ai-performs-in-play-dm-actions.md)) | operator-model |
| [0024](./0024-silence-is-success-operator-escalation.md) | Silence is success — operator escalation discipline (autonomous-by-default; degrade silently; escalate on critical gap / ambiguity / judgment call only) | accepted | operator-controls |
