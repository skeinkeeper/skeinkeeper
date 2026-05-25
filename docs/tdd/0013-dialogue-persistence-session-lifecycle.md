# TDD 0013: Dialogue Persistence + Session Lifecycle (Phase 2c)
Status: implemented
PRD refs: 4.3, 5.1
PRD-rev: 10391ba
ADR constraints: 0008, 0009, 0010
Author: maintainers
Date: 2026-05-19
Related TDDs: [0003 (erasure + export)](./0003-erasure-and-export.md), [0011 (orchestrator turn loop)](./0011-orchestrator-turn-loop.md), [0012 (voice IO)](./0012-voice-io.md)

## Approach

Phase 2a's `Session` kept its dialogue history in memory and was explicit (doc 0011) about deferring persistence to "Phase 2c, when restart-resilience matters." This phase delivers it: dialogue persists to the database, sessions have a lifecycle (start/end) that emits the `session.started`/`session.ended` telemetry events from the registry, and the new persistent store gets its mandatory erasure path (ADR-0010, hard rule #8).

## Components & interfaces

### `dialogue` table

```ts
// server/src/schema/dialogue.ts
dialogue: {
  id, tenantId, sessionId (FK → sessions, cascade),
  speaker, displayName?, text, timestamp
}
// indexes: (tenant, session, timestamp); (tenant, speaker)
```

One row per turn of speech (player, operator, system, or `narrator` for the AI). FK-cascades from `sessions` (which cascades from `campaigns`), so campaign-scoped erasure flows down automatically. The `(tenant, speaker)` index supports player-scoped erasure.

### `TenantDb.dialogue` accessor

`append(entry)` and `listBySession(sessionId)` (ordered by timestamp, id). Tenant-scoped per ADR-0008.

### Session lifecycle: `startSession` / `endSession`

- **`startSession(config)`** — creates the persisted `sessions` row (idempotent: skips if it exists, enabling resume), hydrates the in-memory `Session.dialogue` from any prior persisted turns, and emits `session.started { campaignIdHash, rulesetId }`. This is now the proper entry point before `runTurn`, because `runTurn` writes dialogue rows that FK-reference the session row.
- **`endSession(session, summaryJson?)`** — stamps `endedAt`, stores an optional post-session summary, and emits `session.ended { campaignIdHash, durationSecBucket, turnCount }`.

`Session` gains a `turnCount` field, incremented per turn, surfaced in `session.ended`.

### `runTurn` persists dialogue

Each turn now writes two dialogue rows: the player's input (on entry) and the AI's narration as a `narrator` turn (on exit, if non-empty). The narrator turn is also pushed to the in-memory dialogue so the *next* turn's hot context includes what the AI just said — fixing a Phase 2a gap where the AI's prior responses weren't visible in subsequent turns' context.

### Erasure + export: `DialogueAdapter`

New `DialogueAdapter` (DeletionAdapter + ExportAdapter):
- **player scope**: deletes/exports rows where `speaker = subjectId` (a player's own lines across all sessions).
- **tenant scope**: all dialogue for the tenant.
- **campaign scope**: not claimed — FK cascade from campaign deletion handles it.

While wiring this in, a pre-existing gap surfaced: `cli.ts` only registered the `ConsentsAdapter`, so `campaign:delete` and audit-log erasure silently no-op'd. Fixed: the CLI now registers all four adapters (consents, campaign, audit-log, dialogue) for erasure, and the two that implement `ExportAdapter` (consents, dialogue) for export.

## Data & state

The `dialogue` table schema is described fully in Components & interfaces above. FK-cascades ensure that campaign erasure automatically removes all dialogue rows without requiring the `DialogueAdapter` to claim campaign scope.

## Sequencing / implementation plan

Covered under Approach and Components & interfaces.

## Failure modes & edge cases

- **`startSession` called twice for the same session ID:** idempotent — skips row creation if already exists, enabling session resume without error.
- **`cli.ts` pre-existing gap fixed:** all four adapters now registered so erasure operations no longer silently no-op.
- **Narrator turn persisted but narration is empty:** skipped (only non-empty narration is persisted as a `narrator` row).

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
|---------|-------------|--------------|
| 4.3 | Session capabilities — recap generation, session-lifecycle signals | `startSession`/`endSession` lifecycle; `session.started`/`session.ended` telemetry events with real firing sites; `summaryJson` accepted by `endSession` (generation is Phase 4) |
| 4.3 | Persistent state and memory across sessions | `dialogue` table with FK-cascade from sessions; `startSession` hydrates in-memory dialogue from prior persisted turns (resume); narrator turns persisted so multi-turn context is complete |
| 5.1 | Memory architecture — warm tier; episodic tier; four-tier model | `dialogue` table is the session-transcript store; narrator rows feed subsequent turns' hot context (sliding window); episodic tier (post-session summaries) scaffolded by `endSession(summaryJson)` |

## Dependencies considered

None — no new third-party dependency introduced by this design.

## PRD conflicts surfaced (and resolution)

None — this design implements the dialogue persistence and session lifecycle that Phase 2a explicitly deferred. Consistent with ADR-0008 (tenant scoping), ADR-0009 (telemetry), and ADR-0010 (privacy/erasure). No PRD requirement proved infeasible or contradictory.

## Decisions to promote (ADR candidates)

None — the durable decisions are already captured: tenant scoping (ADR-0008), privacy as architecture (ADR-0010), telemetry opt-in (ADR-0009).

## Alternatives considered

- **Store dialogue as a JSON blob on the session row.** Rejected — not queryable for player-scoped erasure (can't `DELETE WHERE speaker = X`), and grows unboundedly in a single column.
- **Reconstruct dialogue from the audit log instead of a dedicated table.** The audit log stores a *hash* of player text (doc 0011), not the text, precisely so the audit log isn't a second copy of PII. So it can't reconstruct dialogue. A dedicated, erasable table is the right home for transcripts.
- **Don't persist narrator turns (only player input).** Rejected — then the AI can't see its own prior responses, breaking multi-turn continuity. The narrator turn is essential context.

## Telemetry implications

No new events. `session.started` and `session.ended` (registered since Phase 0.1) now have real firing sites in `startSession`/`endSession`. The `campaignIdHash` uses a plain SHA-256 prefix today; a salted, installation-stable hash is a follow-up (telemetry is off by default, so low urgency).

## Privacy implications

The `dialogue` table is the "session transcripts" that `docs/PRIVACY.md` already lists under "what Skeinkeeper stores." This phase implements that store and its erasure path:

- **PII:** `speaker` (Discord ID) and `text` (what was said). Tenant-scoped; covered by the `DialogueAdapter` for player + tenant erasure and by FK cascade for campaign erasure.
- **Deletion path:** `skeinkeeper player:delete <id>` now removes that subject's dialogue lines (the adapter is registered in the CLI). `docs/PRIVACY.md`'s deletion-cascade description is updated to name transcripts/dialogue.
- **No audio persisted:** dialogue stores transcribed text only, never audio (consistent with doc 0012 and PRIVACY.md's "audio is discarded immediately").

## Eval implications

None new. `runTurn`/`startSession`/`endSession` persistence is covered by `session.test.ts` (5 new tests: session-row creation, dialogue-row persistence, turnCount, resume/hydration, endSession). The `DialogueAdapter` erasure + export paths are covered by `dialogue-adapter.test.ts` (5 tests including the FK-cascade case), satisfying hard rule #8/#12's deletion-path-test requirement.

## Open questions

- **Summary generation.** `endSession` accepts a `summaryJson` but doesn't generate it — post-session summarization (the episodic-memory seed) is Phase 4 (cold/episodic tier). For now the operator or a future job supplies it.
- **Dialogue retention / pruning.** Long campaigns accumulate many dialogue rows. A retention policy (or roll-up into episodic summaries) is a Phase 4 concern.
- **Salted telemetry hashing.** `campaignIdHash` should use a per-installation salt for true non-reversibility; deferred.
