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
