# TDD 0036: Session Onboarding, Foundry-User Pre-Flight, 3-Way Identity, and Operator Escalation on Foundry

Status: implemented
PRD refs: 4.1, 4.2, 4.6, 4.8, 5.8
PRD-rev: 5c3a198
ADR constraints: 0008, 0010, 0016, 0017, 0018, 0023, 0024, 0025, 0026, 0029, 0030
Supersedes: [TDD 0023](./0023-session-onboarding-presence-operator-channel.md), [TDD 0016](./0016-player-character-identity-mapping.md)
Author: maintainers
Date: 2026-05-26
Related TDDs: [0011 (orchestrator turn loop)](./0011-orchestrator-turn-loop.md), [0015 (always-listening loop)](./0015-always-listening-voice-loop.md), [0020 (operator app)](./0020-operator-app.md), [0024 (operator self-designation)](./0024-operator-self-designation.md), [0031 (session intake & intake report)](./0031-session-intake-and-intake-report.md), [0032 (autonomous pre-game setup actions)](./0032-autonomous-pre-game-setup-actions.md), [0034 (surface routing & I/O abstraction)](./0034-surface-routing-and-io-abstraction.md), [0041 (first-party Foundry add-on)](./0041-first-party-foundry-addon.md), [0040 (operator control parity — Foundry chat commands)](./0040-operator-control-parity-foundry-chat-commands.md)

## Carries forward / supersedes (read first)

This TDD supersedes both [TDD 0023](./0023-session-onboarding-presence-operator-channel.md) (session onboarding + operator-in-Discord channel) and [TDD 0016](./0016-player-character-identity-mapping.md) (player↔character identity mapping). The two concerns are tightly coupled — onboarding is exactly where identity gets bound — and the surface-model PRD revision affects both: it changes the operator-escalation destination AND extends the identity mapping from 2-way to 3-way. Append-only discipline (both TDDs were `implemented`) requires new documents; consolidating them into one supersession is acceptable per the design-pass plan, recorded for the design-reviewer.

**Carried forward from TDD 0023 unchanged:**

- **Voice presence model.** `VoiceIO` exposes a `presence` event with the current member set on the target Discord voice channel; the always-listening loop tracks who's joined/left; `FakeVoiceIO` emits them for tests.
- **Onboarding turns (the ritual).** Per-lull computation of "awaiting onboarding" (consented members present − already-mapped − already-greeted-this-session); a small pure helper (`selectOnboardingTargets`) does the set math, unit-tested. Onboarding turns bypass the eagerness "should I respond?" decider — onboarding is deliberate ritual, not a judgment call.
- **The empty-channel / full-room invariants.** Empty channel → no chatter; someone present & awaiting on a lull → onboarding turn; full room at Start → group greeting + go-around.
- **`notify_operator` as the operator-escalation tool** (LLM-callable, used for setup escalations and any operator-facing exchange). What changes is its delivery destination; the tool itself carries forward.
- **Operator pre-flight required before Start:** Foundry running + bridge connected; player Discord-channel invites; campaign content loaded. Extended in this TDD with Foundry-user + actor-ownership requirements (see §1).

**Carried forward from TDD 0016 unchanged:**

- **Player-initiated mapping at session start via the intro ritual.** The AI asks each player who they're playing; extracts the character name; resolves to a Foundry actor.
- **Name → Foundry-actor resolution** via FoundryClient.listPartyActors + fuzzy matching (case-insensitive, nickname-tolerant). Ambiguity or no-match → clarifying question; still-unresolved → operator escalation, not blocking the table.
- **`record_player_character` LLM-callable tool.** Upserts the map row; audit-logs. Carries forward; extended this TDD to also bind the Foundry user ID (3-way).
- **Operator override path.** The operator can correct any mapping; operator-set rows carry `source: "operator"` and win over player-set rows. Surface for the override moves to Foundry chat commands (TDD 0040); the data model is unchanged.

**Substantively changed in this TDD:**

- **`notify_operator` destination flips from Discord DM to Foundry chat.** Lands as GM-only chat (or whisper to the operator's Foundry user when known) via TDD 0034's `FoundryGmChatSurface` with `meta.escalation: true`. The single-chat-surface argument that motivated the Discord-DM channel in 0023 §4 carries forward — there's still one operator-facing chat surface — but the surface is now Foundry, not Discord, because the PRD §4 Surface model narrows Discord to voice + one-time consent only.
- **3-way identity mapping.** Discord ID ↔ Foundry user ↔ character actor (was Discord ID ↔ Foundry actor). The Foundry-user binding is necessary because PRD §4.2 / §4.6 / §4.7 / §5.5 now route per-player text through Foundry whisper, which addresses Foundry users (not actors). The Foundry-user-with-actor-ownership relationship is operator pre-flight (host responsibility); the AI verifies it; missing ownership is a critical gap that blocks Start.
- **Defense-in-depth pre-flight verification.** Pre-flight runs at two lifecycle points: at Start (intake stage, blocking) AND on first voice-join per player (per-player blocking for that player's participation; doesn't block the rest of the table). This is the design-pass decision; the rationale is that Start covers seated-at-Start players and voice-join covers late-joiners + post-Start operator changes.
- **Web console fallback is degraded, not absent.** TDD 0023 said "If `DISCORD_OPERATOR_USER_ID` is unset, escalations fall back to the console log, degraded." Under the new design, the analogous fallback is: if no operator Foundry user is identified (operator hasn't claimed; intake pre-flight failed; `notify_operator`'s whisper-to-operator path has no recipient), escalations land in GM-broadcast Foundry chat AND in the web console's escalation pane. The web console remains a degraded fallback, not the primary path.
- **TDD 0024 (operator self-designation) is NOT superseded by this TDD.** Per the design-pass decision: 0024's data model + designation mechanism carry forward unchanged; only its `/skeinkeeper operator action:claim` second-surface row in the parity table moves from Discord slash to Foundry chat, which is TDD 0040's responsibility. 0024 stays implemented; this TDD references it.

## Approach

The shipped onboarding + identity design (0023 + 0016) is structurally correct: voice presence is the load-bearing capability that makes the ritual real; the player-initiated mapping ritual is warmer than a setup screen; operator escalations belong on one operator-facing chat surface. The two substantive changes from the PRD revision — _Foundry chat is the operator-facing chat surface_ and _per-player text needs a Foundry-user identity_ — are surgical updates to those shipped designs, not a wholesale redesign. This TDD makes the surgical updates, names the new pre-flight + critical-gap semantics, and absorbs both 0023's and 0016's concerns into a single consolidated design because the 3-way identity is established during onboarding.

### 1. Operator host pre-flight (extended)

PRD §4.6 + §4.8 + ADR-0023 say the operator does host work; the AI does DM work. The new host pre-flight, in full:

| Pre-flight item                                                                                                                                                                                  | Carried from 0023? | New in this TDD? |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------: | :--------------: |
| Foundry is running with the campaign content loaded                                                                                                                                              |        Yes         |        —         |
| The Skeinkeeper Foundry add-on is connected (TDD 0041; Start fails closed if not)                                                                                                                |        Yes         |        —         |
| A Discord voice channel exists; the bot has been invited                                                                                                                                         |        Yes         |        —         |
| Skeinkeeper is running with credentials configured (§4.5)                                                                                                                                        |        Yes         |        —         |
| Each player has an invite to the Discord voice channel                                                                                                                                           |        Yes         |        —         |
| **Each player has been added as a Foundry user** (own login)                                                                                                                                     |         —          |       Yes        |
| **Each player's Foundry user owns their intended character actor**                                                                                                                               |         —          |       Yes        |
| **A DM-Foundry-user exists for side-channel whisper routing** (typically the operator's GM user; required to be distinct from the operator's player-Foundry-user when operator is also a player) |         —          |       Yes        |

Pre-flight is operator responsibility. The AI verifies, escalates on critical gaps, and **does not** create Foundry users / does not auto-assign actor ownership — that's host work, per ADR-0023. The 0032 design's prior plan to AI-perform `assign-actor-ownership` is rescoped (see TDD 0032 in-place revision).

### 2. The 3-way identity map

The `player_character_map` table from TDD 0016 gains a third column. The shape:

```ts
player_character_map: {
  id, tenantId,
  campaignId,
  discordUserId,       // PII; the player's Discord identity (carried from 0016)
  foundryUserId,       // NEW; the player's Foundry login (host pre-flight binding)
  foundryActorId,      // carried from 0016
  displayName,         // carried from 0016 (the player's spoken/display name)
  source,              // "player" | "operator" (carried from 0016)
  confirmedAt,         // carried from 0016
}
// unique on (tenantId, campaignId, discordUserId); most recent wins (player remap on character swap)
```

Migration: `foundryUserId` is `NULL`-tolerant on read (existing rows pre-migration have no Foundry user); a `NULL` Foundry user is treated identically to "Foundry user unresolved" — the pre-flight verifier surfaces it as a critical gap for affected players. There is no synthetic backfill (we can't guess Foundry users); the operator runs `/skeinkeeper map` for each affected player on the first v0.5 session to bind. The migration adds the column, indexes `(tenantId, campaignId, foundryUserId)`, and updates `PlayerCharacterMapAdapter`'s erasure path to clear all three IDs.

### 3. The pre-flight verifier (the defense-in-depth design)

Two check-points run the same verifier with different inputs.

#### 3a. Verifier function (pure)

```ts
// orchestrator/intake/preflight-identity.ts
export interface IdentityPreflightInput {
  campaignId: string;
  expectedPlayers: ReadonlyArray<{ discordUserId: string; displayName?: string }>;
  foundryUsers: ReadonlyArray<{
    id: string;
    name: string;
    role: "GAMEMASTER" | "ASSISTANT" | "TRUSTED" | "PLAYER";
    ownedActorIds: ReadonlyArray<string>;
  }>;
  identityMap: ReadonlyArray<{
    discordUserId: string;
    foundryUserId?: string;
    foundryActorId?: string;
  }>;
  dmFoundryUserId?: string; // the designated "DM" Foundry user for side-channel routing
  operatorFoundryUserId?: string; // resolved from TDD 0024's operator-self-designation
}

export interface IdentityPreflightResult {
  status: "ok" | "critical-gaps" | "warnings-only";
  findings: ReadonlyArray<IdentityPreflightFinding>;
}

export type IdentityPreflightFinding =
  | { kind: "no-foundry-user"; discordUserId: string; displayName?: string } // critical
  | {
      kind: "foundry-user-not-owning-actor";
      discordUserId: string;
      foundryUserId: string;
      foundryActorId: string;
    } // critical
  | { kind: "no-dm-foundry-user-designated" } // critical (per §"Carries forward" PRD-conflict #1 in TDD 0035)
  | { kind: "dm-foundry-user-is-operator-player-user"; foundryUserId: string } // critical when operator-as-player; warning otherwise
  | { kind: "operator-foundry-user-not-gm-role"; foundryUserId: string } // warning
  | { kind: "extra-foundry-users-not-mapped"; foundryUserIds: ReadonlyArray<string> }; // info only
```

The verifier is pure: same input → same output; CI-testable per finding kind.

#### 3b. Check at Start (intake stage)

Runs as part of TDD 0031's extended intake (`runExtendedIntake`). Inputs: the campaign's `player_character_map` rows + `FoundryClient.listUsers()` (TDD 0041) + the seated-player set (Discord-channel members with consent) + the operator-Foundry-user (TDD 0024) + the DM-Foundry-user (campaign config).

- **Status `critical-gaps`** → blocks Start. Findings surface in the intake report (TDD 0031); `notify_operator` escalation lands in Foundry GM chat (per §4 below) with one line per critical finding plus a single resolution prompt: "Add the listed Foundry users + actor ownership and retry Start."
- **Status `warnings-only`** → does NOT block Start; warnings surface in the intake report's "FYI" section.
- **Status `ok`** → silent. (Silence-is-success per [ADR-0024](../adr/0024-silence-is-success-operator-escalation.md).)

#### 3c. Check at first voice-join (per player)

Runs in the always-listening loop when a presence event reports a new member joining the voice channel. The same verifier runs with a single-player input (`expectedPlayers = [thatPlayer]`).

- **Status `critical-gaps` for this player** → the player IS allowed to be on voice (so the table-state isn't disrupted) but the AI does NOT onboard them; their utterances are recorded with `audience.player = unmapped` and dispatched to no conversation; they get a one-time courtesy private message via TDD 0034's `DiscordConsentSurface` directing them to the operator: "Your Foundry user isn't set up yet — flag your DM." The operator sees a `notify_operator` Foundry escalation: "Player <displayName> joined voice; their Foundry user / actor ownership isn't configured — please add and `/skeinkeeper preflight verify @<player>`." The operator runs the command (see TDD 0040); the verifier re-checks; on `ok` the player gets onboarded on the next lull.
- **Status `warnings-only` for this player** → onboard normally; the warning rolls into the operator-channel digest (a future "session summary" payload, not implemented v0.5 — for now, the warning is logged + escalated as a single line).
- **Status `ok`** → onboard normally per the carried-forward 0023 ritual.

The two checks share the same verifier and the same finding shapes. The check at voice-join is what catches late-joiners (who weren't seated at Start) and post-Start operator changes (operator added a Foundry user mid-session).

### 4. Operator escalation channel — on Foundry, not Discord

The `notify_operator` LLM-callable tool emits via TDD 0034's router:

```ts
// orchestrator/tools/notify-operator.ts
async function handleNotifyOperator(args: {
  content: string;
  severity?: "info" | "warning" | "critical";
}) {
  await router.emit({
    audience: { kind: "gm" },
    text: args.content,
    meta: { escalation: true, severity: args.severity ?? "info" },
  });
}
```

The router (TDD 0034 §2) handles the `escalation: true` flag: emits via `FoundryGmChatSurface`, and additionally writes a whisper to the operator's Foundry user when one is known (per TDD 0034's resolution rule). The orchestrator-side audit log records the escalation per [ADR-0010](../adr/0010-privacy-as-architecture.md); the operator console's escalation pane echoes via the SSE bus for the degraded-fallback case.

#### Resolution path

The 0023 design said "the operator corrects things via the existing override path (slash command / future buttons), also in Discord." That maps to TDD 0040's Foundry-chat-command surface now. Operator-resolution commands relevant to this TDD:

- `/skeinkeeper map @<discord-user> <character>` — operator-set mapping (carried from 0016's web-UI + Discord slash override, now on Foundry chat per the surface model).
- `/skeinkeeper preflight verify` — re-run the verifier (after operator has added a Foundry user, etc.); reports findings inline as a whisper to the operator's Foundry user.
- `/skeinkeeper preflight verify @<discord-user>` — re-run the per-player check after operator action.
- `/skeinkeeper intake resolve <id> <option>` — resolve an intake finding (TDD 0031 + 0032 surface, used here for ambiguity findings — e.g., two equally-plausible character matches).

The verb taxonomy lives in TDD 0040; this TDD names the commands that resolve this design's escalations.

### 5. The onboarding ritual (carried forward, transport-adjusted)

The 0023 ritual is unchanged in its conversational shape: greet on lull, ask who-and-which-character, listen for the answer, resolve, record, confirm. The only changes:

- **The AI's confirmations + the operator's escalations land in Foundry chat surfaces, not Discord text**, via TDD 0034. The AI's "Got it — Chris is playing Aragorn" lives in `table`-audience surface emit (Foundry public chat + voice TTS), not Discord text.
- **The `record_player_character` tool gains an optional `foundryUserId` field** populated from the 3-way map lookup at the time of recording: when the AI records the player↔actor mapping, it also reads `listUsers()` to find which Foundry user owns that actor, and writes the Foundry user ID into the same row. If no Foundry user owns the actor (operator pre-flight gap), the tool records the row with `foundryUserId = NULL` AND emits a `notify_operator` escalation: the player has been provisionally mapped to an actor that has no owner; operator needs to add the Foundry user + ownership and re-verify.
- **The ritual does NOT call `assign-actor-ownership`.** Per the rescope of TDD 0032 in this design pass, ownership assignment is host pre-flight, not an AI action. The AI verifies; it does not create.

### 6. Voice presence + Foundry presence (refined)

Voice presence (Discord) was the ONLY presence signal in 0023. Under the new surface model, **Foundry presence** is also relevant — a player on voice but not in Foundry (the visual + table-text surface) can't participate in table text; their utterances arrive via voice but they have no path to read the table-text mirror.

This TDD adds a lightweight Foundry-presence check derived from `listUsers()` polling: `isActive` per-Foundry-user reports whether the user is currently logged into Foundry. The check happens at session start (intake stage) and is re-polled on a low-frequency cadence (~60s) during the session. The Coordinator (via TDD 0034's router) tracks per-player Foundry-presence and surfaces a `presence.foundry.dropped` event when a previously-present player goes inactive.

- **Foundry-presence drop is NOT a session-pause condition.** Only Foundry-the-bridge dropping pauses the session (TDD 0039). A single player going inactive in Foundry is logged + the operator sees a `notify_operator` info-level escalation; the AI continues with the rest of the table; the absent player's table-text mirror won't reach them but voice still does. If they reconnect, Foundry restores their chat-log catch-up natively.

Voice presence carries forward unchanged; Foundry presence is the new signal.

### 7. The operator-as-player case (refined)

PRD §4.8's "spoiler-aware escalations" framing acknowledges the operator may also be a player. This TDD's identity model accommodates it:

- The operator's `discordUserId` and the operator's player `foundryUserId` are bound like any other player in the 3-way map.
- The operator-Foundry-user used for `notify_operator` whisper routing is a SEPARATE Foundry user (typically a dedicated GM user, set up by the operator at host pre-flight) — NOT the operator's player Foundry user. Otherwise operator escalations whispered to the operator-as-GM-user are visible only via the GM-user's Foundry session, while the operator is logged in as their player-user — they'd miss the whisper.
- The pre-flight verifier raises `dm-foundry-user-is-operator-player-user` as critical when the operator is also a player AND has not designated a distinct GM user; raises it as a warning otherwise (operator-as-pure-host case has no degeneracy).
- The PRD's spoiler-aware-escalation principle (§4.8) is _content-side_ behavior-spec policy ("frame the choice, not the context, when context spoils"); this TDD's routing delivers what the orchestrator emits, framed as the behavior spec instructs.

## Components & interfaces

### Verifier (pure)

```ts
// orchestrator/intake/preflight-identity.ts
export function verifyIdentityPreflight(input: IdentityPreflightInput): IdentityPreflightResult;
```

Pure function; per-finding-kind unit-tested with fixed inputs.

### Coordinator integration

- **Start (intake stage):** `runExtendedIntake` (TDD 0031) calls `verifyIdentityPreflight` with full inputs; embeds the result in the intake report; blocks `announceReady` if `status: "critical-gaps"`.
- **Voice-join:** the always-listening loop's `presence` event handler calls `verifyIdentityPreflight` with single-player input; if `critical-gaps`, suppresses onboarding for that player + emits the one-time courtesy DM + emits `notify_operator`.

### `record_player_character` (extended)

```ts
// orchestrator/tools/record-player-character.ts
async function handleRecordPlayerCharacter(args: {
  campaignId: string;
  discordUserId: string;
  foundryActorId: string;
  displayName: string;
}) {
  const users = await foundry.listUsers();
  const owningUser = users.find((u) => u.ownedActorIds.includes(args.foundryActorId));
  await tenantDb.playerCharacterMap.record({
    ...args,
    foundryUserId: owningUser?.id ?? null,
    source: "player",
    confirmedAt: now(),
  });
  if (!owningUser) {
    await router.emit({
      audience: { kind: "gm" },
      text: `Recorded ${args.displayName} → ${args.foundryActorId}, but no Foundry user owns that actor. Add a Foundry user + grant ownership; then \`/skeinkeeper preflight verify @<player>\`.`,
      meta: { escalation: true, severity: "warning" },
    });
  }
}
```

### `notify_operator` (rewired)

```ts
// orchestrator/tools/notify-operator.ts
async function handleNotifyOperator(args: {
  content: string;
  severity?: "info" | "warning" | "critical";
}) {
  await router.emit({
    audience: { kind: "gm" },
    text: args.content,
    meta: { escalation: true, severity: args.severity ?? "info" },
  });
}
```

The router resolves `gm` + `escalation: true` → `FoundryGmChatSurface` write + (when operator-Foundry-user is known) a whisper to that user. Web console SSE echo for the degraded-fallback path is automatic via the existing `AppEvent` bus.

### Pre-flight check schedule

- **At Start:** synchronously runs as part of intake; blocking on critical gaps.
- **On voice-join presence event:** synchronously runs the per-player verifier in the always-listening loop's handler; non-blocking to the rest of the table.
- **On `/skeinkeeper preflight verify`** operator command (TDD 0040 surface): re-runs the verifier; reports findings inline via `FoundryGmChatSurface` whisper.

### File layout

| Module                                                 | Lives in                                         | Owner                                             |
| ------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------- |
| `verifyIdentityPreflight` + finding types              | `orchestrator/intake/preflight-identity.ts`      | New, this TDD                                     |
| `record_player_character` (extended)                   | `orchestrator/tools/record-player-character.ts`  | Extends TDD 0016's handler                        |
| `notify_operator` (rewired)                            | `orchestrator/tools/notify-operator.ts`          | Rewired from TDD 0023's Discord-DM implementation |
| `selectOnboardingTargets` + presence reducer           | `orchestrator/sessions/always-listening-loop.ts` | Carried from TDD 0023 unchanged                   |
| `player_character_map` migration (add `foundryUserId`) | `server/migrations/`                             | New, this TDD                                     |

## Data & state

### Schema migration

```sql
-- server/migrations/NNNN-add-foundry-user-to-player-character-map.sql
ALTER TABLE player_character_map ADD COLUMN foundry_user_id TEXT NULL;
CREATE INDEX idx_pcm_tenant_campaign_foundry_user
  ON player_character_map (tenant_id, campaign_id, foundry_user_id);
```

Existing rows have `foundry_user_id = NULL` post-migration. The pre-flight verifier treats `NULL` as a `no-foundry-user` finding for that player; the operator's first v0.5 session triggers per-player `/skeinkeeper map` or auto-rebind via the onboarding ritual on next session.

### Erasure adapter (extended)

`PlayerCharacterMapAdapter` (existing per TDD 0016) deletes by `(tenantId, discordUserId)`. With the new column, a player's erasure removes their row including the `foundryUserId` — the Foundry-user link is itself `PII<>` (it associates a person with a Foundry login). The deletion adapter's interface is unchanged; the row-delete is column-complete.

### No Foundry-side persistent state added

The Foundry-user ↔ actor-ownership relationship lives in Foundry per [ADR-0018](../adr/0018-foundry-source-of-truth.md); Skeinkeeper queries it via `listUsers()` and does not persist a mirror. The 3-way map's `foundryUserId` column is a binding _for routing convenience_ (so the surface adapter doesn't call `listUsers()` per emit), not a system-of-record claim.

## Sequencing / implementation plan

1. **Schema migration.** Add `foundry_user_id` column + index; update `PlayerCharacterMapAdapter` types.
2. **`verifyIdentityPreflight` pure verifier** + per-finding-kind unit tests.
3. **`record_player_character` extension.** Read `listUsers()` at record-time; populate `foundryUserId`; emit a warning escalation when no owner found.
4. **`notify_operator` rewire.** Replace the Discord-DM bot send with `router.emit({ audience: gm, meta: { escalation: true } })`. Delete the dormant Discord-DM listener (preserved only for one-time consent in TDD 0034's `DiscordConsentSurface`).
5. **Pre-flight at intake stage.** Wire `runExtendedIntake` to call the verifier; embed results in the intake report; block `announceReady` on critical gaps (TDD 0031 coordinates).
6. **Pre-flight at voice-join.** Wire the always-listening loop's `presence` handler to run the per-player verifier; suppress onboarding for critical-gap players; emit the one-time courtesy private DM + a `notify_operator`.
7. **Foundry-presence polling.** Background job (60s cadence) calls `listUsers()` for the active campaign; tracks `isActive` per mapped player; emits `presence.foundry.dropped` on transitions.
8. **`/skeinkeeper preflight verify` + `/skeinkeeper preflight verify @<player>`** operator commands in TDD 0040's command set; wire the inline-report response via `FoundryGmChatSurface` whisper.
9. **PRIVACY.md update** (co-shipped with this TDD's commit): `discordUserId` + `foundryUserId` both `PII<>`; both erased on player-erasure; the operator-visibility paragraph names Foundry GM-view + Skeinkeeper console replay (overlaps with TDD 0035's update).
10. **CONTRIBUTING.md note:** the 3-way map is the canonical identity binding; new features that scope per-player should reference the Discord user ID as the primary key (continuity with TDD 0016) and consume `foundryUserId` via the map when needed.

## Failure modes & edge cases

- **Foundry user added by operator mid-session, after a player's onboarding was suppressed.** Operator runs `/skeinkeeper preflight verify @<player>`; verifier re-runs and returns `ok`; the player's next utterance on voice or next chat-public message dispatches normally (the always-listening loop's "awaiting onboarding" set re-includes them on the next lull; they're greeted as if they just joined). Late-binding works without restart.
- **Player removes consent mid-session.** Carried from 0012 + 0023 — voice transcription stops; the player's row in the identity map persists until per-player erasure runs (CLI). No new failure mode in this TDD.
- **Operator-Foundry-user resolution fails** (TDD 0024 hasn't designated; env var unset; console picker unused). `notify_operator` whisper-to-operator path has no recipient; the router falls back to GM-broadcast in Foundry chat AND echoes via the SSE bus to the web console's escalation pane. Operator still sees the escalation, just not as a focused whisper.
- **`listUsers()` fails** (bridge transient error). Pre-flight verifier returns a defensive `warnings-only` with one finding `bridge-listusers-unavailable`; intake report surfaces the warning; Start is NOT blocked (the gap is bridge-side, not host-side); pre-flight re-runs on the next bridge-recovered tick.
- **`listUsers()` returns inconsistent owned-actor data** (a player's actor is reported owned by no user, or by multiple users). The verifier classifies as a critical finding per-player (`foundry-user-not-owning-actor`); operator must resolve in Foundry; re-run verifier.
- **A player swaps characters mid-campaign.** `record_player_character` is called again with the new actor; the row's `foundryActorId` is updated; the verifier re-runs on the next pre-flight cycle to confirm the new actor's ownership.
- **The operator IS the player AND the GM Foundry user.** Verifier emits `dm-foundry-user-is-operator-player-user` as critical; operator must designate a distinct DM Foundry user in campaign config; can't `notify_operator`-whisper themselves to themselves in a way the operator-as-player will see distinctly from in-fiction content.
- **3-way map row exists but the Foundry user no longer exists** (operator deleted the user in Foundry). Verifier emits `foundry-user-not-owning-actor` (the user-id-to-actor join fails); operator resolves by re-adding the Foundry user OR by running `/skeinkeeper map` to bind a different user.
- **Pre-flight at voice-join fires before identity-map row is written** (a brand-new player joining voice for the first time). The map row doesn't exist yet; the verifier emits `no-foundry-user`; the player's onboarding is suppressed; on operator action they're added in Foundry and the verifier re-runs; the onboarding ritual then runs on the next lull and records the row.

## Verification plan

- **Verifier — `no-foundry-user`.** _Observable surface:_ `verifyIdentityPreflight`'s return value. _Observation point:_ unit test — `expectedPlayers: [{ discordUserId: "d1" }]`, `identityMap: [{ discordUserId: "d1", foundryUserId: undefined }]`. _Expected:_ `status: "critical-gaps"`, one finding `{ kind: "no-foundry-user", discordUserId: "d1" }`.
- **Verifier — `foundry-user-not-owning-actor`.** _Observation point:_ unit test — map says actor `a1` belongs to user `u1`; `foundryUsers` reports `u1` ownedActorIds = `["a2"]`. _Expected:_ critical finding `{ kind: "foundry-user-not-owning-actor", discordUserId: "d1", foundryUserId: "u1", foundryActorId: "a1" }`.
- **Verifier — `dm-foundry-user-is-operator-player-user` (critical case).** _Observation point:_ unit test — operator is also a player (in `identityMap` as `{ discordUserId: "d-op", foundryUserId: "u-op" }`); `dmFoundryUserId: "u-op"`. _Expected:_ critical finding.
- **Verifier — `dm-foundry-user-is-operator-player-user` (warning case).** _Observation point:_ unit test — operator is pure host (not in `identityMap`); `dmFoundryUserId: "u-op"`. _Expected:_ warning-level finding (or none, per the design choice for pure-host); operator-as-pure-host is unambiguously fine.
- **Verifier — `ok` baseline.** _Observation point:_ unit test — all expected players have map rows with `foundryUserId` set + Foundry users with the correct `ownedActorIds`; DM Foundry user distinct; operator GM-role. _Expected:_ `status: "ok"`, no findings.
- **Start blocked on critical-gaps.** _Observable surface:_ `runExtendedIntake`'s `IntakeResult` + `SessionManager.start` rejection. _Observation point:_ integration test — set up identity map with one player missing `foundryUserId`; call `SessionManager.start`. _Expected:_ start rejects with an actionable error referencing the finding; intake report carries the critical finding; no Coordinator is constructed.
- **Voice-join pre-flight suppresses per-player onboarding.** _Observable surface:_ the always-listening loop's "awaiting onboarding" set + emitted `notify_operator`. _Observation point:_ integration test — seat one mapped player + one unmapped player; emit a presence event for the unmapped player; run a lull. _Expected:_ the mapped player IS in the onboarding-targets set; the unmapped player is NOT; one `notify_operator` escalation recorded with the unmapped player's name.
- **`record_player_character` emits a warning when no Foundry user owns the recorded actor.** _Observable surface:_ `router.emit` recorded call + the persisted map row. _Observation point:_ integration test — call the tool handler with an actor that no Foundry user owns; verify the row is written with `foundryUserId = null` AND a `gm`-audience emit with `meta.escalation: true, severity: "warning"` was recorded.
- **`notify_operator` lands in GM chat + operator whisper when both are known.** _Observation point:_ integration test — set `operatorFoundryUserId = "u-op"`; call `handleNotifyOperator({ content: "x" })`. _Expected:_ `FoundryGmChatSurface.emit` records two calls: one `mode: "gm"` (broadcast) and one `mode: "whisper", whisperTo: ["u-op"]`.
- **`notify_operator` falls back to GM-broadcast + SSE when operator is unknown.** _Observation point:_ integration test — `operatorFoundryUserId = undefined`; call the tool. _Expected:_ one `FoundryGmChatSurface.emit` `mode: "gm"` call; one SSE-bus `AppEvent` of kind `operatorEscalation` for the web console.
- **Foundry-presence drop emits a `presence.foundry.dropped` event.** _Observation point:_ unit test — feed the polling job two consecutive `listUsers()` snapshots; first has `u1` active, second inactive. _Expected:_ one `presence.foundry.dropped` event recorded with `foundryUserId: "u1"`.
- **`eval:live` (behavior-spec interplay):** the AI's onboarding-ritual phrasing carries forward unchanged from 0023; existing fixtures continue to apply. New `eval:live`: the AI's response to a per-player pre-flight gap (one-time DM courtesy + table greeting suppression). One fixture confirming the AI does NOT greet the unmapped player at the table; one confirming the courtesy DM is sent once per player.
- **Live: operator end-to-end pre-flight scenarios.** Operator sets up a campaign with a player whose Foundry user is missing; runs Start; observes the intake-report critical finding in Foundry GM chat; adds the Foundry user; runs `/skeinkeeper preflight verify`; observes the `ok` inline; runs Start successfully. Operator-validated against real Foundry + first-party add-on.

## Requirement traceability

| PRD ref                         | Requirement                                                                                                                                                                                                                       | Satisfied by                                                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1                             | "Real-time speech-to-text per speaker with diarization (AI knows which player said what)" + 3-way identity for player text on Foundry public chat                                                                                 | Carried forward from 0023 (voice presence) + 0016 (Discord-user→actor map) + extended with `foundryUserId` for chat-public attribution via TDD 0034's inbound adapter                              |
| 4.2 (Per-player Foundry access) | "Each player has their own Foundry user account, with ownership of their character actor. Created/granted by the operator before Start (per §4.6 host pre-flight and §4.8)"                                                       | §1 host pre-flight items; §3 verifier (critical-gap `no-foundry-user` / `foundry-user-not-owning-actor`); §5 ritual NO-LONGER calls `assign-actor-ownership` (rescoped per 0032 in-place revision) |
| 4.6                             | "adds each player as a Foundry user with ownership of their character actor. Both Discord-channel access and Foundry-user access are host pre-flight responsibilities"                                                            | §1 + §3a Start pre-flight                                                                                                                                                                          |
| 4.6                             | "Sends each player a brief in-Discord onboarding DM from the bot … Discord DM is the pre-Foundry-join surface for this exchange — consent must be gathered before any voice processing, before a player has connected to Foundry" | Carried from TDD 0012's consent flow; this TDD doesn't change consent; the pre-Foundry-join consent surface is preserved as `DiscordConsentSurface` per TDD 0034                                   |
| 4.6                             | "Each player connects to the session via their own Discord client (for voice) and their own Foundry view (for visuals and table text). Both are required"                                                                         | §6 voice + Foundry presence; pre-flight + voice-join check                                                                                                                                         |
| 4.8 (Host pre-flight)           | "Each player has an invite to the Discord voice channel **and** has been added as a Foundry user with ownership of their character actor. Both surfaces are required"                                                             | §1 pre-flight table                                                                                                                                                                                |
| 4.8 (Intake delivery surface)   | "produces a structured **intake report** and surfaces it to the operator via the `notify_operator` Foundry channel (GM-only chat, or whisper to the operator's Foundry user)"                                                     | §4 `notify_operator` rewire (Foundry GM + operator-whisper); coordinated with TDD 0031's intake-report-delivery rewire                                                                             |
| 4.8 (Autonomous setup item 2)   | "Discord-user → Foundry-user → actor ownership confirmation … If a Foundry user is missing or ownership wasn't assigned in pre-flight, this is a critical gap that blocks Start (operator must fix in Foundry and retry)"         | §3a critical-gap blocking; §5 ritual confirms (does not assign); TDD 0032 in-place revision rescopes item 2 to verification, not action                                                            |
| 5.5 (Per-audience erasure)      | `foundryUserId` is PII; erasure path covers it                                                                                                                                                                                    | §"Data & state" — erasure adapter is column-complete; PRIVACY.md update co-shipped                                                                                                                 |
| 5.8 (Graceful degradation)      | Foundry-presence drop does not pause the session (only Foundry/bridge dropping does — TDD 0039)                                                                                                                                   | §6 Foundry presence behavior                                                                                                                                                                       |

## Dependencies considered

No new third-party Skeinkeeper-side dependencies. Reuses:

- `FoundryClient.listUsers()` from TDD 0041.
- `SurfaceRouter` from TDD 0034.
- `record_player_character` + identity-map storage from TDD 0016 (carried + extended).
- Voice presence + `selectOnboardingTargets` from TDD 0023 (carried).
- Always-listening loop + Coordinator from TDD 0015 / TDD 0026.

Alternatives considered:

- **Skip Foundry-user binding; route per-player text by Discord user alone.** Rejected: TDD 0034's `FoundryWhisperSurface` needs a Foundry user ID for `whisperTo`. No way to deliver a Foundry whisper without it.
- **Operator-supplied static Discord↔Foundry-user map (no live verification).** Rejected: drift between the static config and Foundry's actual user state would cause silent routing failures. The live `listUsers()` check IS the source of truth.
- **Skip the voice-join pre-flight check, run only at Start.** Considered. Rejected (per design-pass decision): a player can join voice late after the operator has changed Foundry users; Start-only check would silently let them participate without table-text reach. Defense in depth.

## PRD conflicts surfaced (and resolution)

1. **PRD §4.6's "Sends each player a brief in-Discord onboarding DM from the bot."** The PRD scopes this DM as "consent to voice processing, campaign overview, character creation if needed." Under PRD §4 hard rule (Discord DM is one-time consent only), the "campaign overview" portion is technically out of scope on Discord DM. **Resolution:** the onboarding DM is consent-only at v0.5; campaign overview lives in Foundry chat once the player is connected (the AI greets them with the overview at the first table-audience emit after voice-join). Behavior-spec update names this; documented as a follow-up to the PRD §4.6 wording.

2. **The PRD doesn't explicitly require a DM-Foundry-user designation; this TDD requires one** (per §"Carries forward" → TDD 0035 PRD-conflict #1). **Resolution:** added to §1 host pre-flight items; verifier emits `no-dm-foundry-user-designated` as critical (or warning, per operator-as-player vs. pure-host); INSTALL.md update co-shipped naming the required Foundry-user setup.

3. **Foundry-presence as a session-pause signal — PRD §5.8 says "If Foundry becomes unreachable, the session pauses" but doesn't define what "Foundry disconnects" means** (entire Foundry instance vs. a single user). **Resolution:** per this TDD's §6, only add-on disconnect (evt gone) pauses the session (TDD 0039 owns that lifecycle); individual user disconnect is a per-player presence event surfaced as `notify_operator` info. Captured in TDD 0039's design.

## Decisions to promote (ADR candidates)

None new from this TDD. The decisions are:

- **3-way identity binding (Discord ↔ Foundry user ↔ actor)** — a design-level extension of [ADR-0018](../adr/0018-foundry-source-of-truth.md) (Foundry as source of truth for mechanical state, which includes user-actor ownership); not promotable to ADR because it's the operational consequence of ADR-0018 + the surface model from TDD 0034's ADR candidate.
- **Defense-in-depth pre-flight (Start + voice-join)** — operational pattern, not a durable architectural decision. TDD-level.

If the design-PR reviewer disagrees, a refining ADR (`Refines: 0018`) on the 3-way identity is a reasonable consideration; not proposed here.

## Telemetry implications

| Event                                | Payload                                                                                                | Description                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `preflight.identity.ran`             | `{ trigger: "start" \| "voice-join" \| "operator-command", playerCount, findingCount, criticalCount }` | Verifier ran; counts only                                                             |
| `preflight.identity.finding`         | `{ kind, severity: "critical" \| "warning" \| "info" }` (NO player IDs; kind only)                     | One event per finding emitted                                                         |
| `preflight.identity.blocked-start`   | `{ criticalCount }`                                                                                    | Start was blocked due to critical findings                                            |
| `presence.foundry.dropped`           | `{ foundryUserIdHashed }` (salted hash per TDD 0003/0038)                                              | A previously-active Foundry user went inactive                                        |
| `presence.foundry.restored`          | `{ foundryUserIdHashed }`                                                                              | An inactive Foundry user came back online                                             |
| `escalation.notify-operator`         | `{ severity }`                                                                                         | `notify_operator` emitted (no content; severity only)                                 |
| `identity.player-character.recorded` | `{ source: "player" \| "operator", hasFoundryUser: boolean }`                                          | `record_player_character` ran; surfaces whether Foundry user was bound at record-time |

All PII-free per [ADR-0010](../adr/0010-privacy-as-architecture.md). The `preflight.identity.finding` event deliberately omits player IDs — knowing _how many_ findings of each kind fire is operational signal; knowing _which player_ would correlate operator-machine telemetry to specific people.

## Privacy implications

- `foundryUserId` is `PII<>` (it associates a real Foundry login with a real player). The migration's column addition + the erasure-adapter update preserve [ADR-0010](../adr/0010-privacy-as-architecture.md)'s erasure-path guarantee.
- The 3-way map carries `discordUserId` + `foundryUserId` + `displayName` per row; all three are erased on per-player erasure via the existing `PlayerCharacterMapAdapter`.
- Pre-flight verifier outputs contain player display names + Foundry user IDs; the verifier's audit-log entry is encrypted-at-rest per [ADR-0022](../adr/0022-pii-encryption-node-crypto.md). Telemetry events do NOT carry these (PII-free per above).
- PRIVACY.md update (co-shipped with this TDD's commit AND TDD 0035's commit AND TDD 0038's commit — three docs revising one privacy story together): names the 3-way identity, the operator-visibility paths, and the per-player erasure cascade.

## Eval implications

- **Unit-testable:** verifier per finding kind; `record_player_character` extension; `notify_operator` routing; presence reducers; the late-binding flow (verify-fails → operator-acts → verify-passes → onboarding-runs).
- **`eval:live`:** the AI's behavior on unmapped-player voice-join (does NOT greet; does NOT take their utterances into table state); the AI's behavior after late-binding (greets normally on next lull).
- **Operator-validated live:** the full pre-flight flow end-to-end (intake-stage critical-gap → operator fix → re-verify → Start succeeds); `notify_operator` end-to-end (escalation lands in Foundry GM chat + operator whisper).

## Open questions

- **Foundry-presence polling cadence (60s default).** Latency-sensitive? Probably not at v0.5 — drop detection within a minute is acceptable for a session lifecycle event. Configurable via session config; defer tuning to operator feedback.
- **Per-player Discord-DM courtesy when a voice-join pre-flight gap blocks onboarding.** The one-time DM is sent on first-failed-voice-join; if the player rejoins later still-unmapped, is it sent again? Recommendation: yes, once per session per player (the operator may have failed to act between joins; the reminder is the courteous thing). Configurable, off by default if the operator finds it noisy.
- **Operator who is also a player AND also the DM Foundry user — degenerate edge case.** PRD-conflict #3 + verifier raises `dm-foundry-user-is-operator-player-user` critical. Recommendation: enforce; INSTALL.md naming the constraint at host pre-flight. If a single-Foundry-user operator-as-player config is ever requested, revisit (a future "operator-as-self-side-channel" design would need to address it).

## Evaluation rubric

| Criterion                       | High-quality                                                                                       | Acceptable                                                   | Failing                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Requirement traceability        | Every in-scope FR/NFR maps to a named interface, type, or step                                     | One mapping is slightly coarse but still findable            | An in-scope FR has no row, or the row is "handled in code"        |
| Interface concreteness          | Method names, args, return types, and error cases are specified                                    | Types are named; one edge payload is implied                 | "the module talks to Skeinkeeper" with no message or method shape |
| Alternatives-analysis substance | Each new dep names a rejected alternative and a one-line reason                                    | No new dep, and the section says why                         | New dep with empty or "none considered" analysis                  |
| Verification-plan actionability | Observable surface, observation point, and PASS values are named                                   | Observable but one scenario is console-only                  | Non-actionable plan (no surface, no observation point)            |
| Scope-bound adherence           | Touched files ≤8, body ≤500, per-file estimates present                                            | One justified exception marker                               | Silent over-bound or missing Touched files / Expected diff        |
| Naming consistency              | FoundryClient methods, gateway messages, and add-on id match across 0041, 0042, and revised drafts | One leftover "bridge" in a revised draft, clearly historical | 0041 and 0034 disagree on a method or event name                  |
