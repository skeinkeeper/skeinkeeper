# Design Doc 0025: Operator Control Parity (Console ↔ Slash) + Live State Sync

> Status: Accepted
> Author: maintainers
> Date: 2026-05-20
> Related ADRs: [ADR-0016 (operator control parity)](../adr/0016-operator-control-parity-across-surfaces.md) — the architectural decision this doc implements
> Related design docs: [0020 (operator app)](./0020-operator-app.md), [0023 (onboarding + operator channel)](./0023-session-onboarding-presence-operator-channel.md), [0024 (operator self-designation)](./0024-operator-self-designation.md)

## Context

The operator has two control surfaces: the **web console** (design doc 0020)
and **Discord slash commands**. Design doc 0024 brought operator *designation* to
both. The operator shouldn't have to remember which surface can do what, and a
change on one surface shouldn't leave the other stale until a manual refresh.

## Decision

### 1. The parity invariant

**Every operator action/setting is available on both surfaces, and any change is
reflected live on the other.** Concretely:

| Action | Console | Slash command |
|---|---|---|
| Stop session | Stop button | `/skeinkeeper session action:stop` |
| Set eagerness | radio | `/skeinkeeper eagerness level:…` |
| List DM voices | persona dropdown | `/skeinkeeper voice action:list` |
| Set DM voice | persona dropdown + Apply | `/skeinkeeper voice action:set persona:…` |
| Designate operator | Operator panel (pick / @username) | `/skeinkeeper operator action:claim` (0024) |

Players' `/skeinkeeper consent …` is **not** an operator control (it's a
per-player self-action), so it's exempt from the parity table.

This invariant is a project convention going forward (also noted in the public
`CLAUDE.md`): a new operator control lands on **both** surfaces in the same change,
or not at all.

### 2. One write path per control

Each control is a single method on `SessionManager` (`setEagerness`,
`setDmVoice`/`setDmVoiceByPersona`, `stop`, `setOperator*`). Both the console API
handlers (`web/api.ts`) and the slash-command handlers call that one method —
which validates, mutates, persists (where applicable), and emits. No surface
duplicates the logic, so they can't drift.

### 3. Live cross-surface sync via the existing event bus

Every control method emits an `AppEvent` on the in-process bus, which the console
already streams over SSE (`/api/events`). New events: `eagerness`, `dmVoice`
(joining `status`, `operator`, `roster`). The console's `app.js` applies them in
place — selecting a DM voice via slash flips the console's dropdown without a
refresh, and vice versa. `GET /api/state` returns the same fields for initial
paint, so a freshly opened console is already in sync. The SSE echo is the single
confirmation log (the initiating surface doesn't double-log).

### 4. `session start` from Discord — deferred (gateway constraint)

A Discord bot only receives slash commands while its gateway client is connected.
Today the client connects in `SessionManager.start()` and disconnects in `stop()`,
so by the time any slash command can be received, a session is already running —
`/skeinkeeper session action:start` therefore can't cold-start the bot, and
replies that a session is already running (cold-start is a console action).

Closing this gap requires a **standing gateway client**: log in at app boot and
keep the connection up, making "start/stop session" a join/leave-voice + loop
on/off operation rather than login/logout. That reworks the most
live-validation-sensitive code (gateway lifecycle, voice join/leave, command
registration timing) and means the bot shows online whenever the app runs. It's
tracked as an open item rather than bundled here.

## Alternatives considered

- **Duplicate the control logic in each handler** — rejected; guarantees drift.
  Both surfaces calling one manager method is the parity guarantee.
- **Poll `/api/state` from the console** — rejected; the SSE bus already exists
  and gives instant, push-based sync.
- **Register slash commands globally + HTTP interactions endpoint** (to enable
  cold-start `/start` without a standing gateway client) — rejected for a local
  self-hosted app: it needs a public HTTPS endpoint Discord can POST to.

## Eval implications

Unit-tested: the console API handlers delegate to the manager and map results to
status codes (`web/api.test.ts`); `operatorActionIsPrivileged` (0024). The slash
registration/handlers, the AppEvent emission, and the console's live application
of events are gateway/browser I/O — operator live-validated.

## Open questions

- **Standing gateway client** (§4) — needed for `session start` from Discord and
  for the bot to stay reachable between sessions. Pending a decision.
- **Per-control authorization on slash** — only `operator claim/clear` is gated
  today (0024 §5). If session stop / settings need gating too, reuse the
  voice-channel-permission pattern.
