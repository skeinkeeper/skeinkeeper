# TDD 0032: Autonomous Pre-Game Setup Actions

Status: implemented
PRD refs: 4.8, 5.1
PRD-rev: 5c3a198
ADR constraints: 0002, 0003, 0008, 0010, 0017, 0018, 0023, 0024, 0029, 0030
Author: maintainers
Date: 2026-05-26
Related TDDs: [0041 (first-party Foundry add-on)](./0041-first-party-foundry-addon.md), [0019 (cold/episodic memory)](./0019-cold-episodic-memory.md), [0021 (compendium cold ingestion)](./0021-compendium-cold-ingestion.md), [0031 (intake + intake report)](./0031-session-intake-and-intake-report.md), [0034 (surface routing + IO abstraction)](./0034-surface-routing-and-io-abstraction.md), [0036 (onboarding + Foundry-user pre-flight)](./0036-onboarding-and-foundry-user-preflight.md)

> **Implementation note (add-on write surface).** The orchestrator-side logic
> here (classifiers, world-content readers, `refreshIndex`, `extractKeys`,
> `chooseInitialScene`) is implemented and unit-tested. Source-material indexing
> is functional end-to-end: the first-party add-on implements the journal/
> compendium **reads** it needs (`searchJournals`, `getJournal`,
> `searchCompendium`, `listCreaturesByCriteria`). **Content pre-loading**
> (`preloadExpectedContent` → `createActorFromCompendium`) is the compendium-to-
> world **write** surface owned by [TDD 0042](./0042-foundry-mechanical-writes.md);
> until that lands and is live-validated, the add-on returns a `not-implemented`
> error for that call and pre-load surfaces the failure rather than silently
> importing nothing. Lazy-at-trigger-time (TDD 0033) is the fallback either way.

## Approach

§4.8 names four autonomous actions the AI takes once intake (TDD 0031) gives it the green
light: **(1)** initial-scene activation when unambiguous, **(2)** Discord-user ↔ Foundry-actor
ownership confirmation during onboarding, **(3)** source-material indexing over loaded campaign
content, and **(4)** content pre-loading from compendia into the world. All four share the
_silence-is-success_ default: act autonomously; report only on ambiguity, failure, or a
genuine judgment call (which routes back through TDD 0031's escalation channel).

**Surface-model note (PRD-rev `59a0fda`).** Under the §4 surface model, the AI no longer
runs a Foundry ownership-assignment write itself. Ownership is now a **pre-flight
invariant** that the operator establishes in Foundry before Start (the 3-way identity map
of [TDD 0036](./0036-onboarding-and-foundry-user-preflight.md): Discord user ↔ Foundry
user ↔ character actor); the AI's role at session-start is to _verify_ that map and
escalate gaps, not to write ownership. Action (2) is therefore rescoped from a write to
a _verification + binding_ step that defers to TDD 0036's pre-flight verifier; the
`record_player_character` extension in TDD 0036 owns the Discord↔Foundry-user binding.
The autonomous _write_ actions (1), (3), and (4) are unchanged in scope but now route
their after-the-fact operator notifications through TDD 0034's SurfaceRouter (Foundry
GM chat surface) rather than a Discord DM — see TDD 0031's "Delivery via `notify_operator`"
section.

Three of the four are small write surfaces over the existing `FoundryClient` (TDD 0007; production transport is TDD 0041).
The fourth — source-material indexing — extends TDD 0021's compendium-ingestion pattern
across all loaded world content (journals, scenes, items, creatures) keyed by location,
quest, and keyword. The extension reuses `ingestColdEntries` and the cold-tier
`MemoryRecord` model from TDD 0019 + 0021; the new work is the world-content readers and
metadata extractors, plus an incremental-refresh path for re-Starts.

This TDD is designed against [ADR-0023](../adr/0023-operator-as-host-model.md) (operator-as-host,
supersedes [ADR-0015](../adr/0015-operator-pregame-ai-performs-in-play-dm-actions.md)) and
[ADR-0024](../adr/0024-silence-is-success-operator-escalation.md) (silence-is-success
operator escalation discipline). Both ADRs landed in the same design PR as this TDD.

## Components & interfaces

### 1. Initial-scene activation

```ts
// orchestrator/autosetup/initial-scene.ts
// Imports types from orchestrator/intake/types.ts (TDD 0031).
export function chooseInitialScene(
  intake: ExtendedIntakeResult,
  sessionConfig: SessionConfig,
): SceneChoice;

export type SceneChoice =
  | {
      kind: "unambiguous";
      sceneId: string;
      reason: "already-active" | "single-starter" | "prior-resolved";
    }
  | { kind: "ambiguous"; candidates: SceneSummary[] } // surfaced as IntakeFinding (TDD 0031)
  | { kind: "none" }; // surfaced as critical gap (TDD 0031)

export async function activateScene(foundry: FoundryClient, sceneId: string): Promise<void>; // calls setActiveScene; idempotent
```

`chooseInitialScene` runs exactly once per session, on `runExtendedIntake` completion.
The orchestrator dispatches based on its return:

- **`'unambiguous'`** → call `activateScene(sceneId)` immediately; also emit a
  `RECO_PROPOSED_STARTING_SCENE` informational recommendation into the intake report so
  the operator sees "I activated _Goblin Ambush_" in the "For your info" section. The
  operator's mid-session correction path is the **live-session scene-switch control**
  (a separate operator control on the SessionManager write path, per ADR-0016 / TDD 0040 which supersedes TDD 0025) — _not_ a finding resolution. This separation is intentional: a recommendation
  is informational; mid-session correction is a control action.
- **`'ambiguous'`** → emit `AMBIG_STARTING_SCENE` with the candidate list. **Do not call
  `activateScene`.** Scene activation is deferred to the resolution-handler path: when
  the operator picks via `/skeinkeeper intake resolve`, the handler (a) writes
  `sessionConfig.intake.chosenStartingSceneId`, then (b) synchronously calls
  `activateScene(sceneId)`. There is no race window because `chooseInitialScene` runs
  once and its branches partition outcomes — the `'ambiguous'` branch performs no write.
- **`'none'`** → emit `NO_STARTING_SCENE` critical (a new code in TDD 0031's union —
  _added in this design pass_). Block `announceReady`. Operator resolves by adding a
  scene in Foundry + retry; no `proceed-anyway` (there's literally nowhere to play).

`activateScene` is idempotent against the already-active case (reads `getActiveScene`
first; calls `setActiveScene` only on mismatch), so back-to-back resolution → activation →
operator-override sequences don't double-fire.

Rubric for `'unambiguous'`:

- (a) **already-active**: Foundry's `getActiveScene` returns a scene whose flag/tag
  metadata or name matches a known "starter" convention (configurable per system; default
  matches names containing `start`, `intro`, or scenes flagged `is-starter` by the
  campaign module).
- (b) **single-starter**: exactly one scene across `listScenes` matches the starter
  convention, and no other scene is currently active.
- (c) **prior-resolved**: `sessionConfig.intake.chosenStartingSceneId` is set (operator
  resolved an ambiguity in a prior Start of this campaign) and the scene still exists.

Anything else → `'ambiguous'` (multiple plausible scenes) or `'none'` (no scene matches).
The classifier is pure; unit-tested per branch.

Activation: `foundry.setActiveScene(sceneId)`. After-the-fact notification: a single line
appended to the intake report's "I did the following" footer (rendered by TDD 0031's
formatter when extended intake completes; this TDD provides the line content).

### 2. Ownership verification during onboarding (delegated to TDD 0036)

**Rescoped under PRD-rev `59a0fda`.** Under the surface model, the operator is responsible
for establishing the **3-way identity map** in Foundry before Start (Discord user ↔
Foundry user ↔ character actor — TDD 0036 §"3-way identity"). Skeinkeeper does not
mutate Foundry ownership; it _verifies_ the map at session-start pre-flight and at each
player's voice-join, and escalates gaps to the operator over the Foundry GM chat
surface (TDD 0036's `verifyIdentityPreflight()`).

This TDD owns no ownership-write code path at v0.5. The previous draft's
`assignActorOwnership` / `OwnershipResult` / `resolveFoundryUserForDiscordUser` interfaces
are removed; the Discord-user ↔ Foundry-user binding is captured by the
`record_player_character` extension in TDD 0036 (which adds the `foundry_user_id` column
to `player_character_map` and is populated from the pre-flight verifier's findings or
from the operator's intake-resolution choices). The autosetup module previously planned
at `orchestrator/autosetup/ownership.ts` does not ship; the responsibility lives entirely
in `orchestrator/intake/identity-preflight.ts` (TDD 0036).

The orchestrator's session-start wiring (sequencing step 6 below) reduces to "invoke TDD
0036's `verifyIdentityPreflight()` and let it raise findings"; no `assignActorOwnership`
dispatch happens here.

### 3. Source-material indexing

The big section. Scope (per the approved decision in this TDD's plan): **world journals,
scenes, items, creatures**, keyed by **location / quest / keyword** for retrieval.

#### 3a. World-content readers

Four readers over `FoundryClient` (not `McpToolCaller`; not MCP tool names). Production
transport is [TDD 0041](./0041-first-party-foundry-addon.md). Tests use `MockFoundryClient`.

```ts
// orchestrator/autosetup/foundry-world-reader.ts
export function foundryWorldContentReader(
  foundry: FoundryClient,
  partyActorIds?: ReadonlyArray<string>,
): WorldContentReader;

export interface WorldContentReader {
  readJournals(q?: SearchQuery): Promise<WorldJournalEntry[]>;
  readScenes(): Promise<WorldSceneEntry[]>;
  readCreatures(q?: CreatureCriteria): Promise<WorldCreatureEntry[]>;
  readActorItems(actorIds: ReadonlyArray<string>): Promise<WorldItemEntry[]>;
}
```

- **Journals** via `searchJournals` + `getJournal`. Returns `{id, name, text, pages?, folder?, modifiedAt?}`.
- **Scenes** via `listScenes`. Name + active state; folder/tags when the add-on provides them.
- **Creatures** via `listCreaturesByCriteria` / `searchCompendium` (TDD 0041 / TDD 0021).
- **Actor items** via `getActor` and the actor's sheet `items`. World-level item discovery
  is out of v0.5 — index only items in the party actors' inventories. Compendium items
  remain TDD 0021. Named in "PRD conflicts surfaced"; not a TDD 0042 write.

Do not add `plugins/vtt-foundry/src/world-content.ts` calling `list-journals` /
`get-character-entity`. That path is withdrawn.

#### 3b. Metadata extraction (the keys for retrieval)

```ts
// orchestrator/memory/world-metadata.ts
export interface ExtractedKeys {
  location?: string; // a place name; e.g., "Phandalin", "Wave Echo Cave"
  quest?: string; // a quest/objective name; e.g., "Find Gundren"
  keywords: string[]; // 0..N free-text tags for fuzzy retrieval
}

export function extractKeys(source: WorldEntrySource): ExtractedKeys;
```

Per-source rules:

- **Journal**: `location` = the journal's `folder` if it follows a location convention
  (heuristic: matches the world's scene-folder set), else the first proper-noun in the
  journal's title. `quest` = if the journal has a `quest`-flagged page or its title
  matches an in-progress quest (read from Foundry quest state). `keywords` = the
  journal's title split on whitespace + proper nouns extracted from the first 500 chars of
  body text via a simple capitalized-word heuristic (no NLP model; the rubric is
  deterministic).
- **Scene**: `location` = the scene's name. `quest` = inherited from a journal with the
  same `folder` if one exists. `keywords` = scene name + folder + any tags on the scene.
- **Creature**: `location` = the journal-folder that names the creature (if any). `quest` =
  inherited via the journal cross-reference. `keywords` = creature name + type + any
  searchable tags.
- **Item**: `location`/`quest` = same indirect via owning-actor / journal cross-reference.
  `keywords` = item name + type.

The proper-noun + cross-reference heuristics are intentionally simple. A model-driven
extractor was considered (better recall) and rejected — the index is rebuilt on every
re-Start (incremental), so any wrong key surfaces immediately and is fixable; making
indexing an LLM call would balloon Start latency, cost, and non-determinism. The
deterministic heuristic gives reproducible indexing.

#### 3c. Ingestion + storage (reuse TDD 0021)

`ingestColdEntries` from TDD 0021 already does embed + upsert into the cold tier with
deterministic ids and `metadata.deltas`. Two small adjustments:

- The `MemoryRecord.metadata` payload gains optional fields:
  `source: 'world-journal' | 'world-scene' | 'world-creature' | 'world-actor-item' | 'compendium'`,
  `foundry_id: string`, `last_modified?: string`, `location?: string`, `quest?: string`,
  `keywords?: string[]`. Existing `compendium` source remains the default for TDD 0021's
  path (additive).
- A retrieval-side filter `byMetadata({ location?, quest?, keywords? })` is added to
  `LanceMemoryStore` so the AI's tools can scope a cold-tier query (e.g., "what's in this
  location?") without falling back to vector-only search.

The deterministic id formula extends: `${campaignId}:${source}:${foundry_id}`. Same record
across re-ingests → upsert (TDD 0021 behavior preserved).

#### 3d. Incremental refresh on re-Start

```ts
// orchestrator/autosetup/index-refresh.ts
export async function refreshIndex(
  foundry: FoundryClient,
  store: MemoryStore,
  embed: EmbedProvider,
  ctx: { campaignId: string; lastRunAt?: number },
): Promise<RefreshReport>;

export interface RefreshReport {
  perSource: Record<IndexSource, { added: number; updated: number; deleted: number }>;
  errors: Array<{ source: IndexSource; error: string }>;
  durationMs: number;
}
```

Strategy:

- For each source, read current Foundry IDs + `last_modified` (when `FoundryClient` provides
  it).
- Compare against the existing cold-tier records' `foundry_id` + `last_modified` for that
  campaign.
- **Add**: in current, not in store → ingest.
- **Update**: `last_modified` advanced → re-embed + upsert.
- **Delete**: in store, not in current → soft-delete (cold-tier tombstone) so retrieval
  excludes stale entries.

When a source has no `last_modified`, the refresh falls back to "if
foundry_id is present, leave alone; if absent, delete" — coarser but correct. Journals
may carry `_modifiedAt`; scenes/items use presence-only until the add-on supplies it.

#### 3e. Concurrency

Indexing kicks off after **minimum intake completes** (TDD 0031's gate) and runs in
parallel with TDD 0036's onboarding ritual. The orchestrator must not _block on_
indexing for play to proceed — players are greeted, mapped, and welcomed while the AI
ingests in the background. Retrieval against the index is best-effort during the
indexing run: a query may hit pre-indexing data (compendium only); a `coldIndexReady`
session-state flag flips when world indexing completes so AI tools can prefer the richer
index when available.

A failure in one source does not halt the others (per-source success state in
`RefreshReport`). Errors are logged + counted in telemetry; the next Start retries.

### 4. Content pre-loading

```ts
// orchestrator/autosetup/preload.ts
export async function preloadExpectedContent(
  foundry: FoundryClient,
  intake: ExtendedIntakeResult,
  ctx: { campaignId: string },
): Promise<PreloadReport>;
```

For each party actor's race/class/background that requires creature/item content, the
function:

- Identifies needed compendium entries from intake's classification + the actor's
  character sheet (read via `getActor`).
- For each needed entry, checks whether a corresponding actor (or item template) already
  exists in the world (via `listWorldActors` / `listPartyActors`; per-actor items for templates).
- If absent, calls `createActorFromCompendium` to import the actor (or its template
  equivalent for items) into the world _without placing a token on any scene_. Token
  placement is TDD 0033's job at trigger time.

Idempotent: existence check before each create. Per-entry failures do not abort the batch
(continue + log). Lazy-import fallback in TDD 0033 covers cases where pre-loading missed
an entry or content changed mid-session.

The pre-load list is intentionally narrow at v0.5 — only content the party's character
sheets explicitly require. Pre-loading _every monster the operator might roll for tonight_
is rejected as scope creep; lazy-at-trigger-time is the right cost/benefit point per §4.8
("Lazy import at trigger time is acceptable when faster").

## Data & state

### `MemoryRecord.metadata` extensions

Additive fields (all optional except `source` which gains the new union members):

```
source: 'compendium' | 'world-journal' | 'world-scene' | 'world-creature' | 'world-actor-item'
foundry_id?: string
last_modified?: string
location?: string
quest?: string
keywords?: string[]
```

Existing records continue to work (`source: 'compendium'` default preserved). No schema
migration for the records table itself; the metadata column is already JSON per TDD 0019.

### `SessionConfig` reads (no new writes vs. TDD 0031)

This TDD reads `sessionConfig.intake.chosenStartingSceneId` and
`sessionConfig.intake.chosenCampaignModuleId` (set by TDD 0031's resolution handler).

### `coldIndexReady` (session-transient)

Carried on a new `SessionRunState` object (`orchestrator/session/run-state.ts`) — distinct
from TDD 0031's `SessionConfig` (durable, per-campaign) and TDD 0040's `SessionManager`
(operator-control write path, supersedes TDD 0025's): `SessionRunState` holds _per-session_
transient flags that neither TDD 0031 nor TDD 0040 owns. Field for this TDD:

```ts
export interface SessionRunState {
  coldIndexReady: boolean; // false at session start; true after refreshIndex's first
  // completion for this session
  // … future per-session transient flags belong here
}
```

`SessionRunState` is constructed at session start, owned by the Coordinator (TDD 0035 §3, which supersedes TDD 0026),
and reaches tool handlers through the existing tool-dispatch context (`ToolHandlerContext`
per TDD 0006). Wiring requires a one-field **additive** amendment to `ToolHandlerContext`:

```ts
// orchestrator/tools/context.ts (TDD 0006) — additive change
export interface ToolHandlerContext {
  tenantDb: TenantDb;
  sessionId: string;
  turnId: string;
  runState?: SessionRunState; // NEW — optional for backward compatibility
}
```

The field is optional (`?`) so existing tool handlers compile unchanged; handlers that
need it (TDD 0033's triggered-action tools; TDD 0032's `refreshIndex` writer when invoked
through the tool dispatcher) read `ctx.runState?.coldIndexReady`. The amendment is the
_only_ cross-TDD interface change introduced by this design pass; flagged explicitly so
the implementer doesn't have to guess the injection point.

TDD 0033's triggered-action tool handlers read `ctx.runState?.coldIndexReady`. TDD 0032's
`refreshIndex` writes `ctx.runState.coldIndexReady = true` on first-completion (via a
direct Coordinator-held reference, not via the tool-dispatch context — `refreshIndex` is
not itself a tool, it's an autosetup function). Not persisted; not visible to operator
surfaces (it's an internal scheduling flag, not a control).

### Foundry-side writes

- `setActiveScene` (initial-scene activation): Foundry-side state, not Skeinkeeper-side.
- Ownership assignment: operator-side in Foundry; this TDD does not write it.
- `createActorFromCompendium` (preload): Foundry-side.

ADR-0018 places mechanical state in Foundry; this TDD writes only to Foundry-owned state.

## Sequencing / implementation plan

1. `MemoryRecord.metadata` extensions + `byMetadata` filter in `LanceMemoryStore`.
2. World-content readers (`foundryWorldContentReader`) in
   `orchestrator/autosetup/foundry-world-reader.ts`, tested against `MockFoundryClient`.
3. `extractKeys` metadata extractors, per-source unit tests.
4. `refreshIndex` incremental run; per-source success/failure isolation.
5. `chooseInitialScene` + `activateScene` integration with TDD 0031's intake-finding flow.
6. ~~`assignActorOwnership` extension~~ — rescoped to TDD 0036's `verifyIdentityPreflight()`
   invocation at session-start; this TDD has no ownership-write code path at v0.5.
7. `preloadExpectedContent` (small; idempotent existence checks).
8. Orchestrator wiring: dispatch (1)–(4) on `runExtendedIntake` completion; flip
   `coldIndexReady` when (3) finishes; deliver the "I did the following" footer through
   TDD 0031's `formatIntakeReportForDm`.

## Failure modes & edge cases

- **`setActiveScene` fails.** Escalate via `notify_operator` ("I tried to activate
  _Goblin Ambush_ and Foundry returned: …"). Operator switches manually in Foundry; the
  next `getActiveScene` returns the chosen scene and play proceeds. No retry loop.
- **Ownership-verification gap** (operator's 3-way identity map missing or partial). Owned
  by TDD 0036's pre-flight verifier; this TDD does not write Foundry ownership at v0.5.
  Gap findings (e.g., `no-foundry-user`, `foundry-user-not-owning-actor`) are raised by
  TDD 0036 and surfaced on the Foundry GM chat surface; this TDD's autosetup actions do
  not depend on ownership state (the AI controls actors via tool-calls regardless of
  Foundry ownership, per ADR-0023 corollary 2 carried forward from ADR-0015).
- **Indexing source X fails** (`FoundryClient` error, parse failure). Per-source isolation — the
  other three continue. `RefreshReport.errors` records the failure; telemetry counts it;
  next Start retries. `coldIndexReady` still flips to `true` (the index is _usable_, just
  incomplete for the failing source).
- **Indexed journal deleted in Foundry between Starts.** Refresh's delete branch removes
  the cold record (tombstone). Retrieval excludes it. No race vs. mid-session play because
  refresh runs on Start.
- **Pre-load create-actor fails.** Continue with other entries. Lazy-at-trigger-time
  fallback (TDD 0033) covers the gap; failure is logged + counted.
- **Pre-load duplicates an existing actor.** Existence check prevents this; the check is
  by Foundry name + source-compendium id (we don't trust name alone).
- **Operator changes loaded modules between Starts.** Refresh's add/delete branches cover
  it; deleted modules' content tombstones, new modules' content ingests.
- **Two Starts overlapping for the same campaign** (operator restarted Skeinkeeper
  mid-session, or two orchestrators raced). `SessionManager` (TDD 0040, supersedes TDD 0025) serializes
  _operator-control writes_, but session-start is not itself an operator-control mutation
  — it spawns a Coordinator and dispatches autosetup. Two near-simultaneous Starts can
  therefore reach `refreshIndex` concurrently. This TDD adds a new campaign-scoped
  in-process mutex (`Map<campaignId, Promise<RefreshReport>>`) inside `refreshIndex`:
  the second caller short-circuits to await the in-flight promise and re-returns its
  report, so the cold tier sees one write batch per `(campaignId, lastRunAt)` pair. The
  mutex is in-process only (Skeinkeeper is single-process per ADR-0008 / TDD 0019); no
  distributed-lock concern.
- **Scene-activation chooses wrong scene under "single-starter" rubric.** Operator
  override via `/skeinkeeper intake resolve` (TDD 0031) sets
  `sessionConfig.intake.chosenStartingSceneId`; next Start uses the override.

## Requirement traceability

| PRD ref                             | Requirement                                                                                                                                                                                                         | Satisfied by                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 4.8 (initial-scene activation)      | "if exactly one scene unambiguously corresponds to the campaign's expected starting beat, the AI activates it and notifies the operator after the fact. Ambiguous → propose and wait."                              | `chooseInitialScene` rubric + `activateScene`; ambiguous → `IntakeFinding` via TDD 0031                           |
| 4.8 (Discord-user ↔ actor identity) | "the AI verifies the operator's 3-way identity map (Discord ↔ Foundry user ↔ actor) at pre-flight; ownership is operator-set in Foundry, not AI-written" (PRD-rev `59a0fda` surface model)                          | TDD 0036's `verifyIdentityPreflight()` (invoked here at sequencing step 6); this TDD writes no ownership at v0.5  |
| 4.8 (source-material indexing)      | "the AI builds a retrievable index over loaded campaign content (journals, monsters, items, scenes) keyed by location, quest, and keyword … Re-indexing on subsequent Starts is incremental."                       | World-content readers + `extractKeys` + `MemoryRecord.metadata` extensions + `byMetadata` filter + `refreshIndex` |
| 4.8 (pre-loading expected content)  | "the AI imports needed monster/NPC actors from compendium into the world (without placing tokens on any scene) so they're ready when an encounter triggers. Lazy import at trigger time is acceptable when faster." | `preloadExpectedContent`; lazy fallback in TDD 0033                                                               |
| 4.8 (concurrency model)             | "source-material indexing and content pre-loading run concurrently with onboarding"                                                                                                                                 | Step 8 of the sequencing plan; `coldIndexReady` flag; per-source isolation                                        |
| 4.8 (Operator-as-host principle)    | "default is to proceed with what it inferred and tell the operator after the fact; silence is success"                                                                                                              | Degraded-silent paths for ownership + pre-load; after-the-fact footer in the intake report                        |
| 5.1 (memory architecture)           | "Cold tier populated with campaign-relevant content; embeddings stay on-box"                                                                                                                                        | `ingestColdEntries` reuse; local embedder default per TDD 0021; no model dependency for indexing                  |

## Dependencies considered

None new. The design reuses:

- `FoundryClient` (TDD 0007; production client is TDD 0041).
- `ingestColdEntries` + `MemoryRecord` (TDD 0021 / 0019).
- `LanceMemoryStore` (TDD 0019).
- Local embedder default (TDD 0019).
- TDD 0036's `verifyIdentityPreflight()` (invoked at session-start; this TDD does not
  extend `record_player_character` — the extension lives in TDD 0036).

A model-driven metadata extractor was evaluated for §3b and rejected (cost, latency,
non-determinism vs. a heuristic that the operator can fix via override). A separate
storage tier for the world index (a parallel table) was evaluated and rejected — the
cold-tier `MemoryRecord` already carries the retrieval semantics we need; introducing a
second tier would split retrieval surface for no benefit.

## PRD conflicts surfaced (and resolution)

1. **ADR-0015 conflict — resolved by ADR-0023.** Same as TDD 0031: §4.8's autonomous
   pre-game writes contradict ADR-0015's "pre-game = operator." Resolved by
   [ADR-0023](../adr/0023-operator-as-host-model.md), which superseded ADR-0015 in this
   same design PR.
2. **World-level item discovery gap.** `FoundryClient` has no world-item walk. The §4.8
   ask "items" is interpreted as actor-inventory items + compendium items at v0.5.
   Resolution: name the gap, scope §3a accordingly; not a TDD 0042 write.
3. **`last_modified` field availability across sources.** Journals may carry
   `_modifiedAt`; scenes/items may not. Resolution: the incremental refresh
   degrades to "presence-only" when `last_modified` is absent (TDD §3d documents this
   fallback).
4. **Foundry-user identity for ownership** — rescoped under PRD-rev `59a0fda`. Ownership
   is established by the operator in Foundry pre-Start, not written by the AI. The
   3-way identity map is verified at pre-flight by TDD 0036, which raises gap findings
   (e.g., `no-foundry-user`, `foundry-user-not-owning-actor`) over the Foundry GM chat
   surface. This TDD inherits the operator-as-host posture (silence-is-success per
   ADR-0024) but no longer carries the ownership-write degradation path.
5. **`listUsers`.** Provided by TDD 0041; needed by TDD 0036's pre-flight verifier
   and by TDD 0034's audience targeting. v0.5 cannot ship without TDD 0041.

## Decisions to promote (ADR candidates)

None new beyond what TDD 0031 already proposed. The patterns in this TDD —
silence-is-success, per-source isolation, idempotency before writes — are the
operationalization of [ADR-0024](../adr/0024-silence-is-success-operator-escalation.md)
(silence-is-success), promoted in this same design pass.

## Telemetry implications

New events in `/telemetry/src/events.ts` (and `/docs/telemetry-events.md`):

| Event                              | Payload                                                                                       | Description                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `autosetup.scene.activated`        | `{ campaignId, sessionId, reason: 'already-active' \| 'single-starter' \| 'prior-resolved' }` | Initial scene activated autonomously                                         |
| `autosetup.scene.deferred`         | `{ campaignId, sessionId, candidateCount }`                                                   | Activation deferred pending operator resolution                              |
| ~~`autosetup.ownership.assigned`~~ | _removed under PRD-rev `59a0fda`_                                                             | Ownership writes are operator-side, not AI; TDD 0036 owns verifier telemetry |
| ~~`autosetup.ownership.degraded`~~ | _removed under PRD-rev `59a0fda`_                                                             | See TDD 0036 for pre-flight verification telemetry                           |
| `autosetup.preload.created`        | `{ campaignId, source: 'compendium', count }`                                                 | Pre-load created actors/items in world                                       |
| `autosetup.preload.deferred`       | `{ campaignId, count }`                                                                       | Pre-load deferred to lazy-at-trigger                                         |
| `index.run.started`                | `{ campaignId, sessionId }`                                                                   | Indexing run began                                                           |
| `index.run.completed`              | `{ campaignId, sessionId, durationMs, perSourceCounts }`                                      | Indexing run finished                                                        |
| `index.run.source-failed`          | `{ campaignId, source, reason }`                                                              | One source failed; others continued                                          |

All payloads PII-free per ADR-0010. Counts + codes + reasons only; no journal text,
no actor names, no Foundry IDs in telemetry. `actorId` is opaque (an internal id, not
PII); the existing telemetry policy classes it the same way as `campaignId`.

## Privacy implications

No new personal-data processing. Indexed content is operator-authored campaign content
(journals, scenes) and game-system content (compendium creatures/items); neither is
personal data about real players. Tenant scoping per ADR-0008 isolates campaigns. The
`MemoryRecord.metadata` extensions carry no PII (foundry_id is an opaque string;
keywords are derived from non-personal content).

Cold-tier erasure per ADR-0014 (campaign-scoped) cascades these records correctly via
the existing `DeletionAdapter` (no change needed). Per-audience erasure per ADR-0017 does
not apply — world content is `table`-audience by design (it's the campaign source
material).

## Eval implications

Scenario fixtures required before this ships:

1. **Unambiguous initial scene (already-active).** `getActiveScene` returns a
   starter-named scene → `chooseInitialScene` returns `{ unambiguous, reason: 'already-active' }`;
   no `setActiveScene` call (already there); footer reports the choice.
2. **Ambiguous initial scene.** Two equally-plausible scenes → `chooseInitialScene` returns
   `{ ambiguous, candidates: [...] }`; surfaced via TDD 0031 finding; operator-resolved →
   `sessionConfig.intake.chosenStartingSceneId` set → next Start picks reason `'prior-resolved'`.
3. ~~Ownership-assignment degrade~~ — moved to TDD 0036's eval set (pre-flight
   verifier scenarios). This TDD writes no ownership at v0.5.
4. **Incremental indexing.** First Start: full index. Second Start: one journal modified
   → re-embed; one journal deleted → tombstone; two new journals → ingest; report shows
   `{ added: 2, updated: 1, deleted: 1 }` for the journal source.
5. **Per-source isolation.** Creature reader throws on parse → `RefreshReport.errors`
   records it; journals/scenes/items complete; `coldIndexReady` still flips.
6. **Pre-load idempotency.** Run twice; second run creates zero new actors (existence
   checks short-circuit).
7. **Retrieval with metadata filter.** Cold-tier query
   `byMetadata({ location: 'Phandalin' })` returns only Phandalin-tagged records (across
   all sources); vector similarity ranks within the filter.

The classifiers + extractors are pure and unit-tested; the indexing + ownership + scene
paths are exercised via integration tests using `MockFoundryClient` + `MockFoundryClient`.
The live indexing run is operator-validated against a real Foundry world (same pattern as
TDD 0021).

## Evaluation rubric

| Criterion                       | High-quality                                                                                       | Acceptable                                                   | Failing                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Requirement traceability        | Every in-scope FR/NFR maps to a named interface, type, or step                                     | One mapping is slightly coarse but still findable            | An in-scope FR has no row, or the row is "handled in code"        |
| Interface concreteness          | Method names, args, return types, and error cases are specified                                    | Types are named; one edge payload is implied                 | "the module talks to Skeinkeeper" with no message or method shape |
| Alternatives-analysis substance | Each new dep names a rejected alternative and a one-line reason                                    | No new dep, and the section says why                         | New dep with empty or "none considered" analysis                  |
| Verification-plan actionability | Observable surface, observation point, and PASS values are named                                   | Observable but one scenario is console-only                  | Non-actionable plan (no surface, no observation point)            |
| Scope-bound adherence           | Touched files ≤8, body ≤500, per-file estimates present                                            | One justified exception marker                               | Silent over-bound or missing Touched files / Expected diff        |
| Naming consistency              | FoundryClient methods, gateway messages, and add-on id match across 0041, 0042, and revised drafts | One leftover "bridge" in a revised draft, clearly historical | 0041 and 0034 disagree on a method or event name                  |
