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

### `autosetup.scene.activated` (v1)

Fires when the AI activates an unambiguous starting scene (TDD 0032).

- `campaignId: string` — campaign identifier (not a name).
- `sessionId: string` — session identifier.
- `reason: string` — `already-active` | `single-starter` | `prior-resolved`.

### `autosetup.scene.deferred` (v1)

Fires when scene activation waits on operator resolution.

- `campaignId: string` — as above.
- `sessionId: string` — as above.
- `candidateCount: number` — how many starter scenes were equally plausible.

### `autosetup.preload.created` (v1)

Fires when pre-load imported actors/items into the world.

- `campaignId: string` — as above.
- `source: string` — always `compendium` at v0.5.
- `count: number` — number of entities created. No names or Foundry IDs.

### `autosetup.preload.deferred` (v1)

Fires when pre-load skipped entries for lazy-at-trigger import.

- `campaignId: string` — as above.
- `count: number` — number of entries deferred.

### `index.run.started` (v1)

Fires when a world-content indexing run begins.

- `campaignId: string` — as above.
- `sessionId: string` — as above.

### `index.run.completed` (v1)

Fires when an indexing run finishes (including partial source failure).

- `campaignId: string` — as above.
- `sessionId: string` — as above.
- `durationMs: number` — wall-clock duration.
- `perSourceCounts: object` — `{ added, updated, deleted }` per source. No content.

### `index.run.source_failed` (v1)

Fires when one indexing source errors; other sources continue.

- `campaignId: string` — as above.
- `source: string` — `world-journal` | `world-scene` | `world-creature` | `world-actor-item`.
- `reason: string` — error class/message with no journal text or names.

### `action.place_hidden_token` (v1)

Fires when the AI attempts to place a hidden token (TDD 0033).

- `campaignId: string` — campaign identifier (not a name).
- `sceneId: string` — target scene id (not a name).
- `actorRefKind: string` — `compendium` | `actor` | `name-pack`.
- `success: boolean` — whether the placement completed.

### `action.reveal_token` (v1)

Fires when a token is revealed to the table.

- `campaignId: string` — as above.
- `success: boolean` — whether the bridge ack succeeded.

### `action.hide_token` (v1)

Fires when a token is hidden from the table.

- `campaignId: string` — as above.
- `success: boolean` — whether the bridge ack succeeded.

### `action.share_journal_to_audience` (v1)

Fires when a journal is shared to a specified audience.

- `campaignId: string` — as above.
- `audienceKind: string` — `table` | `player` | `gm`.
- `path: string` — `foundry-public-chat` | `foundry-whisper` | `gm-noop`.
- `success: boolean` — whether delivery (or the GM no-op) succeeded.

### `action.distribute_loot` (v1)

Fires when loot is distributed to actor inventories.

- `campaignId: string` — as above.
- `recipientCount: number` — number of actor recipients in the batch.
- `itemCount: number` — number of item lines attempted.
- `partialFailure: boolean` — true when any recipient or item did not succeed.

### `perception.event_stream.wired` (v1)

Fires when the Foundry event stream is wired at session start (TDD 0033). Registry name uses an underscore; TDD 0033's `perception.event-stream.wired` is the same event.

- `campaignId: string` — as above.
- `kind: string` — `null` (v0.5 production default) | `mock` | `real`.

### `surface.emit` (v1)

Fires when a registered outbound surface successfully emits (TDD 0034). Player IDs, when present, are the salted hash — never the raw Discord id.

- `surface: string` — adapter name (e.g., `foundry-public`, `discord-voice`).
- `audience: object` — `{ kind: "table" | "player" | "gm", player?: string }`. `player` is the hashed Discord id.
- `latencyMs: number` — wall-clock emit latency for that surface.

### `surface.emit.failed` (v1)

Fires when a surface emit fails, times out, or no registered surface handles the audience (`reason: "no-handling-surface"`).

- `surface: string` — adapter name, or `(none)` when no surface handled the audience.
- `audience: object` — as `surface.emit`.
- `reason: string` — `timeout`, `no-handling-surface`, or the error message. No content.

### `surface.input` (v1)

Fires when the router yields an inbound surface event. Kind only; no utterance or command text.

- `surface: string` — adapter name (e.g., `foundry-public`).
- `kind: string` — event kind (e.g., `chat.public`, `voice.utterance`).

### `surface.command.parsed` (v1)

Fires when a `/skeinkeeper` Foundry chat command is parsed. Verb only — args can contain Discord IDs.

- `verb: string` — the first token after `/skeinkeeper`.
- `ok: boolean` — whether the verb and args were recognized.

### `preflight.identity.ran` (v1)

Fires when the 3-way identity pre-flight verifier runs (TDD 0036). Counts only; no player IDs.

- `trigger: string` — `start` | `voice-join` | `operator-command`.
- `playerCount: number` — expected players in the check.
- `findingCount: number` — total findings.
- `criticalCount: number` — critical findings.

### `preflight.identity.finding` (v1)

Fires once per identity finding. Kind and severity only — no player IDs.

- `kind: string` — finding kind (e.g. `no-foundry-user`).
- `severity: string` — `critical` | `warning` | `info`.

### `preflight.identity.blocked-start` (v1)

Fires when Start is blocked by critical identity findings.

- `criticalCount: number` — number of critical findings that blocked Start.

### `presence.foundry.dropped` (v1)

Fires when a previously-active Foundry user goes inactive.

- `foundryUserIdHashed: string` — salted hash of the Foundry user id.

### `presence.foundry.restored` (v1)

Fires when an inactive Foundry user comes back online.

- `foundryUserIdHashed: string` — salted hash of the Foundry user id.

### `escalation.notify-operator` (v1)

Fires when `notify_operator` emits. No content.

- `severity: string` — `info` | `warning` | `critical`.

### `identity.player-character.recorded` (v1)

Fires when `record_player_character` writes a map row.

- `source: string` — `player` | `operator`.
- `hasFoundryUser: boolean` — whether a Foundry user was bound at record-time.

### `erasure.completed` (v1)

Fires when an erasure run finishes (TDD 0003 / TDD 0038). No subject IDs.

- `scope: string` — `player` | `campaign` | `tenant`.
- `totalRecords: number` — sum of per-adapter `recordsDeleted`.
- `adapterCount: number` — adapters that ran for the scope.

### `erasure.partial-success` (v1)

Fires when at least one adapter returned a manual remainder (TDD 0038). Reasons only — no Foundry or Discord IDs.

- `scope: string` — as `erasure.completed`.
- `remainderCount: number` — number of remainders.
- `reasons: string[]` — deduped remainder reasons (`no-foundry-user-mapped`, `addon-unavailable`, `foundry-call-failed`, …).

### `erasure.adapter.failed` (v1)

Fires once per adapter that returned a manual remainder.

- `adapter: string` — adapter name (e.g. `foundry-whisper`).
- `reason: string` — remainder reason. No IDs.
