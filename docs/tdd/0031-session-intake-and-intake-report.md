# TDD 0031: Session Intake & Intake Report

Status: draft
PRD refs: 4.8, 3, 9.6, 9.7, 9.8
PRD-rev: 9f8518a
ADR constraints: 0008, 0010, 0016, 0018, 0023, 0024
Author: maintainers
Date: 2026-05-26
Related TDDs: [0014 (McpFoundryClient)](./0014-mcp-foundry-client.md), [0023 (onboarding + operator channel)](./0023-session-onboarding-presence-operator-channel.md), [0024 (operator self-designation)](./0024-operator-self-designation.md), [0021 (compendium cold ingestion)](./0021-compendium-cold-ingestion.md), [0026 (side-channels)](./0026-player-dm-side-channels.md)

## Approach

§4.8 reframes the operator as **host, not DM**: everything a human DM would do between
sitting down and starting the game — assessing materials, picking the starting scene,
mapping characters to players, choosing stat blocks — moves onto the AI. This TDD covers the
_analysis_ half of that move: a structured intake pass that runs on session Start, classifies
what it finds, and surfaces the operator-actionable subset over the existing
`notify_operator` channel (TDD 0023). The _write_ half — scene activation, ownership
assignment, content pre-loading, source-material indexing — is [TDD 0032](./0032-autonomous-pre-game-setup-actions.md).

The pass is structured for two reasons. First, intake produces findings the rest of the
system depends on (party-actor candidates, critical gaps), so it must be deterministic and
testable, not an LLM judgment chain. Second, §4.8 sets a **concurrency contract** — a
_minimum_ intake gates the AI's "I'm ready" announcement; _extended_ intake runs in parallel
with the onboarding ritual — and that contract is only enforceable if intake is decomposed
into the two halves.

Intake therefore lives in `orchestrator/intake/`, runs against the existing `FoundryClient`
(TDD 0014) and `MemoryStore` (TDD 0019), and exposes a structured `IntakeResult` consumed
by the orchestrator's session-start path. The orchestrator delivers the report via
`notify_operator` (TDD 0023) and persists the audit trail.

This TDD is designed against [ADR-0023](../adr/0023-operator-as-host-model.md)
(operator-as-host model, supersedes [ADR-0015](../adr/0015-operator-pregame-ai-performs-in-play-dm-actions.md))
and [ADR-0024](../adr/0024-silence-is-success-operator-escalation.md) (silence-is-success
operator escalation discipline) — both promoted from this design pass and accepted in the
same PR.

## Components & interfaces

### `orchestrator/intake/`

All cross-TDD types in this section are exported from `orchestrator/intake/types.ts`
(`IntakeContext`, `MinimumIntakeResult`, `ExtendedIntakeResult`, `IntakeFinding`,
`FindingCode`, `ResolutionOptions`, `ActorSummary`, `SceneSummary`, `ModuleSummary`,
`PackSummary`, `WarmStateSummary`). TDD 0032's autosetup modules import these directly
from `orchestrator/intake/types.ts`; the cross-TDD import contract is exactly this path,
and the types module has no runtime dependencies (pure type declarations) so it can be
imported without pulling the intake runner code.

```ts
// runner
export async function runMinimumIntake(
  ctx: IntakeContext,
  foundry: FoundryClient,
  memory: MemoryStore,
): Promise<MinimumIntakeResult>;

export async function runExtendedIntake(
  ctx: IntakeContext,
  foundry: FoundryClient,
  memory: MemoryStore,
  minimum: MinimumIntakeResult,
): Promise<ExtendedIntakeResult>;

// orchestrator-facing
export interface IntakeContext {
  campaignId: string;
  sessionId: string;
  sessionConfig: SessionConfig; // prior-resolved decisions (chosen module, primary pack, etc.)
}

export interface MinimumIntakeResult {
  system: { id: string; name: string } | null; // null => UNKNOWN_FOUNDRY_SYSTEM
  partyActorCandidates: ActorSummary[]; // [] => NO_PARTY_ACTORS
  criticalFindings: IntakeFinding[]; // surfaced from MinimumIntake only
}

export interface ExtendedIntakeResult {
  loadedModules: ModuleSummary[];
  compendiumPacks: PackSummary[];
  existingScenes: SceneSummary[];
  currentOwnershipMap: Record<ActorId, FoundryUserId>;
  warmStateSummary: WarmStateSummary; // prior sessions, quest flags, consents (TDD 0023, 0019)
  findings: IntakeFinding[]; // ambiguities + recommendations (criticals already raised)
}

export interface IntakeFinding {
  code: FindingCode; // stable string ID for classification + tests
  kind: "critical-gap" | "ambiguity" | "recommendation";
  summary: string; // operator-facing, spoiler-safe
  detail?: string; // operator-facing; may carry spoiler context
  dmOnly: boolean; // delivery prepends an explicit DM-only marker
  resolution?: ResolutionOptions; // for ambiguities: choice set the operator picks from
}

export interface ResolutionOptions {
  prompt: string;
  options: Array<{ id: string; label: string }>;
  applyOnResolve:
    | "scene-choice"
    | "module-choice"
    | "primary-pack-choice"
    | "ownership-map"
    | "proceed-anyway";
}
```

`FindingCode` is a closed string-literal union. The v0.5 set:

- **Critical** — `NO_FOUNDRY_SYSTEM`, `UNKNOWN_FOUNDRY_SYSTEM`, `FOUNDRY_NOT_CONNECTED`,
  `NO_PARTY_ACTORS`, `MISSING_RACE_CONTENT`, `MISSING_CLASS_CONTENT`, `NO_STARTING_SCENE`
  (raised by TDD 0032's `chooseInitialScene` `'none'` branch — no scene in the world
  matches any starter convention; block `announceReady` until the operator adds a scene).
- **Ambiguity** — `MULTIPLE_CAMPAIGN_MODULES`, `AMBIG_STARTING_SCENE`,
  `AMBIG_SOURCE_PACK_FOR_CREATURE`, `AMBIG_RACE_SOURCE`.
- **Recommendation** — `RECO_PROPOSED_STARTING_SCENE`, `RECO_PROPOSED_OWNERSHIP_MAP`,
  `RECO_PROPOSED_PRIMARY_PACK`, `RECO_FOUNDRY_OWNERSHIP_UNRESOLVED` (raised by TDD 0032
  when an ownership-assignment attempt degrades silently — surfaced on the _next_
  extended-intake pass, not at the moment of degradation, per the silence-is-success
  discipline).

Each code maps 1:1 to a unit test in the classifier.

### Classification rubric

Three pure functions, one per kind, each unit-tested against fixtures:

- `classifyCriticalGaps(minimum, ctx) → IntakeFinding[]` — system unrecognized, no
  party-actor candidates, missing required content for a mapped player's character (only
  detectable when warm state already has a `player_character_map` entry; for un-mapped
  players the gap surfaces during onboarding instead).
- `classifyAmbiguities(extended, ctx) → IntakeFinding[]` — multiple unrelated campaign
  modules loaded, same creature in multiple packs (where pack-preference isn't in
  session config), multiple scenes equally plausible as the starting beat, player race/class
  defined in more than one loaded source.
- `classifyRecommendations(extended, ctx) → IntakeFinding[]` — proposed starting scene
  (used by TDD 0032's `chooseInitialScene`), proposed Discord→actor ownership map (used by
  TDD 0023's onboarding mapper + TDD 0032's ownership-write), proposed primary source pack
  for a recurring creature.

The rubric uses no LLM. It composes Foundry MCP reads (`get-world-info`, `list-characters`,
`list-scenes`, `list-compendium-packs`, `list-creatures-by-criteria`, `search-compendium`,
`search-journals`) and warm-state reads (`player_character_map`, prior-session summaries,
consents).

### Spoiler-aware framing

`buildFindingSummary(code, payload, framingPolicy) → { summary, detail, dmOnly }` is the
single place spoiler-framing decisions are made. The default policy is conservative per
§9.8: surface the _choice_, omit _context_ whenever possible; when context is unavoidable,
set `dmOnly: true` and the formatter prepends an explicit marker
(`*DM-only — affects tonight's session:*`). A heuristic table drives this:

| Code (or class)                                                                                                    |                           dmOnly default                           | Reason                                                                             |
| ------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------: | ---------------------------------------------------------------------------------- |
| `MULTIPLE_CAMPAIGN_MODULES`                                                                                        |                               false                                | Module names are spoiler-safe to surface                                           |
| `AMBIG_SOURCE_PACK_FOR_CREATURE`                                                                                   |                                true                                | Names a creature → telegraphs an encounter                                         |
| `AMBIG_RACE_SOURCE`                                                                                                |                               false                                | Player already knows their race                                                    |
| `AMBIG_STARTING_SCENE`                                                                                             |                                true                                | Names locations the players haven't entered                                        |
| `RECO_PROPOSED_STARTING_SCENE`                                                                                     |                                true                                | Same scene-naming concern as the ambiguity case                                    |
| `RECO_PROPOSED_OWNERSHIP_MAP`                                                                                      |                               false                                | Character names are public                                                         |
| `RECO_PROPOSED_PRIMARY_PACK`                                                                                       | true if the pack choice names a creature/location; false otherwise |
| `RECO_FOUNDRY_OWNERSHIP_UNRESOLVED`                                                                                |                               false                                | Tells operator a player's Foundry-user mapping needs attention; no fiction spoiler |
| `MISSING_RACE_CONTENT` / `MISSING_CLASS_CONTENT`                                                                   |                               false                                | Players already know their sheets                                                  |
| `NO_FOUNDRY_SYSTEM` / `UNKNOWN_FOUNDRY_SYSTEM` / `FOUNDRY_NOT_CONNECTED` / `NO_PARTY_ACTORS` / `NO_STARTING_SCENE` |                               false                                | Infrastructure findings; no fiction context to spoil                               |

The table is exhaustive over the v0.5 `FindingCode` set: every code has an explicit row.
New codes added in future TDDs MUST add their row before the classifier accepts them
(enforced via the closed string-literal union — adding a code without updating
`buildFindingSummary`'s table is a compile-time error).

The table is the rubric's full surface area for §9.8. An operator-configurable "I'm also a
player" toggle is the planned refinement but out of scope for v0.5 (per PRD §9.8); the
heuristic is the v0.5 answer.

### Delivery via `notify_operator`

`formatIntakeReportForDm(report) → IntakeDmPayload` renders the single structured DM
recommended by PRD §9.6:

- One DM message per intake run (not one per finding) — header + grouped sections
  (`Critical`, `I need a decision`, `For your info`).
- Each finding renders as a bullet with `summary` and, if present, the resolution
  options as a numbered choice list.
- `detail` is delivered inside a `> ` quote block under the bullet, prefixed by
  `*DM-only — affects tonight's session:*` when `dmOnly` is true.
- Resolution is collected via `/skeinkeeper intake resolve <session-finding-id> <option-id>`
  (the slash-command response path PRD §9.6 recommends for v0.5). The slash-command lives
  alongside the existing `/skeinkeeper operator …` family per TDD 0024.

A finding with no resolution options (e.g., a pure recommendation accepted by default) is
rendered as informational only — operators don't need to acknowledge it.

### Minimum-intake gate

The orchestrator's session-start path:

1. `runMinimumIntake` — must complete + carry zero unresolved critical findings before
   `announceReady` may run.
2. Critical findings → deliver report fragment (criticals only) → block until resolved or
   `proceed-anyway` chosen. `proceed-anyway` is only offered for the hard-gap case per
   §9.7 (operator acknowledges; AI improvises during play and logs the gap).
3. `runExtendedIntake` — kicked off in parallel with TDD 0023's onboarding ritual. The
   onboarding ritual does not wait on extended intake.
4. Extended intake findings → delivered as a second DM (or appended if onboarding hasn't
   yet sent its first turn) when extended completes.
5. Resolutions update `SessionConfig` (in-memory + persisted) so subsequent extended-intake
   runs (incremental re-Start) honor them silently.

`announceReady` is the existing TDD 0023 ritual-start signal. The minimum-intake gate is the
new precondition.

## Data & state

### `session_intake_finding` (new)

```
session_intake_finding(
  id              INTEGER PRIMARY KEY,
  campaign_id     TEXT NOT NULL,        -- tenant scope per ADR-0008
  session_id      TEXT NOT NULL,
  finding_code    TEXT NOT NULL,        -- FindingCode value
  kind            TEXT NOT NULL,        -- 'critical-gap' | 'ambiguity' | 'recommendation'
  summary         TEXT NOT NULL,
  detail          TEXT,
  dm_only         INTEGER NOT NULL,     -- 0|1
  resolution_id   TEXT,                 -- option.id when resolved; NULL otherwise
  created_at      INTEGER NOT NULL,
  resolved_at     INTEGER
)
```

PII-free by design. The audit log (TDD 0023's existing audit surface) cross-references
findings by id.

### `SessionConfig` additions

```
sessionConfig.intake = {
  resolvedFindings: Record<FindingCode, string>;  // code → chosen option id
  chosenStartingSceneId?: string;
  primarySourcePackByCreatureKey?: Record<string, string>;
  chosenCampaignModuleId?: string;
}
```

Persisted per-campaign so the next Start honors prior choices silently. Erasure follows the
campaign-scope rule (ADR-0014); per-campaign delete cascades these.

### What does NOT persist

The full `IntakeResult` is session-transient (memory only). Only the findings that produced
operator-visible escalations or operator-confirmed decisions get the durable record above.
Recomputing `IntakeResult` is cheap (it's just MCP reads + a deterministic rubric); persisting
the whole snapshot would create a second source of truth for state that ADR-0018 places in
Foundry.

## Sequencing / implementation plan

1. Types (`IntakeContext`, `IntakeResult`, `IntakeFinding`, `FindingCode`, `ResolutionOptions`).
2. Foundry read adapters used by the rubric (thin functions over `FoundryClient`).
3. `classifyCriticalGaps`, `classifyAmbiguities`, `classifyRecommendations` — pure, fixture-tested.
4. `buildFindingSummary` + spoiler heuristic table.
5. `runMinimumIntake` + `runExtendedIntake`.
6. `formatIntakeReportForDm` + the `/skeinkeeper intake resolve` slash-command + TDD 0023
   `notify_operator` wiring.
7. `session_intake_finding` table + migration; `SessionConfig.intake` persistence.
8. Orchestrator session-start integration: minimum-intake gate before `announceReady`;
   extended-intake concurrent with onboarding ritual.

## Failure modes & edge cases

- **Foundry MCP not connected on Start.** Minimum intake fails fast → emit
  `FOUNDRY_NOT_CONNECTED` critical → operator notified → Start blocked. Retry on bridge
  reconnect (operator runs `/skeinkeeper session start` again).
- **`get-world-info` returns an unrecognized system.** Emit `UNKNOWN_FOUNDRY_SYSTEM`. The
  operator may choose `proceed-anyway` (we degrade to system-agnostic behavior) or fix +
  retry.
- **Zero party-actor candidates.** Emit `NO_PARTY_ACTORS` critical. No `proceed-anyway`
  option (there's literally nobody to play). Operator must add actors in Foundry.
- **A mapped player's character requires content that isn't loaded** (e.g., Fairy race
  needs _Witchlight_ and it's not in `loadedModules`). Per §9.7, emit `MISSING_RACE_CONTENT`
  as critical with a `proceed-anyway` resolution option; the AI improvises from
  SRD-adjacent content during play and logs the gap throughout (the log path is the audit
  log + the `intake.finding.surfaced` telemetry event below).
- **All findings spoiler-laden for the operator-as-player.** When every operator decision
  would leak context, the report still delivers — `dmOnly: true` markers warn the operator
  before they read. The operator chooses whether to look; if they decline, the AI proceeds
  with its default (the "Recommendation" version of the finding) and logs the deferral.
- **Operator resolves a finding mid-onboarding.** Resolution semantics are
  _handler-driven_, not poll-driven: each finding kind has a known resolution-handler that
  the slash-command (and the web-UI mirror) calls when the operator picks. The handler
  writes `SessionConfig.intake.resolvedFindings` AND synchronously triggers the action the
  resolution implies — for example, the `AMBIG_STARTING_SCENE` handler calls TDD 0032's
  `activateScene` directly upon resolution. There is therefore no race between an
  autosetup dispatch and an operator resolution: the autosetup runs `chooseInitialScene`
  exactly once, and its branches are exhaustive (`'unambiguous'` → activate now;
  `'ambiguous'` → defer to the resolution handler; `'none'` → critical, block). Already-
  completed autonomous actions are not unwound (idempotency is TDD 0032's concern); the
  live-session override path (a separate operator control, not a finding resolution) is
  the mid-session correction mechanism.
- **Re-Start within the same session** (operator hit start twice, or the orchestrator
  crash-recovered). Minimum intake re-runs (deterministic, cheap); extended intake's
  incremental path (TDD 0032's indexing diff) avoids redundant work.
- **`notify_operator` channel unavailable** (operator's Discord DMs disabled). TDD 0023
  already handles this: the orchestrator surfaces the same content on the web console's
  live-session view (ADR-0016 parity). The minimum-intake gate still blocks on critical
  findings; the operator clears them from the console.
- **Operator answers a slash-command resolution that no longer applies** (extended intake
  was re-run and the ambiguity is gone). The handler is idempotent — already-resolved or
  no-longer-present findings reply with "already resolved / no longer applicable"; nothing
  mutates.

## Requirement traceability

| PRD ref                           | Requirement                                                                                                                                                                                                                                                     | Satisfied by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.8 (intake routine)              | "On Start, the AI reads: the Foundry world, Skeinkeeper warm state, the intersection"                                                                                                                                                                           | `runMinimumIntake` + `runExtendedIntake`; Foundry read adapters; `WarmStateSummary`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 4.8 (intake report)               | "produces a structured intake report and surfaces it to the operator via `notify_operator`"                                                                                                                                                                     | `IntakeResult` types; `formatIntakeReportForDm`; `notify_operator` delivery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4.8 (critical gaps)               | "block Start: required content wholly missing; no compatible system; no party-actor candidates; required race/class missing"                                                                                                                                    | `classifyCriticalGaps` codes `UNKNOWN_FOUNDRY_SYSTEM`, `NO_PARTY_ACTORS`, `MISSING_RACE_CONTENT`, `MISSING_CLASS_CONTENT`; minimum-intake gate blocks `announceReady`                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 4.8 (ambiguities)                 | "require operator preference between equally-valid options"                                                                                                                                                                                                     | `classifyAmbiguities` codes + `ResolutionOptions` choice set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 4.8 (recommendations)             | "AI proposes; operator may override"                                                                                                                                                                                                                            | `classifyRecommendations`; informational rendering; `SessionConfig.intake.resolvedFindings` for overrides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 4.8 (concurrency model)           | "minimum intake before announcing readiness; source-material indexing and content pre-loading run concurrently with onboarding"                                                                                                                                 | Minimum-intake gate on `announceReady`; extended intake kicked off in parallel (this TDD); TDD 0032 owns the concurrent indexing/preload                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 4.8 (spoiler-aware escalations)   | "framed to elevate a _choice_ without surfacing the _context_ of the choice when context would spoil"                                                                                                                                                           | `buildFindingSummary` + spoiler heuristic table; `dmOnly` flag + delivery marker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4.8 (operator-as-host principle)  | "default is to proceed with what it inferred and tell the operator after the fact; silence is success"                                                                                                                                                          | Minimum/extended split; informational rendering for recommendations; `proceed-anyway` for §9.7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 3 (operator persona reframe)      | "AI handles in-play DM duties **and** the setup work that a human DM would do between sitting down and starting the game — assessing materials, picking the starting scene, mapping characters to players, deciding which monster stat block to use (see §4.8)" | Intake is the _assess materials_ half; TDD 0032 covers the _write_ actions (picking scene, mapping, stat-block prep)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 9.6 (intake escalation UX)        | "single structured DM with embedded reply controls (slash-command response per item)"                                                                                                                                                                           | `formatIntakeReportForDm` single-DM layout; `/skeinkeeper intake resolve` handler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 9.7 (hard-gap policy)             | "proceed with operator acknowledgement; AI improvises reasonably during play and logs the gap"                                                                                                                                                                  | `MISSING_RACE_CONTENT` / `MISSING_CLASS_CONTENT` with `proceed-anyway` resolution; audit log + `intake.finding.surfaced` telemetry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 9.8 (spoiler-safe framing)        | "conservative default at v0.5; explicit DM-only flag when context is required"                                                                                                                                                                                  | Spoiler heuristic table; `dmOnly` delivery marker; "I'm also a player" toggle deferred per PRD                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| §3 (operator override via web UI) | "can override any AI decision via the web UI's live-session view"                                                                                                                                                                                               | `/skeinkeeper intake resolve` is mirrored by a web-UI control per ADR-0016 (one write path → `SessionManager`; this TDD exposes the method and surfaces it on both). **Implementer note:** landing this TDD requires extending TDD 0025's control-table with a new "Intake finding resolution" row covering both the slash-command and the web-console control; without that, ADR-0016 is violated. Live-session mid-session correction (e.g., switching active scene after an `RECO_PROPOSED_STARTING_SCENE` was activated) is a separate, already-existing operator control on the same `SessionManager` write path. |

## Dependencies considered

None. The design reuses `FoundryClient` (TDD 0014), `MemoryStore` (TDD 0019), the
`notify_operator` Discord DM channel (TDD 0023), `SessionConfig` persistence, and the
operator-controls write path (TDD 0025).

No new third-party libraries are introduced. The spoiler classifier is a static heuristic
table, not a model dependency. A language-model-driven spoiler classifier was considered
and rejected: the operator's decisions gate Start, so determinism + auditability matter
more than coverage; LLM-driven classification would also make replay non-deterministic.

## PRD conflicts surfaced (and resolution)

1. **ADR-0015 conflict (boundary) — resolved by ADR-0023.** ADR-0015 §Decision said
   "Pre-game = the operator … in-play = Skeinkeeper." §4.8 explicitly moves pre-game
   intake, character mapping, scene activation, and content pre-loading onto the AI side,
   narrowing the operator's pre-game work to host-level tasks. **Resolution:** the design
   pass that produced this TDD also promoted [ADR-0023](../adr/0023-operator-as-host-model.md)
   (operator-as-host), which supersedes ADR-0015 with the new boundary. ADR-0015 is now
   superseded; this TDD designs against ADR-0023 directly.
2. **§9.6 (escalation UX) — adopted.** The PRD's recommendation (single structured DM +
   per-item slash-command response) becomes the design. Promoted below.
3. **§9.7 (hard-gap policy) — adopted.** Proceed-with-operator-acknowledgement chosen over
   refuse-to-Start or SRD-improvise-silently. The AI logs the gap throughout the session
   (audit log + telemetry) so post-session the operator can see what was improvised.
4. **§9.8 (spoiler-safe framing) — adopted.** Heuristic table is the v0.5 answer; the
   "operator is also a player" toggle deferred per the PRD.
5. **TDD 0023 preconditions** (the "Start preconditions" line: "the campaign's character
   actors exist + are named") narrows under §4.8 + this TDD: actors must still _exist_ in
   Foundry, but mapping them to Discord users and assigning Foundry ownership is intake's
   job, not the operator's. The TDD 0023 precondition wording will need a one-line revision
   when this TDD ships; flagged for the implementer in step 8 of the sequencing plan.

## Decisions to promote (ADR candidates)

- **Operator-as-host model (supersedes ADR-0015)** — _promoted to
  [ADR-0023](../adr/0023-operator-as-host-model.md)_ in this design pass.
- **Autonomous-by-default operator escalation discipline ("silence is success")** —
  _promoted to [ADR-0024](../adr/0024-silence-is-success-operator-escalation.md)_ in this
  design pass.
- **Spoiler-aware operator-escalation framing** — evaluated; not promoted. The heuristic
  table is design rather than architecture and lives in `buildFindingSummary` (this TDD).
  Captured-in-TDD only.

## Telemetry implications

New events in `/telemetry/src/events.ts` (and `/docs/telemetry-events.md`):

| Event                       | Payload                                                                      | Description                                  |
| --------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| `intake.minimum.started`    | `{ campaignId, sessionId }`                                                  | Minimum intake began                         |
| `intake.minimum.completed`  | `{ campaignId, sessionId, durationMs, criticalCount }`                       | Minimum intake finished                      |
| `intake.extended.completed` | `{ campaignId, sessionId, durationMs, ambiguityCount, recommendationCount }` | Extended intake finished                     |
| `intake.finding.surfaced`   | `{ campaignId, sessionId, findingCode, kind, dmOnly }`                       | A finding was delivered to the operator      |
| `intake.finding.resolved`   | `{ campaignId, sessionId, findingCode, resolutionId, latencyMs }`            | Operator resolved a finding                  |
| `intake.gate.blocked`       | `{ campaignId, sessionId, blockingFindings: FindingCode[] }`                 | `announceReady` blocked by critical findings |

All payloads PII-free per ADR-0010. Counts + codes only; no operator/player names, no
detail strings, no Foundry IDs.

## Privacy implications

No new personal-data processing. The intake report references Foundry actor display names
and Discord display names already in scope (operator-supplied, ADR-0007); no new PII column,
no encryption change (ADR-0022 unaffected). The `session_intake_finding` table is PII-free
by construction — only stable codes + summary text generated from the rubric (which is
itself constructed from non-PII Foundry metadata). The audit-log cross-reference inherits
existing audit-log privacy posture per ADR-0010.

`detail` strings _may_ carry character/NPC names from the Foundry world; those are
operator-owned content per ADR-0007, not personal data about real players. Tenant scoping
per ADR-0008 keeps them isolated.

## Eval implications

Scenario fixtures required before this ships:

1. **Clean session, no findings.** Foundry has one campaign module, one starting scene
   pre-active, party actors pre-mapped → minimum + extended intake produce zero
   operator-visible findings → `announceReady` fires immediately.
2. **Multiple modules ambiguity.** LMoP + Ravenloft both loaded → `MULTIPLE_CAMPAIGN_MODULES`
   ambiguity → DM payload renders the choice; slash-command resolution writes to
   `SessionConfig.intake`.
3. **Missing-race critical.** A mapped player's character has a Fairy race; _Witchlight_
   not loaded → `MISSING_RACE_CONTENT` critical with `proceed-anyway` resolution.
4. **Ambiguous starting scene with spoiler context.** Two equally-plausible starting scenes
   → `AMBIG_STARTING_SCENE` with `dmOnly: true`; DM payload includes the DM-only marker.
5. **Re-Start with prior decisions.** Same campaign, second session → `SessionConfig.intake`
   honors prior chosen module/pack/scene; zero operator-visible findings on the second run.
6. **Concurrency contract.** Onboarding ritual begins after minimum intake completes;
   extended intake completes during onboarding; report delivery does not block onboarding's
   first turn.

Each classifier function gets unit tests per `FindingCode`. Integration tests cover the
orchestrator gate behavior using `MockFoundryClient` and `FakeMcpToolCaller`.
