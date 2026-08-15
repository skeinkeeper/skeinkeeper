# TDD 0038: Per-Audience Erasure Cascade to Foundry Whispers

Status: draft
PRD refs: 5.5
PRD-rev: 5c3a198
ADR constraints: 0008, 0010, 0014, 0017, 0018, 0023, 0025, 0029, 0030
Supersedes: [TDD 0003](./0003-erasure-and-export.md)
Author: maintainers
Date: 2026-05-26
Related TDDs: [0013 (dialogue persistence)](./0013-dialogue-persistence-session-lifecycle.md), [0019 (cold/episodic memory)](./0019-cold-episodic-memory.md), [0030 (PII column encryption)](./0030-pii-column-encryption.md), [0034 (surface routing & I/O abstraction)](./0034-surface-routing-and-io-abstraction.md), [0035 (side-channels via Foundry whisper)](./0035-side-channels-via-foundry-whisper.md), [0036 (onboarding + Foundry-user pre-flight)](./0036-onboarding-and-foundry-user-preflight.md), [0041 (first-party Foundry add-on)](./0041-first-party-foundry-addon.md)

## Carries forward / supersedes (read first)

This TDD supersedes [TDD 0003](./0003-erasure-and-export.md) (Erasure and Export) because the PRD revision named in `PRD-rev` extends per-player erasure beyond Skeinkeeper-side stores into Foundry-side whisper history. Append-only discipline (TDD 0003 was `implemented`) requires a new document; this is it.

**Carried forward from TDD 0003 unchanged:**

- The **`ErasureScope` discriminated union** (`player` / `campaign` / `tenant`).
- The **`DeletionAdapter` interface** (`name`, `supportedScopes`, `delete(scope)`).
- The **`ErasureService`** + the **`ErasureReport`** shape (per-adapter records-deleted count; total).
- The **`ExportAdapter` / `ExportService` symmetric pair** + the JSON+HTML export payload shape.
- The **CLI commands** (`player:delete`, `player:export`, `campaign:delete`, `campaign:export`, `tenant:delete`); default `--tenant default`; `--yes` to skip confirmation prompts.
- The **`deletion_log` audit table** (salted hash of subject; per-installation salt in `data/.salt`).
- The **contributor hard rule** (any PR adding persistent storage must register a `DeletionAdapter`).

**New / substantively extended in this TDD:**

- A **`FoundryWhisperDeletionAdapter`** that participates in the existing `ErasureService.erase(scope)` flow with `supportedScopes: ["player"]`. It calls `FoundryClient.deleteChatMessages` (TDD 0041) filtered by recipient = the player's Foundry user, removing the player's whisper history from Foundry.
- The **`ErasureReport` shape gains a `partialSuccess` flag and a `manualRemainders` array** to carry per-adapter "your erasure isn't fully complete; here's what's left" information when an adapter cannot fully delete (typically because Foundry is unreachable).
- The **CLI exits non-zero (exit code 2) when `partialSuccess` is true**, so an operator running `skeinkeeper player:delete --tenant ... --subject ... --yes` in a script gets a noisy signal that operator action is still required.
- The **HTML export summary + the deletion-success summary** are extended to render the manual-remainder lines so the operator can hand the player a complete, honest account ("we removed X; here's Y you may want to manually verify in Foundry").
- A **`FoundryWhisperExportAdapter`** is NOT shipped in this TDD's scope (export is read-from-Foundry; Foundry's chat log export is a Foundry-native operation; the operator can use Foundry's own export). Acknowledging the asymmetry: erasure cascades to Foundry; export doesn't. Reasoning under §"Failure modes."

## Approach

The shipped `ErasureService` is structurally correct. Its adapter pattern was designed exactly for this: a new store gets a new adapter; the service orchestrates across all registered adapters; the deletion log captures the audit trail. The new requirement (cascade to Foundry whisper history) is a new participant in that flow, not a redesign.

What this TDD has to get right is **honest reporting when the cascade can't fully complete.** The PRD §5.5 says per-player erasure "deletes both the Skeinkeeper-side dialogue store _and_ the corresponding Foundry whisper history." If the Foundry side fails — add-on unavailable, `deleteChatMessages` error, Foundry temporarily disconnected — Skeinkeeper has three honest options: (a) fail the entire erasure, (b) partial-success with the remainder named, or (c) silently complete Skeinkeeper-side and hide the Foundry remainder. The design-pass decision (recorded in interview) chose (b): **partial-success with explicit "Foundry-side manual cleanup required" remainders in the report, CLI exit non-zero so the operator notices.** This is the more honest of the three options that's still usable; (a) makes erasure unrunnable when Foundry is down (a real operator concern at v0.5), and (c) lies to the operator (and to the player who asked for erasure).

The Skeinkeeper-side erasure (all the adapters from 0003) completes regardless of bridge state. The Foundry-side cascade attempts and reports its outcome.

### 1. The new adapter

```ts
// server/src/adapters/foundry-whisper-deletion.ts
export class FoundryWhisperDeletionAdapter implements DeletionAdapter {
  readonly name = "foundry-whisper";
  readonly supportedScopes: ReadonlyArray<ErasureScope["kind"]> = ["player"];

  constructor(
    private foundry: FoundryClient,
    private identityMap: PlayerCharacterMapStore, // TDD 0036's 3-way map
    private connected: boolean, // TDD 0041 hello-ok is live
  ) {}

  async delete(scope: ErasureScope): Promise<DeletionAdapterResult> {
    if (scope.kind !== "player") return { recordsDeleted: 0 };

    // Resolve the player's Foundry user via the 3-way map (TDD 0036).
    const row = await this.identityMap.currentForPlayer({
      tenantId: scope.tenantId,
      discordUserId: scope.subjectId,
    });
    const foundryUserId = row?.foundryUserId;
    if (!foundryUserId) {
      return {
        recordsDeleted: 0,
        manualRemainder: {
          reason: "no-foundry-user-mapped",
          message: `No Foundry user is mapped to Discord user ${scope.subjectId}; if this player had any Foundry whisper history, you must manually delete it via Foundry's GM chat-log UI.`,
        },
      };
    }

    if (!this.connected) {
      return {
        recordsDeleted: 0,
        manualRemainder: {
          reason: "addon-unavailable",
          foundryUserId,
          message: `The Skeinkeeper Foundry add-on is not connected. Whisper history for Foundry user ${foundryUserId} must be deleted via Foundry's GM chat-log UI, or retry player:delete when Foundry is back.`,
        },
      };
    }

    // By-recipient deletes the player's whispers (where they were the recipient);
    // by-author deletes whispers where they were the author. Both belong to "this player's whisper history."
    try {
      const recipientResult = await this.foundry.deleteChatMessages({
        scope: "by-recipient",
        recipientFoundryUserId: foundryUserId,
      });
      const authorResult = await this.foundry.deleteChatMessages({
        scope: "by-author",
        authorFoundryUserId: foundryUserId,
      });
      return { recordsDeleted: recipientResult.deletedCount + authorResult.deletedCount };
    } catch (err) {
      return {
        recordsDeleted: 0,
        manualRemainder: {
          reason: "foundry-call-failed",
          foundryUserId,
          message: `Foundry whisper deletion failed: ${err.message}. Retry via \`skeinkeeper player:delete --subject ${scope.subjectId} --yes\` once Foundry/bridge connectivity is restored, OR manually delete via Foundry's GM chat-log UI.`,
        },
      };
    }
  }
}
```

The adapter's `delete` returns either a count (success) or a `manualRemainder` object (partial). The `DeletionAdapter` interface is extended:

```ts
// orchestrator/interfaces/deletion-adapter.ts (extending TDD 0003)
export interface DeletionAdapterResult {
  recordsDeleted: number;
  manualRemainder?: ManualRemainder;
}

export interface ManualRemainder {
  reason: "no-foundry-user-mapped" | "addon-unavailable" | "foundry-call-failed" | string;
  foundryUserId?: string;
  message: string; // operator-readable
}

export interface DeletionAdapter {
  readonly name: string;
  readonly supportedScopes: ReadonlyArray<ErasureScope["kind"]>;
  delete(scope: ErasureScope): Promise<DeletionAdapterResult>; // CHANGED: was Promise<number>
}
```

All existing adapters (TDD 0003 + every adapter shipped since) need a one-line return-shape update: `return n;` → `return { recordsDeleted: n };`. Mechanical migration; no behavior change for adapters that always fully delete.

### 2. The new `ErasureReport`

```ts
// orchestrator/erasure/types.ts (extending TDD 0003)
export interface ErasureReport {
  scope: ErasureScope;
  perAdapter: ReadonlyArray<{
    adapter: string;
    recordsDeleted: number;
    manualRemainder?: ManualRemainder;
  }>;
  totalRecords: number;
  partialSuccess: boolean; // NEW: true iff any adapter returned a manualRemainder
  manualRemainders: ReadonlyArray<ManualRemainder>; // NEW: aggregated for convenient rendering
}
```

`ErasureService.erase` aggregates per-adapter results, sets `partialSuccess: manualRemainders.length > 0`, and emits an additional `erasure.partial-success` telemetry event when applicable (see §Telemetry).

### 3. CLI behavior change

- **`skeinkeeper player:delete`** prints the deletion summary in stdout. When `partialSuccess: true`:
  - stdout includes one line per manual remainder, prefixed with `WARNING:`.
  - The CLI exits with **exit code 2** (success-with-warnings). Exit codes: `0` = clean success, `1` = error (no deletion happened), `2` = partial success (some adapters reported remainders).
- **`skeinkeeper player:export`** is unchanged in behavior; export adapters don't change (export is read-from-source, where the source is Skeinkeeper's stores). The HTML summary page is updated to include a "Foundry-side data not exported" section pointing the operator at Foundry's own export tools, which is a documentation completeness improvement orthogonal to the cascade.

The CLI prompt-on-no-`--yes` behavior is unchanged.

### 4. The `deletion_log` change

The `deletion_log` row format gains a `partial_success` boolean column and a `manual_remainders` JSON column (operator-readable; not encrypted because it contains the operator's own audit info, not a player's PII).

```sql
-- server/migrations/NNNN-deletion-log-partial-success.sql
ALTER TABLE deletion_log ADD COLUMN partial_success INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deletion_log ADD COLUMN manual_remainders TEXT;  -- JSON array; nullable
```

Existing rows have `partial_success = 0` and `manual_remainders = NULL` post-migration (defaults), which is correct — pre-cascade erasures were fully-Skeinkeeper-side and complete by construction.

### 5. The contributor hard rule extension

CONTRIBUTING.md (extending the rule from TDD 0003): adapters MAY return `DeletionAdapterResult.manualRemainder` instead of `recordsDeleted` only when full deletion is genuinely impossible within the adapter's scope (i.e., the store is not Skeinkeeper-controlled). Adapters over Skeinkeeper-owned stores (SQLite tables, LanceDB collections, files in `data/`) MUST always fully delete; a `manualRemainder` from such an adapter is a bug, not a runtime condition.

### 6. PRIVACY.md update

PRIVACY.md is updated by this TDD's commit (together with TDD 0035's commit and TDD 0036's commit — three TDDs revise one privacy story). The deletion paragraph names:

- **Skeinkeeper-side:** dialogue store (audience-tagged per ADR-0017), episodic memory (per-player exclusion per ADR-0017 / 0014), identity map (TDD 0036), audit logs (per-adapter delete).
- **Foundry-side:** whisper history for the player's Foundry user, deleted via FoundryClient.deleteChatMessages when the add-on is connected; manual operator action required as a remainder when not.
- **Partial-success transparency:** the deletion report is delivered to the operator with manual-remainder lines; the operator can hand the affected player the HTML summary which lists what was deleted and what remains.

## Components & interfaces

```ts
// orchestrator/interfaces/deletion-adapter.ts
export interface DeletionAdapterResult {
  recordsDeleted: number;
  manualRemainder?: ManualRemainder;
}
export interface ManualRemainder {
  reason: string;
  foundryUserId?: string;
  message: string;
}

// orchestrator/erasure/service.ts
export class ErasureService {
  register(adapter: DeletionAdapter): void;
  erase(scope: ErasureScope): Promise<ErasureReport>;
}

// server/src/adapters/foundry-whisper-deletion.ts
export class FoundryWhisperDeletionAdapter implements DeletionAdapter {
  /* ... */
}
```

Registration in `server/src/cli.ts` (alongside the existing adapter registrations):

```ts
service.register(new FoundryWhisperDeletionAdapter(foundry, identityMap, capabilities));
```

CLI erase checks that a Foundry add-on is connected (same hello-ok as TDD 0041). If not, Foundry-side delete is recorded as addon-unavailable.

## Data & state

Schema changes: `deletion_log` adds `partial_success` (INTEGER, default 0) + `manual_remainders` (TEXT JSON, nullable). No other schema changes.

In-memory state: the `ErasureService` is constructed per-invocation (CLI process or a future web-UI handler); not persisted.

## Sequencing / implementation plan

1. **`DeletionAdapter` interface extension** (return type → `DeletionAdapterResult`). Mechanical updates to every existing adapter (one line each).
2. **`ErasureReport` extension** (`partialSuccess` + `manualRemainders` aggregation).
3. **`deletion_log` schema migration.**
4. **`FoundryWhisperDeletionAdapter`** + unit tests (per failure-mode branch: no-mapping, addon-unavailable, foundry-call-failed, success).
5. **CLI exit-code change** + summary rendering of manual remainders. Unit-tested via the CLI's existing test harness.
6. **CLI connection check** for `player:delete` runs outside an active session (so a standalone `skeinkeeper player:delete` knows whether the add-on is connected).
7. **HTML export summary** addition of the "Foundry-side data not exported" pointer paragraph.
8. **PRIVACY.md update** (co-shipped with TDD 0035 + 0036; one PR's commit; honors the docs-update-alongside-code rule per CLAUDE.md hard rule #15).
9. **CONTRIBUTING.md update** (the manualRemainder-only-for-external-stores extension to the existing hard rule).
10. **Eval / live verification** per §Verification plan.

## Failure modes & edge cases

- **Bridge cap unavailable at deletion time.** Adapter returns `manualRemainder { reason: "addon-unavailable" }`. CLI summary names this; exit 2.
- **Bridge cap available but Foundry instance is down.** `deleteChatMessages` rejects with a transport error. Adapter returns `manualRemainder { reason: "foundry-call-failed" }`. CLI summary names this; exit 2; operator retries when Foundry is back.
- **Player has no Foundry user mapped** (their identity-map row's `foundryUserId` is NULL). Adapter returns `manualRemainder { reason: "no-foundry-user-mapped" }`. The Foundry side has nothing to delete _for that player_ — the player never had a Foundry user to write whispers as or to. But Skeinkeeper-side erasure still completes. Exit 2 for honesty, but the operator's manual action is essentially "verify no whispers exist" rather than "delete X."
- **Player has multiple Foundry users mapped over the campaign's lifetime** (operator re-mapped). The current row is what `currentForPlayer` returns; only that user's whispers are deleted by the cascade. If older Foundry users existed, their whispers are remainders. Recommendation: rare in practice; document as a known limitation in PRIVACY.md ("if a player's Foundry user was changed during the campaign, the operator may need to delete the prior user's whispers manually"). Tracked as a future enhancement (the identity-map history table would give us the full mapping; v0.5 is current-only).
- **`delete-chat-messages` deletes more than expected** (e.g., the add-on interprets `by-recipient` as "messages where the user is _any_ recipient" including group whispers). The integration test against a real Foundry validates the exact semantic; if deleteChatMessages semantics don't match the expected ones, the cascade is over-deleting OR under-deleting. We use Skeinkeeper's deletion-log + Foundry's native chat-log persistence to spot mismatches.
- **A player's identity map is partially erased — the `playerCharacterMap` row deletion happens BEFORE the `FoundryWhisperDeletionAdapter` runs.** Order of adapter execution matters. The fix: the `FoundryWhisperDeletionAdapter`'s `currentForPlayer` call reads the map BEFORE any adapter runs (the `ErasureService` orchestrates this — adapter reads happen in a snapshot taken at the start of `erase`, not concurrently). Implementation detail: snapshot the identity map at `erase` entry; pass to each adapter rather than letting each adapter re-query the (potentially mutated) map.
- **Erasure invoked during an active session.** The session-Coordinator's open conversations referencing the player's whispers continue to be in-memory until the session ends. The deletion log captures the on-disk + Foundry-side delete; in-memory hot context for that turn is the only place the data might still be — Coordinator's per-conversation hot context is invalidated on dialogue-store changes (a separate concern owned by the dialogue persistence layer; if not currently invalidated on delete, the in-memory cache will be stale until session restart). Recommendation for v0.5: operator-facing CLI warning when running erasure during an active session, advising restart. Long-term: the dialogue store's delete fires an in-process invalidation event the Coordinator consumes.
- **`campaign:delete` or `tenant:delete` scope.** The `FoundryWhisperDeletionAdapter` does NOT participate in these scopes (`supportedScopes: ["player"]`); for campaign or tenant scope, the operator's "delete the whole campaign" intent isn't fully serviceable by per-player whisper cascade. Manual remainder: "Campaign deletion does not remove Foundry-side chat history; delete the Foundry world or use Foundry's own GM tools."

## Verification plan

The cascade's observable surfaces are (a) Foundry's chat log after the delete and (b) the deletion report rendered by the CLI.

- **Cascade success.** _Observable surface:_ `FakeFoundryClient.deleteChatMessages` recorded calls + the returned `ErasureReport`. _Observation point:_ unit test — register `FoundryWhisperDeletionAdapter` with a fake that returns `{ deletedCount: 7 }` for `by-recipient` and `{ deletedCount: 3 }` for `by-author`; identity map has a row with `foundryUserId: "u1"` for the player. Call `service.erase({ kind: "player", tenantId: "t1", subjectId: "d1" })`. _Expected:_ `ErasureReport.perAdapter` has `{ adapter: "foundry-whisper", recordsDeleted: 10 }`; `partialSuccess: false`; no manual remainders.
- **Cascade — no Foundry user mapped.** _Observation point:_ unit test — identity map returns `currentForPlayer({ ... }) = { foundryUserId: null }`; capability is available. _Expected:_ `{ recordsDeleted: 0, manualRemainder: { reason: "no-foundry-user-mapped" } }`; `partialSuccess: true`; one manual remainder line in the rendered summary.
- **Cascade — add-on unavailable.** _Observation point:_ unit test — add-on not connected. _Expected:_ no FoundryClient.deleteChatMessages call recorded; `{ recordsDeleted: 0, manualRemainder: { reason: "addon-unavailable" } }`; `partialSuccess: true`.
- **Cascade — bridge call fails.** _Observation point:_ unit test — fake throws on `deleteChatMessages`. _Expected:_ `{ recordsDeleted: 0, manualRemainder: { reason: "foundry-call-failed" } }`; `partialSuccess: true`; the error message is in the manual-remainder message string.
- **CLI exit code on partial success.** _Observable surface:_ CLI process exit code. _Observation point:_ integration test — run `node server/src/cli.ts player:delete --tenant t --subject d --yes` against a `FoundryWhisperDeletionAdapter` configured with a fake that returns a `manualRemainder`. _Expected:_ process exits with code 2; stdout has at least one line beginning with `WARNING:`.
- **CLI exit code on clean success.** _Observation point:_ same as above but the adapter returns clean. _Expected:_ exit code 0.
- **Existing adapters' migration is no-op behavior-wise.** _Observation point:_ existing unit tests for `ConsentsDeletionAdapter`, `DialogueDeletionAdapter`, etc. — all should pass after the one-line return-shape update. _Expected:_ no test changes other than the shape; all green.
- **`deletion_log` records partial-success.** _Observable surface:_ the `deletion_log` table after a cascade. _Observation point:_ integration test — run erasure with a addon-unavailable cascade; query the `deletion_log` row. _Expected:_ `partial_success = 1`; `manual_remainders` is a JSON array with one entry.
- **HTML export summary names the Foundry remainder.** _Observable surface:_ rendered HTML. _Observation point:_ integration test — run `player:export` and inspect the generated HTML; assert one section contains "Foundry-side data not exported" with a pointer to Foundry's own export.
- **Live: end-to-end cascade against real Foundry + first-party add-on.** Operator creates a campaign, exchanges a few whispers between the AI DM Foundry user and a player's Foundry user, runs `skeinkeeper player:delete`; observes (in Foundry GM chat log) that the player's whispers are gone; report exits 0. Operator-validated.

## Requirement traceability

| PRD ref                               | Requirement                                                                                                                                                                                                                                                                                    | Satisfied by                                                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.5 (Per-player erasure cascade)      | "Under the Surface model, side-channel content is stored in Skeinkeeper's audience-tagged dialogue store _and_ delivered via Foundry whisper; per-player erasure cascades to both — the deletion adapter calls the bridge to remove the corresponding Foundry whisper history for that player" | `FoundryWhisperDeletionAdapter` (§1); registered alongside the existing Skeinkeeper-side adapters; `ErasureService` orchestrates one `erase(scope)` call across all       |
| 5.5 (Per-audience erasure honesty)    | (Implicit; the PRD frames erasure as a real privacy commitment, not a best-effort) — operator and player must be able to know what was deleted and what wasn't                                                                                                                                 | `ErasureReport.partialSuccess` + `manualRemainders` (§2); CLI exit code 2 + summary lines (§3); HTML export summary's "Foundry-side data not exported" (§3)               |
| 5.5 (Two-layer anti-leak — preserved) | The two-layer anti-leak from TDD 0035 is reinforced by the cascade — deleting the Skeinkeeper-side record without deleting the Foundry side would leave the Layer-2 record intact (operator can still GM-view it)                                                                              | The cascade addresses Layer 2's persistence; without this TDD, layer 2's record persists indefinitely past a "deletion"; with it, the deletion is symmetric across layers |
| 5.5 (Existing 5.5 erasure surface)    | The CLI surface + the deletion log + the export surface (carried forward from TDD 0003)                                                                                                                                                                                                        | Carried forward unchanged in shape; extended for partial-success                                                                                                          |

## Dependencies considered

No new third-party Skeinkeeper-side dependencies. Reuses:

- `FoundryClient.deleteChatMessages` from TDD 0041.
- The 3-way identity map from TDD 0036.
- TDD 0041 connection (hello-ok). No capability probe — the add-on always exposes deleteChatMessages.
- The `ErasureService` + `deletion_log` from TDD 0003 (carried forward).
- The `PII<>` encryption from TDD 0030 (the cascade doesn't change the encryption posture — it deletes encrypted rows, doesn't decrypt them).

Alternatives considered:

- **Fail erasure entirely when the add-on is unavailable** (option (a) in §Approach). Rejected: makes erasure unrunnable when Foundry is down. Foundry can go down mid-campaign; players' erasure requests don't pause for that.
- **Silently complete Skeinkeeper-side; hide the Foundry remainder** (option (c)). Rejected categorically: lies to the operator and to the player. The whole point of TDD 0003's contributor hard rule is that erasure is _verifiable_; hidden remainders break that.
- **Queue Foundry-side deletions for retry when Foundry recovers.** Considered (a "background re-cascade" worker that retries `foundry-call-failed` manualRemainders later). Rejected for v0.5 scope: adds a stateful worker for an operator-action that's already an operator-controlled retry (`skeinkeeper player:delete --subject ... --yes` is idempotent — re-runs are safe). Revisit if operator demand emerges.
- **A `FoundryWhisperExportAdapter` symmetric to the deletion adapter.** Considered. Rejected for v0.5: Foundry's chat log is exportable via Foundry's own GM tooling (a stable surface that doesn't depend on the add-on); duplicating it in Skeinkeeper would be a maintenance liability. The HTML summary points the operator at Foundry's tool.

## PRD conflicts surfaced (and resolution)

1. **PRD §5.5 says erasure cascades; it doesn't specify what happens when the cascade can't complete.** The design-pass decision (partial-success with explicit remainders) fills the gap. **Resolution:** documented in PRIVACY.md + this TDD; suggested as a PRD §5.5 follow-up addition ("when Foundry-side cascade can't complete, the operator is informed of the remainder").

2. **PRD §5.5's two-layer anti-leak claim is a delivery-time property of the AI's outputs, not a property of the data at rest.** Conceptually, deleting the dialogue store doesn't itself enforce the anti-leak; the LLM has already emitted. But the Layer-2 data-at-rest (Foundry whispers) persists past the LLM emit and remains visible to GM-role users until deleted. The cascade is what closes the gap between "we don't compose other players' content" (Layer 1, runtime) and "the storage record doesn't outlive its scope" (Layer 2, data-at-rest after deletion). **Resolution:** the cascade IS the data-at-rest deletion for Layer 2; named in PRIVACY.md.

3. **`campaign:delete` and `tenant:delete` scopes don't have a Foundry-side analog.** Foundry doesn't have a "delete this campaign's data" surface that's tractable from the add-on. **Resolution:** documented as a known limitation in PRIVACY.md ("Skeinkeeper-side campaign deletion doesn't remove Foundry-side chat history; operator deletes the Foundry world or uses Foundry's own GM tools").

4. **PRD §5.5 says erasure cascades "across all storage systems including the vector store and backups."** The cascade in this TDD covers the vector store (via cold-tier deletion) and the Foundry-side live chat history (via the new adapter), but NOT Foundry-side **backups** (Foundry-server snapshots, operator-managed nightly dumps, hosted-Foundry vendor backups). The bridge does not expose a backup-mutation surface, and operator-side backup retention is outside Skeinkeeper's control by definition (self-hosted). **Resolution:** PRIVACY.md is updated to name this as an explicit limitation — Skeinkeeper-driven erasure does NOT reach into Foundry-server backups; operators who treat their privacy commitments seriously are advised to rotate Foundry backups on a documented retention window. This is the same posture as `campaign:delete` not reaching Foundry backups (item 3); naming it explicitly so the PRD §5.5 language isn't read as over-promising. PRD §5.5 follow-up: soften "including … backups" to "live-data stores; operator-controlled backup retention is operator policy."

## Decisions to promote (ADR candidates)

None new from this TDD. The decisions are:

- **Partial-success failure-mode policy** — operational pattern, not a durable architectural decision. TDD-level.
- **The cascade as an extension of [ADR-0017](../adr/0017-per-audience-memory-visibility-erasure.md)** — operational consequence of ADR-0017's per-audience-erasure claim; no new architectural decision.

If the design-PR reviewer thinks the partial-success policy is durable enough to warrant a refining ADR (`Refines: 0010 / 0017`), that's defensible. Not proposed here; keeping the ADR bar high.

## Telemetry implications

| Event                     | Payload                                                                     | Description                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `erasure.completed`       | `{ scope: "player" \| "campaign" \| "tenant", totalRecords, adapterCount }` | Existing event from TDD 0003; carries forward                                                                |
| `erasure.partial-success` | `{ scope, remainderCount, reasons: ReadonlyArray<string> }`                 | NEW: a `partialSuccess` erasure completed; `reasons` is the deduped list of manualRemainder reasons (no IDs) |
| `erasure.adapter.failed`  | `{ adapter, reason }`                                                       | NEW: an adapter returned a `manualRemainder` with the given reason                                           |

All PII-free per [ADR-0010](../adr/0010-privacy-as-architecture.md). The `subjectId` (Discord user ID) is hashed (existing pattern from TDD 0003); the new events do NOT include it.

## Privacy implications

- The cascade IS the privacy improvement of this TDD. Without it, the Foundry-side whisper history outlives the operator-declared erasure — a real privacy regression for self-hosted operators who treat their commitments seriously.
- The partial-success policy preserves operator honesty: when the cascade can't complete, the operator KNOWS, and the operator can hand the player a complete account (the HTML summary).
- PRIVACY.md update co-shipped (per §6 above + the docs-update-alongside-code rule).
- No new PII is processed by this TDD; existing PII handling (encryption at rest per TDD 0030; salted-hash audit log) is unchanged.

## Eval implications

- **Unit-testable (the bulk):** `FoundryWhisperDeletionAdapter` per failure-mode branch; the `ErasureReport` aggregation; the CLI exit code; the HTML summary renderer.
- **Operator-validated live:** end-to-end cascade against a real Foundry + bridge with cap #3 available; observe Foundry GM chat log before/after; confirm clean deletion.
- **No `eval:live` (LLM-side) fixtures** — erasure is mechanical infrastructure; no model judgment involved.

## Open questions

- **Background re-cascade for `foundry-call-failed` remainders.** Deferred per §"Dependencies considered → Alternatives." Revisit if operator demand emerges; v0.5 ships with manual retry.
- **Per-player history-aware Foundry-user resolution.** Currently the cascade uses `currentForPlayer` (the latest binding); prior Foundry users a player was bound to over the campaign's life aren't covered. Tracked as a v0.5+ enhancement; needs an identity-map history table (additive migration), not a redesign.
- **Operator notification when cascade succeeds.** Currently silent on success (CLI exit 0, summary printed but no further notification). Should the operator also see a "deletion completed" notification in Foundry GM chat for an out-of-session erasure run? Recommendation: not for v0.5 — out-of-session CLI runs are operator-initiated; redundant in-Foundry notification adds noise. If automation runs deletions (a future scheduled-erasure feature), revisit.

## Evaluation rubric

| Criterion | High-quality | Acceptable | Failing |
| --- | --- | --- | --- |
| Requirement traceability | Every in-scope FR/NFR maps to a named interface, type, or step | One mapping is slightly coarse but still findable | An in-scope FR has no row, or the row is "handled in code" |
| Interface concreteness | Method names, args, return types, and error cases are specified | Types are named; one edge payload is implied | "the module talks to Skeinkeeper" with no message or method shape |
| Alternatives-analysis substance | Each new dep names a rejected alternative and a one-line reason | No new dep, and the section says why | New dep with empty or "none considered" analysis |
| Verification-plan actionability | Observable surface, observation point, and PASS values are named | Observable but one scenario is console-only | Non-actionable plan (no surface, no observation point) |
| Scope-bound adherence | Touched files ≤8, body ≤500, per-file estimates present | One justified exception marker | Silent over-bound or missing Touched files / Expected diff |
| Naming consistency | FoundryClient methods, gateway messages, and add-on id match across 0041, 0042, and revised drafts | One leftover "bridge" in a revised draft, clearly historical | 0041 and 0034 disagree on a method or event name |
