# TDD 0040: Operator Control Parity — Foundry Chat Commands as the Second Surface

Status: draft
PRD refs: 4.3, 4.4
PRD-rev: 59a0fda
ADR constraints: 0010, 0016, 0017, 0018, 0023, 0024, 0025
Supersedes: [TDD 0025](./0025-operator-control-parity.md)
Author: maintainers
Date: 2026-05-26
Related TDDs: [0020 (operator app)](./0020-operator-app.md), [0024 (operator self-designation)](./0024-operator-self-designation.md), [0034 (surface routing & I/O abstraction)](./0034-surface-routing-and-io-abstraction.md), [0036 (onboarding + Foundry-user pre-flight)](./0036-onboarding-and-foundry-user-preflight.md), [0037 (bridge dependencies — surface-model critical batch)](./0037-bridge-dependencies-surface-model-critical-batch.md), [0039 (Foundry-down session lifecycle)](./0039-foundry-down-session-lifecycle.md)

## Carries forward / supersedes (read first)

This TDD supersedes [TDD 0025](./0025-operator-control-parity.md) (operator control parity — console ↔ Discord slash). The PRD revision narrows Discord text to one-time consent only; the operator's second-surface for controls moves to Foundry chat commands. Append-only discipline (TDD 0025 was `implemented`) requires a new document; this is it.

**Carried forward from TDD 0025 unchanged in shape:**

- **The parity invariant.** Every operator action / setting is available on both surfaces; any change is reflected live on the other.
- **The single write path discipline.** Each operator control is one method on `SessionManager`; both surfaces call that method; no surface duplicates logic.
- **The live cross-surface sync via SSE.** Web console subscribes to `/api/events`; `AppEvent`s on the in-process bus echo to it; both surfaces (and the initiator) see the same state.
- **`GET /api/state`** as the initial-paint snapshot for a freshly-opened console.
- **Per-player exempt actions.** `/skeinkeeper consent <accept|decline>` is per-player self-action (not operator-control) and exempt from the parity table.
- **The cold-start asymmetry** (TDD 0025 §4): `session action:start` can only be initiated from the web console because the bot's gateway client isn't running before session start. Carries forward unchanged: starting a session is a console-only action until the standing-gateway-client work (still open per TDD 0025 §4) lands. Foundry chat commands are likewise unavailable pre-Start (Foundry might not be the operator's last surface either, but `chat-command` listener subscription begins at session start anyway), so the asymmetry is consistent with the new surface model.

**Substantively changed in this TDD:**

- **Second surface: Discord slash commands → Foundry chat commands.** Operator commands are typed as `/skeinkeeper <verb> <args>` in Foundry's public chat; the bridge driver's `FoundryChatCommandSurface` (TDD 0034 §6) parses + dispatches. Verb taxonomy carries forward verbatim from TDD 0025 — operators who learned the Discord-slash surface don't relearn. The `/skeinkeeper` prefix gives us a pseudo-namespace inside Foundry's global slash space (collision-safe against Foundry core's `/r`, `/w`, `/gm`, `/em` and module-registered commands).
- **New operator controls added by the surface-model TDDs in this design pass:**
  - `/skeinkeeper preflight verify` and `/skeinkeeper preflight verify @<discord-user>` (TDD 0036 §4 — re-run identity pre-flight verifier).
  - `/skeinkeeper session action:resume` (TDD 0039 — resume after Foundry-down pause).
  - `/skeinkeeper map @<discord-user> <character>` (TDD 0036; this command existed in 0016/0025 prior surfaces but is consolidated here under the parity invariant for the new transport).
  - `/skeinkeeper intake resolve <id> <option>` (TDD 0031 — resolve an intake finding; the destination flips alongside the rest).
  - `/skeinkeeper pvp <on|off>` (TDD 0026 / TDD 0035 — PvP toggle).
- **Authorization model for the second-surface adjusts.** TDD 0024's Discord slash command was authorized by the invoker holding `Manage Channel` on the configured voice channel. The Foundry chat-command's authorization gate is **the invoker being a GM-role Foundry user** (`game.users.get(invokerId)?.role === "GAMEMASTER" || "ASSISTANT"`). This is the natural Foundry-side analog and ties "who can operate" to whoever Foundry's own permission system has trusted with GM access to the world.
- **TDD 0024's `claim` action target identity flips.** TDD 0024's slash command captured the invoker's _Discord_ snowflake (`interaction.user.id`). The Foundry chat-command equivalent captures the invoker's _Foundry_ user ID. The operator-designation data model gains a second identity dimension (the operator's Foundry user); the Discord identity is still captured separately via the console paths (picker + username field, per 0024's paths 2 + 3, both carrying forward unchanged). The two identities can be bound via TDD 0036's 3-way identity map if the operator is also a player; otherwise they're set independently from their respective surfaces. **TDD 0024 itself is NOT superseded** per the design-pass decision — its data model + designation mechanism carry forward; only the `claim` action's slash-command surface row in the parity table changes here.
- **The cold-start asymmetry remains console-only.** Carried forward from TDD 0025 §4. The standing-gateway-client work is unchanged in status (still open); Foundry's chat-command listener subscription is also session-bound, so the asymmetry applies symmetrically across both second-surface technologies. `session action:start` is the only command that lives only on the web console.

## Approach

The shipped parity design (TDD 0025) is structurally correct: one write path; SSE-bus echo; per-control method on `SessionManager`. The new design preserves all of it and substitutes the second surface. The implementation work is replacing the Discord-slash interaction handlers with Foundry-chat-command handlers behind the same `SessionManager` methods, plus adding the new controls introduced by the surface-model TDDs.

The verb-taxonomy continuity decision (made in this design pass) makes the transition cheap for operators: the same `/skeinkeeper session action:stop` string the operator typed in Discord works in Foundry chat. Only the input box changes.

### 1. The parity invariant (carried forward, table updated)

**Every operator action / setting is available on both web console and Foundry chat commands, and any change is reflected live on the other.** The table:

| Action                                 | Web console                              | Foundry chat command                               | Owner TDD                                |
| -------------------------------------- | ---------------------------------------- | -------------------------------------------------- | ---------------------------------------- |
| Start session                          | Start button                             | _(cold-start asymmetry: console only)_             | TDD 0025 §4 carried fwd                  |
| Stop session                           | Stop button                              | `/skeinkeeper session action:stop`                 | TDD 0025 carried fwd                     |
| Pause session                          | Pause button (new for v0.5)              | `/skeinkeeper session action:pause`                | TDD 0039 (lifecycle)                     |
| Resume session                         | Resume button (new for v0.5)             | `/skeinkeeper session action:resume`               | TDD 0039                                 |
| Set eagerness                          | Radio                                    | `/skeinkeeper eagerness level:<low\|medium\|high>` | TDD 0025 carried fwd                     |
| List DM voices                         | Persona dropdown                         | `/skeinkeeper voice action:list`                   | TDD 0025 carried fwd                     |
| Set DM voice                           | Persona dropdown + Apply                 | `/skeinkeeper voice action:set persona:<name>`     | TDD 0025 carried fwd                     |
| Designate operator (claim)             | Operator panel (picker / @username)      | `/skeinkeeper operator action:claim`               | TDD 0024 (data); this TDD (surface)      |
| Clear operator designation             | Operator panel: Clear                    | `/skeinkeeper operator action:clear`               | TDD 0024 (data); this TDD (surface)      |
| Show operator designation              | Operator panel: badge                    | `/skeinkeeper operator action:show`                | TDD 0024 (data); this TDD (surface)      |
| Toggle PvP                             | PvP checkbox in campaign settings        | `/skeinkeeper pvp <on\|off>`                       | TDD 0035 (semantics); this TDD (surface) |
| Re-verify identity pre-flight (all)    | "Verify pre-flight" button (intake pane) | `/skeinkeeper preflight verify`                    | TDD 0036                                 |
| Re-verify identity pre-flight (single) | (per-player row in intake pane)          | `/skeinkeeper preflight verify @<discord-user>`    | TDD 0036                                 |
| Map player → character (override)      | Identity map table (edit row)            | `/skeinkeeper map @<discord-user> <character>`     | TDD 0036 (data); this TDD (surface)      |
| Resolve intake finding                 | Intake pane: pick option                 | `/skeinkeeper intake resolve <id> <option>`        | TDD 0031 (data); this TDD (surface)      |

**Per-player self-actions (exempt from operator-control parity, per TDD 0025):**

| Action         | Surface                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------ |
| Player consent | Discord DM (one-time per [TDD 0034 surface model](./0034-surface-routing-and-io-abstraction.md)) |

This list is the project convention going forward (also noted in the public `CLAUDE.md`): a new operator control lands on **both** surfaces in the same change, or not at all. The CLAUDE.md anti-pattern entry "Adding an operator control to only one surface" is updated to read "console + Foundry chat" instead of "console + Discord slash."

### 2. One write path per control (carried forward, transport-adjusted)

Each control is a single method on `SessionManager` — same shape as TDD 0025. Both surface handlers call that one method. Methods touched by this TDD:

- Existing (carried from 0025; unchanged): `start()`, `stop()`, `setEagerness(level)`, `setDmVoice(persona)` / `setDmVoiceByPersona(name)`, `setOperatorClaim(identity)` / `setOperatorClear()` / `getOperator()`.
- New for this TDD's set of controls:
  - `pause()` and `resume()` — TDD 0039's lifecycle write-path methods.
  - `setPvp(enabled: boolean)` — was implicit in 0025 (campaign settings table write); this TDD makes it a named `SessionManager` method to ensure parity discipline.
  - `verifyPreflight(args?: { player?: DiscordUserId })` — TDD 0036 verifier wrapper that re-runs the verifier and returns the result (no state mutation, but routed through `SessionManager` for the audit log + the SSE echo of the resulting `preflight` event).
  - `mapPlayerCharacter({ discordUserId, characterName })` — TDD 0036's operator-override path; resolves character name to actor; writes `player_character_map` row with `source: "operator"`.
  - `resolveIntakeFinding({ findingId, option })` — TDD 0031's resolution path, now reachable from the Foundry chat surface.

The web console's existing API handlers (`web/api.ts`) call the same methods. The new methods get new endpoint routes (`POST /api/session/pause`, etc.); the Foundry chat-command parser dispatches to the same methods directly via the bridge driver's handler.

### 3. The Foundry chat-command handler

The bridge driver's `FoundryChatCommandSurface` (TDD 0034 §6) delivers `chat.command` events with parsed verb + args + the invoker's Foundry user ID. The handler:

```ts
// plugins/vtt-foundry/operator-command-handler.ts
export async function handleOperatorCommand(args: {
  event: { verb: string; args: ReadonlyArray<string>; foundryUserId: FoundryUserId; raw: string };
  sessionManager: SessionManager;
  identity: IdentityResolver; // TDD 0036's 3-way map + Foundry user role lookup
  router: SurfaceRouter; // TDD 0034; for inline reply via FoundryGmChatSurface whisper
}): Promise<void> {
  // 1. Authorize: only GM-role Foundry users may operate.
  const user = await args.identity.getFoundryUser(args.event.foundryUserId);
  if (!user || (user.role !== "GAMEMASTER" && user.role !== "ASSISTANT")) {
    await args.router.emit({
      audience: { kind: "gm" },
      text: `Unauthorized: /skeinkeeper commands require a GM-role Foundry user.`,
      meta: { escalation: false }, // not a Skeinkeeper escalation; an inline error
    });
    return;
  }

  // 2. Dispatch verb to SessionManager method.
  try {
    const result = await dispatchVerb(args.event, args.sessionManager);
    // 3. Inline ack: whisper a short confirmation to the invoker.
    //    Route by invoker identity: if the 3-way identity map (TDD 0036) has resolved
    //    a Discord ID for this Foundry user, target `player:<discordId>` so the ack
    //    lands in the operator's player whisper conversation. Otherwise, fall through
    //    to `gm` audience (FoundryGmChatSurface with whisper-to-operator-Foundry-user
    //    when known per TDD 0034 §"FoundryGmChatSurface"). The fallback covers the
    //    valid case where the operator is GM-only and has no player binding.
    if (result.invokerDiscordId) {
      await args.router.emit({
        audience: { kind: "player", playerId: result.invokerDiscordId },
        text: result.ackMessage,
      });
    } else {
      await args.router.emit({
        audience: { kind: "gm" },
        text: result.ackMessage,
        meta: { escalation: false }, // inline ack; do not whisper-to-operator again
      });
    }
  } catch (err) {
    await args.router.emit({
      audience: { kind: "gm" },
      text: `\`${args.event.raw}\` failed: ${err.message}`,
      meta: { escalation: false },
    });
  }
}
```

`dispatchVerb` is a small table of `verb → SessionManager.method` mappings + per-verb argument validation. Unit-tested per verb.

### 4. Cross-surface sync via the existing SSE bus (carried forward)

Every `SessionManager` method emits an `AppEvent`; the in-process bus broadcasts; the console's `/api/events` SSE stream renders. New `AppEvent`s introduced by this TDD's set:

- `lifecycleStateChanged { kind: "active" | "paused-foundry-down"; cause?; since? }` — TDD 0039.
- `pvpToggled { campaignId, enabled }` — for the PvP control parity.
- `preflightVerified { trigger, status, criticalCount, warningCount }` — surfaces the verifier result echo for the web console to render in the intake pane.
- `mapOverridden { discordUserId, characterName }` — operator-set mapping row.
- `intakeFindingResolved { findingId, option }` — TDD 0031.

Existing events from TDD 0025 (`eagerness`, `dmVoice`, `status`, `operator`, `roster`) carry forward unchanged.

### 5. Authorization (refined)

| Surface              | Authorization                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web console          | Console password (or localhost-only); not subject to a per-action permission check (the console is the admin plane, already gated). Carries forward unchanged from TDD 0025 / TDD 0024.              |
| Foundry chat command | Invoker's Foundry user role is `GAMEMASTER` or `ASSISTANT`. Carries the load-bearing "who can be the operator" decision from TDD 0024's Discord-channel `Manage Channel` to Foundry's GM-role check. |

The asymmetry is intentional and consistent: each plane is gated by its own native mechanism.

For the **`operator action:claim`** specifically (TDD 0024 semantics; substantive identity change), an additional safety: a non-operator GM-role user can't `claim` if an operator is already designated; they must `clear` first. (Carried forward from 0024's `claim/clear/show` semantics; the data layer enforces this regardless of surface.) The console path bypasses this constraint (console admin can re-assign), per TDD 0024's plane asymmetry. The Foundry chat-command path inherits the more restrictive semantics.

### 6. Inline command feedback

When the operator types `/skeinkeeper eagerness level:high`, they get:

1. **An immediate inline ack** via a Foundry whisper TO the invoker's Foundry user: "Eagerness set to high." Comes from the command handler at step 3 above.
2. **A cross-surface echo** to the web console via SSE: the console's eagerness control flips to "high" within ~500ms (same latency budget as TDD 0025).

The inline ack uses `FoundryGmChatSurface` for whispers (whisper-to-self semantic when the invoker IS the operator; whisper-to-invoker semantic when a non-operator GM-role user is exercising a per-session control). The cross-surface SSE echo is the same `AppEvent`-bus path as TDD 0025.

**Parse errors** (`/skeinkeeper eagerness level:turbo` → invalid value) get an inline whisper error (`"Invalid value 'turbo' for eagerness; valid: low | medium | high"`). No SSE echo for failed commands.

## Components & interfaces

```ts
// plugins/vtt-foundry/operator-command-handler.ts
export interface OperatorCommandVerb {
  verb: string;
  argSpec: ReadonlyArray<{ name: string; required: boolean; values?: ReadonlyArray<string> }>;
  dispatch: (args: ParsedArgs, sm: SessionManager, ctx: HandlerContext) => Promise<AckMessage>;
}

export const OPERATOR_COMMAND_TABLE: ReadonlyArray<OperatorCommandVerb> = [
  /* session, eagerness, voice, operator, pvp, preflight, map, intake — one per row */
];

export async function handleOperatorCommand(args: HandlerArgs): Promise<void>;
```

The command table is data; the handler is a thin dispatcher. Both unit-tested.

`SessionManager`'s public methods are extended per §2; signatures match the verb-table dispatch expectations. The existing methods (carried from TDD 0025) keep their signatures.

`IdentityResolver` is the wrapper around TDD 0036's `playerCharacterMap` + `FoundryClient.listUsers()` that surfaces:

```ts
export interface IdentityResolver {
  getFoundryUser(id: FoundryUserId): Promise<FoundryUser | null>; // includes role
  getDiscordUser(foundryUserId: FoundryUserId): Promise<DiscordUserId | null>; // via 3-way map
  resolveCharacterName(
    name: string,
    campaignId: string,
  ): Promise<{ actorId: string; foundryUserId?: string } | null>;
}
```

`HandlerContext` carries `sessionManager`, `identity`, `router`, plus session-scoped capabilities (`BridgeCapabilities` from TDD 0037 — some commands like `/skeinkeeper pvp` are no-ops if the underlying capability hasn't shipped).

## Data & state

No new persistent storage in this TDD. The methods extended on `SessionManager` write to existing tables (campaign settings, `player_character_map`, `intake_findings`); the AppEvent bus is in-memory; the SSE stream is per-client transient.

The operator-designation data model from TDD 0024 is extended _by reference_ — the `claim` action now stores an additional `foundryUserId` field on the designation, populated when the claim arrives via Foundry chat (the value from `args.event.foundryUserId`). When the claim arrives via the console path, the `foundryUserId` is set to NULL until the operator's Foundry identity is established separately (via 3-way map binding or a future explicit operator-foundry-user setting). A NULL `foundryUserId` on the operator designation means `notify_operator` whisper-to-operator can't target a specific Foundry user — it falls back to GM-broadcast in Foundry chat (per TDD 0034 + TDD 0036). This is the correct degraded behavior; the operator can opt into whisper-targeted escalations by claiming via Foundry chat OR by having a 3-way map entry.

## Sequencing / implementation plan

1. **Extend `SessionManager`** with the new methods listed in §2 (`pause`, `resume`, `setPvp`, `verifyPreflight`, `mapPlayerCharacter`, `resolveIntakeFinding`). Each is a thin wrapper around the existing store + the existing `AppEvent` bus emit.
2. **`OperatorCommandVerb` table and `dispatchVerb`** in `plugins/vtt-foundry/operator-command-handler.ts`. Unit tests per verb.
3. **`handleOperatorCommand`** wiring: subscribes to TDD 0034's `chat.command` events; dispatches; emits inline ack via the router.
4. **Authorization check:** `FoundryClient.listUsers()` lookup of the invoker's role per command. Caches per-session (re-fetched on a `listUsers()`-driven role-change signal). Reuses TDD 0037's `list-users` cap.
5. **Console-side write-path methods** added to `web/api.ts` for new controls (`/api/session/pause`, `/api/session/resume`, `/api/pvp`, `/api/preflight/verify`, `/api/map/override`, `/api/intake/resolve`). Each calls the SessionManager method 1:1.
6. **Web console UI controls** for the new actions (Pause/Resume buttons; PvP checkbox; pre-flight Verify button in the intake pane; intake findings render as resolvable items; map-override table extension). The existing console code-style (vanilla `app.js` per TDD 0020) covers these.
7. **`AppEvent` bus events** introduced (per §4) plumbed through the SSE stream.
8. **CLAUDE.md update** (the public one): the anti-pattern entry on "Adding an operator control to only one surface" updates from "console + Discord slash" to "console + Foundry chat."
9. **CONTRIBUTING.md update:** the parity invariant rule rewritten with the new second-surface name.
10. **Delete (in the same code-archaeology pass as TDD 0034 step 12) the Discord-slash-command registration code.** The `/skeinkeeper ...` slash commands previously registered with Discord (via the bot's application-command-registration call) are deregistered as a one-time migration step at v0.5 startup, then the registration code is removed.
11. **Eval / live verification** per §Verification plan.

## Failure modes & edge cases

- **Operator types `/skeinkeeper foo` (unknown verb).** Parser at TDD 0034's `FoundryChatCommandSurface` rejects with an inline error; this TDD's handler never sees the event.
- **Operator types `/skeinkeeper eagerness` (missing args).** Verb table's argSpec marks `level` as required; dispatcher rejects with an inline whisper: `"Usage: /skeinkeeper eagerness level:<low|medium|high>"`.
- **Operator types `/skeinkeeper session action:start` from Foundry chat.** Cold-start asymmetry (§"Carries forward" + TDD 0025 §4); the dispatcher returns an inline error: `"Session start is console-only at v0.5. Visit localhost:3000."` This is the same error 0025 surfaced; transport changes, semantics don't.
- **Two simultaneous operator commands** (operator + a fast-typing GM-assistant). `SessionManager`'s single-write-path serializes; the first wins; the second sees the post-first state (often `already-active`, `eagerness already high`, etc.) and the inline ack reflects the no-op nature.
- **A non-operator GM-role user issues `/skeinkeeper operator action:claim` while an operator is set.** The data-layer constraint from TDD 0024 (claim-if-cleared) blocks; the dispatcher returns an inline error pointing them at `action:clear` first.
- **A player (PLAYER-role Foundry user) types `/skeinkeeper ...`.** Authorization check (§5) rejects with the unauthorized inline whisper to the invoker. No state change; no SSE echo.
- **`listUsers()` fails when looking up the invoker's role.** Defensive: fall back to "unauthorized." Per [ADR-0024](../adr/0024-silence-is-success-operator-escalation.md)'s silence-is-success operator escalation discipline, log `error.captured`; the operator's actual GM session in Foundry will show the failure normally.
- **The cold-start asymmetry will close once the standing-gateway-client work lands.** When that lands (TDD 0025 §4 open item — still open per the design pass), `/skeinkeeper session action:start` becomes a Foundry-chat-command-able action, and the parity table updates. Tracked.
- **Operator commands during `paused-foundry-down`.** Per TDD 0039 §3: Foundry-side emits are short-circuited; Foundry chat-command listener is presumably ALSO not receiving events (Foundry is down). The operator's resume path is via the web console (or, if the bridge has reconnected enough to deliver chat events, the resume command works). This is correct: the surface model says when Foundry is down, the operator goes to the only working surface (console + the one-time DM notification).
- **The migration step (de-registering Discord slash commands at v0.5 startup) fails.** One-time, run on first v0.5 boot. If it fails, the old slash commands linger in Discord's UI but no longer reach Skeinkeeper (the bot's handler for them is removed). Operator sees a "remove old commands" instruction in the v0.5 changelog. Not blocking; cosmetic.

## Verification plan

- **Parity table — every control on both surfaces.** _Observable surface:_ test matrix. _Observation point:_ table-driven unit test per parity row — for each `(SessionManager method, console route, Foundry verb)` triple, assert console route exists + Foundry verb is in `OPERATOR_COMMAND_TABLE` + both call the same method. _Expected:_ all rows pass; any row missing one surface fails CI.
- **Single write path per control.** _Observation point:_ static check (CI lint) — each `SessionManager` method's body must contain exactly one persistence call + one `AppEvent` emit; the Foundry-side and console-side handlers must NOT contain persistence calls of their own. _Expected:_ lint passes; a contributor adding a parallel write path fails CI.
- **Foundry chat-command dispatches to SessionManager method.** _Observation point:_ unit test per verb — feed `handleOperatorCommand` a chat-command event with the verb + valid args + a GM-role invoker; verify the corresponding `SessionManager` method was called with the parsed args; verify an inline ack `router.emit` was recorded.
- **Authorization rejects non-GM invokers.** _Observation point:_ unit test — feed an event with a PLAYER-role invoker; verify NO `SessionManager` method was called; verify an inline `unauthorized` emit.
- **Authorization rejects unknown invoker.** _Observation point:_ unit test — `listUsers` returns no user matching the invoker ID; verify unauthorized rejection.
- **Cold-start asymmetry rejects `session action:start`.** _Observation point:_ unit test — feed `verb: "session"`, `args: ["action:start"]`; verify rejection with the actionable error.
- **Cross-surface SSE echo lands.** _Observation point:_ integration test — call the Foundry-side handler for `/skeinkeeper eagerness level:high`; subscribe to the SSE bus stream; verify an `eagerness { level: "high" }` event arrives within ~500ms.
- **`claim` via Foundry chat captures invoker's Foundry user ID.** _Observation point:_ unit test — issue `claim` from Foundry chat with a GM invoker `u-gm-1`; verify the operator-designation row has `foundryUserId: "u-gm-1"`.
- **`claim` while operator already set rejects.** _Observation point:_ unit test — pre-set operator designation; issue claim from a different GM user; verify rejection with the actionable error.
- **`pvp on` toggles + parity-syncs.** _Observation point:_ integration test — issue `pvp on`; verify campaign settings updated; verify SSE event emitted; verify console UI's checkbox reflects in the next `/api/state` snapshot.
- **`preflight verify` re-runs the verifier and reports inline.** _Observation point:_ integration test — issue `preflight verify`; verify `verifyIdentityPreflight` (TDD 0036) is called; verify the inline whisper reflects the findings; verify the SSE bus emits the result event for the console pane.
- **Live: end-to-end operator commands against real Foundry + bridge.** Operator types each verb in Foundry chat; observes the inline whisper ack; observes the cross-surface state change on the console; reverses; observes the symmetric round-trip. One scenario per parity row.

## Requirement traceability

| PRD ref                                  | Requirement                                                                                                                                       | Satisfied by                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.3 (override controls)                  | "Override any AI decision via the web UI's live-session view (§4.3)"                                                                              | The web-console-side write paths in §2; the Override actions appear as console controls + Foundry chat commands per §1 parity table                     |
| 4.4 (operator control surfaces)          | Web console + a second surface; live cross-surface sync                                                                                           | §1 parity table; §2 single-write-path; §4 SSE bus echo; carries forward TDD 0025's discipline                                                           |
| 4.2 (Operator commands via Foundry chat) | "Operator commands — operator-side resolutions, overrides, and toggles … are typed as Foundry chat commands surfaced through the bridge"          | §3 chat-command handler; TDD 0034's `FoundryChatCommandSurface` delivers events                                                                         |
| ADR-0016                                 | Operator controls have parity across console and a second surface, via one write path                                                             | §1 + §2; the invariant is preserved with the second surface changed but the property unchanged                                                          |
| ADR-0023                                 | Operator-as-host; operator does host work; controls are accessible without leaving the operator's primary surfaces (Foundry GM view, web console) | §1 + §5; the GM-role authorization gate plus the Foundry chat-command surface mean the operator never needs to alt-tab to Discord for operator controls |

## Dependencies considered

No new third-party Skeinkeeper-side dependencies. Reuses:

- `SessionManager` (TDD 0025, extended).
- `SurfaceRouter` + `FoundryChatCommandSurface` (TDD 0034).
- `FoundryClient.listUsers()` (TDD 0037 Band A cap #5, v0.5-blocking).
- TDD 0024's operator-designation data model (carried forward unchanged; extended with a `foundryUserId` field per §2).
- SSE bus + `AppEvent` shape (TDD 0020 / 0025).

Alternatives considered:

- **Drop Foundry chat-command operator surface; web-console-only operator controls at v0.5.** Considered; rejected per the prior interview decision to block v0.5 on the chat-command listener bridge cap rather than relax the parity invariant.
- **Keep Discord slash commands alongside Foundry chat commands** (three surfaces). Rejected — violates the PRD §4 surface model's hard rule "Discord DM = consent only." Slash commands aren't DMs but they're another Discord text path the surface model rules out.
- **Subset the parity table** (some controls Foundry-chat-only, others console-only). Rejected — breaks the parity invariant, which is ADR-0016's load-bearing claim.

## PRD conflicts surfaced (and resolution)

1. **The PRD §4.2 list of example operator commands** (`/skeinkeeper intake resolve <id> <option>`, scene-switch, eagerness/PvP toggles) doesn't reference the existing TDD 0025 verb taxonomy. The verb shapes in this TDD use the TDD 0025 idiom (`session action:stop`, `eagerness level:high`) for continuity. **Resolution:** the PRD's wording is illustrative; the verb-table here is authoritative. No PRD update needed.

2. **`operator action:claim` semantic split: Discord identity vs. Foundry identity.** TDD 0024's claim captured a Discord snowflake; Foundry chat captures a Foundry user. **Resolution:** the data model extends to carry both (per §"Data & state"); the two identities can be independent OR bound via TDD 0036's 3-way identity map. The whisper-to-operator escalation routing (TDD 0034 + TDD 0036) prefers the Foundry user when known; falls back to GM-broadcast otherwise. Documented in PRIVACY.md.

3. **Cold-start asymmetry.** TDD 0025 §4 documented this against Discord; it carries forward against Foundry chat (the listener can't fire before session-start either). **Resolution:** carry-forward; the standing-gateway-client open item from TDD 0025 §4 remains open and remains the unblocking path.

## Decisions to promote (ADR candidates)

None new. The decisions are:

- **The verb-taxonomy continuity** (`/skeinkeeper <verb> <args>` carrying forward verbatim) is an operational choice, not a durable architectural decision. TDD-level.
- **Authorization via Foundry GM-role** is operational; TDD-level.
- **The parity invariant itself** is [ADR-0016](../adr/0016-operator-control-parity-across-surfaces.md), already accepted; unchanged.

## Telemetry implications

Carries forward TDD 0025's per-control events unchanged. New events from the new controls:

| Event                                 | Payload                                                       | Description                                                |
| ------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| `operator.command.received`           | `{ verb, surface: "console" \| "foundry-chat", invokerRole }` | An operator command arrived at the dispatcher              |
| `operator.command.rejected`           | `{ verb, surface, reason }`                                   | A command was rejected at the authorization or parse layer |
| `operator.command.completed`          | `{ verb, surface, durationMs }`                               | A command completed end-to-end                             |
| `operator.command.cross-surface-echo` | `{ verb, originSurface, echoSurface, latencyMs }`             | The SSE bus delivered the cross-surface echo               |

All PII-free per [ADR-0010](../adr/0010-privacy-as-architecture.md). Verb names are tool-name strings; surface names are static; role values are Foundry-defined enum values.

## Privacy implications

The operator designation gains a `foundryUserId` field; `foundryUserId` is `PII<>` per TDD 0036; same erasure path as the other identity columns.

Inline ack whispers contain operator-context content (the verb that was issued, the new state); they're not PII-sensitive (no player content; no secrets) but ARE operator-actor-content per [ADR-0017](../adr/0017-per-audience-memory-visibility-erasure.md); stored as `audience: gm` in the dialogue store via TDD 0035 + TDD 0034's surface routing.

The Discord-slash-command-registration code removal removes one persistent Discord-side artifact; one less surface where operator-relevant strings might be cached by Discord clients.

## Eval implications

- **Unit-testable (the bulk):** verb-table dispatch; authorization; argument parsing; SSE event emission; cross-surface ack.
- **Operator-validated live:** end-to-end per parity row (one scenario per row).
- **No `eval:live` (LLM-side) fixtures** — operator controls are mechanical.

## Open questions

- **Inline-ack-as-whisper vs. inline-ack-in-public-chat.** Whisper to the invoker keeps GM-chat clean; public-chat ack would be visible to all GM-role users (the operator's GM assistants) which might be desirable for shared awareness. Recommendation: whisper to invoker for v0.5 (least noisy); revisit if multi-GM-assistant configurations need shared visibility.
- **Migration: how does the operator know slash commands moved?** The v0.5 changelog + a one-time operator DM at first v0.5 startup explaining the move. Captured in the v0.5 release-notes follow-up.
- **The standing-gateway-client work** (TDD 0025 §4 open item) — still open. When it lands, `session action:start` becomes a Foundry-chat-command-able action; the parity table updates; the asymmetry closes. Tracked.
