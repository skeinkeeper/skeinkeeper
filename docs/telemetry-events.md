# Telemetry Events

This document is the human-readable companion to `telemetry/src/events.ts`. Every event in the code registry has a section here; CI fails if either side is missing an entry.

Both telemetry streams are **off by default** per [ADR-0009](./adr/0009-telemetry-opt-in.md). The events below describe what _would_ be sent if the operator opts in.

## Conventions

- **Name** is `namespace.event`, lowercase, dot-separated.
- **Version** is a major-version integer that bumps when the payload shape changes incompatibly.
- **Payload** lists every field with its type and what it means. No field is ever PII; the type system rejects PII-branded values at compile time.
- **When it fires** is the trigger event — typically a single, named moment in the codebase.

## Events

### `app.started` (v1)

Fires once at process boot, after configuration loads and before the orchestrator begins accepting work.

- `version: string` — Skeinkeeper semver string from `packages/core`.
- `nodeVersion: string` — Node runtime version reported by `process.version`.

### `session.started` (v1)

Fires when an RPG session begins for a campaign.

- `campaignIdHash: string` — opaque hash of the campaign ID, stable per-installation so events for the same campaign can be correlated; never reversible to a campaign name or operator identity.
- `rulesetId: string` — the active ruleset's plugin ID (e.g., `dnd5e`).

### `session.ended` (v1)

Fires when an RPG session ends, whether normally or via abort.

- `campaignIdHash: string` — as above.
- `durationSecBucket: string` — coarse bucket (`<15m`, `15-60m`, `1-2h`, `2-4h`, `>4h`) rather than a precise duration.
- `turnCount: number` — total turns processed in the session.

### `tool.called` (v1)

Fires once per tool dispatch by the orchestrator. May be sampled at high call rates.

- `toolName: string` — registered tool name (e.g., `roll`, `apply_damage`).
- `success: boolean` — whether the tool returned without throwing.
- `latencyMsBucket: string` — coarse bucket (`<50`, `<250`, `<1000`, `<5000`, `>=5000`).

### `error.captured` (v1)

Fires when an unexpected error is captured for crash reporting. Crash stream only.

- `errorClass: string` — error constructor name (e.g., `TypeError`, `FoundryConnectionError`).
- `module: string` — module where the error originated (e.g., `orchestrator/tools`, `plugins/vtt-foundry`).

### `llm.completed` (v1)

Fires once per LLM completion (per `LLMProvider.complete()` call) when the stream terminates with a `done` or `error` event. No PII, no prompt content, no exact token counts.

- `providerName: string` — registered provider name (e.g., `anthropic`, `fake`). Not the model ID — operators who want exact model/cost data read their provider's billing dashboard.
- `modelTier: string` — `narration` or `orchestration`. Lets maintainers see which tier is exercised in practice.
- `success: boolean` — whether the stream terminated with `done` (true) or `error` (false).
- `stopReason: string` — mapped from `StopReason`: `end_turn`, `tool_use`, `max_tokens`, `compacted`, `refusal`, or `error` on failure.
- `inputTokensBucket: string` — coarse bucket (`<500`, `<2000`, `<10000`, `<50000`, `>=50000`).
- `outputTokensBucket: string` — same buckets as input.
- `cacheReadTokensBucket: string` — same buckets; tells us whether prompt caching is working in practice.
- `durationMsBucket: string` — coarse bucket (`<500`, `<2000`, `<10000`, `<30000`, `>=30000`).

### `behavior_spec.loaded` (v1)

Fires once per session when the Behavior Spec is loaded. Lets maintainers see which spec versions opted-in operators are running.

- `version: string` — the spec's parsed version, e.g., `v0.1`. No content from the spec is sent — only the version label.
- `sizeKbBucket: string` — coarse bucket (`<5`, `<15`, `<50`, `>=50`); guards against spec bloat without revealing content shape.

### `intake.minimum.started` (v1)

Fires when minimum session intake begins (TDD 0031).

- `campaignId: string` — campaign identifier (not a name).
- `sessionId: string` — session identifier.

### `intake.minimum.completed` (v1)

Fires when minimum session intake finishes.

- `campaignId: string` — as above.
- `sessionId: string` — as above.
- `durationMs: number` — wall-clock duration of the minimum pass.
- `criticalCount: number` — number of critical-gap findings.

### `intake.extended.completed` (v1)

Fires when extended session intake finishes.

- `campaignId: string` — as above.
- `sessionId: string` — as above.
- `durationMs: number` — wall-clock duration of the extended pass.
- `ambiguityCount: number` — ambiguity findings produced.
- `recommendationCount: number` — recommendation findings produced.

### `intake.finding.surfaced` (v1)

Fires once per finding delivered to the operator.

- `campaignId: string` — as above.
- `sessionId: string` — as above.
- `findingCode: string` — closed FindingCode (no names or Foundry IDs).
- `kind: string` — `critical-gap` | `ambiguity` | `recommendation`.
- `dmOnly: boolean` — whether the finding was framed as DM-only.

### `intake.finding.resolved` (v1)

Fires when the operator resolves a finding.

- `campaignId: string` — as above.
- `sessionId: string` — as above.
- `findingCode: string` — closed FindingCode.
- `resolutionId: string` — chosen option id (not a display name).
- `latencyMs: number` — time from persist/create to resolve.

### `intake.gate.blocked` (v1)

Fires when `announceReady` is blocked by unresolved critical findings.

- `campaignId: string` — as above.
- `sessionId: string` — as above.
- `blockingFindings: string[]` — FindingCode values that are still blocking.
