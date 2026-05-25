# TDD 0024: Operator Self-Designation (Console + Slash Command)
Status: implemented
PRD refs: 4.4, 4.6
PRD-rev: 10391ba
ADR constraints: 0010
Author: maintainers
Date: 2026-05-20
Related TDDs: [0020 (operator app)](./0020-operator-app.md), [0023 (onboarding + operator channel)](./0023-session-onboarding-presence-operator-channel.md)
Supersedes: §4 (operator designation) of [design doc 0023](./0023-session-onboarding-presence-operator-channel.md)

## Approach

Design doc 0023 §4 designated the operator with a single environment variable,
`DISCORD_OPERATOR_USER_ID` — a raw Discord **snowflake** the operator could only
obtain by enabling Developer Mode and copying their user ID. That's poor UX: it's
an opaque number, it can't be changed without editing `.env` and restarting, and
it isn't discoverable from the surfaces the operator actually uses (the console
and Discord).

This doc makes operator designation **friendly and runtime-settable**, from both
the operator console and Discord, while keeping the env var as a headless
fallback. It does not change *what* the operator designation is used for (private
DMs for setup escalations, per 0023) — only *how* it's set.

A hard constraint shapes the design: **Discord bots cannot look up a user by
display name, and the API removed username→account lookup.** Any human-friendly
identifier must be *resolved to a snowflake* through a path that carries or finds
the account. Three paths do this; all converge on a stored snowflake.

### 1. Three ways to designate the operator (all resolve to a snowflake)

1. **Discord slash command** — `/skeinkeeper operator claim` makes the invoking
   user the operator (the interaction carries `interaction.user.id`, so no ID or
   username is typed). `/skeinkeeper operator clear` unsets; `/skeinkeeper
   operator show` reports who's set. This is the cleanest path and needs nothing
   but running the command.
2. **Console picker** — while a session is running, the console shows a **live**
   list of who's in the voice channel; the operator clicks "This is me." The
   snowflake is captured invisibly (the operator never sees or types it). The
   list updates without a page refresh (see §3).
3. **Console username field** — the operator types their Discord **@username**
   (unique, findable in Settings → My Account, no Developer Mode). Skeinkeeper
   resolves it to a snowflake via a targeted guild member search. If a session
   isn't running yet (no gateway client), the username is stored *pending* and
   resolved at the next session start. Resolution is best-effort: a query that
   doesn't uniquely match reports back and points the operator at the picker or
   the slash command. (Reliable username search may require the bot's privileged
   Server Members intent; the slash command and picker avoid this entirely.)

The env var `DISCORD_OPERATOR_USER_ID` remains a valid **fallback default** for
headless/Docker operators. Precedence: a persisted designation (set via any of
the three paths above) wins; otherwise the env var; otherwise unset (escalations
fall back to the console log, degraded).

### 5. Authorizing the slash command (security)

`/skeinkeeper operator claim`/`clear` *mutate* who receives setup DMs, so they
must be authorized — otherwise any guild member could redirect the operator
notes to themselves (info disclosure) or silently clear them (denial), and the
designation would become a privilege-escalation path if operator-by-DM control
lands later (deferred in 0023). `show` is read-only and stays open.

The gate is a **Discord permission scoped to the play voice channel**: the
invoker must hold **Manage Channel** on the configured voice channel
(`voiceChannel.permissionsFor(member).has(ManageChannels)`). This ties "who can
become operator" to whoever administers the actual room where play happens —
a tighter, more contextual boundary than a server-wide role — and uses Discord's
own permission system (set once via a channel permission overwrite) rather than a
secret typed into chat (a slash-command password argument would itself leak the
key into Discord's servers/logs and client UIs). Server Administrators and the
owner pass via Discord's admin override, as expected.

The **console** path (`POST /api/operator`, the picker + @username field) is *not*
subject to this voice-channel check: the console is the admin plane, already
gated by the operator password (or localhost-only), so an authenticated console
operator may designate anyone. The asymmetry is intentional — the two planes are
gated by their own native mechanisms (console password vs. Discord permission).

## Components & interfaces

### 3. Live console updates

The console already streams `/api/events` (Server-Sent Events) from the
in-process event bus. Two new `AppEvent`s ride it:

- `roster` — the current voice-channel members (id + display name + whether each
  is the operator), emitted on session start and on every join/leave. The
  SessionManager subscribes to the same `PresenceSource` it feeds the voice loop
  and republishes to the bus.
- `operator` — the current operator (id + display name), emitted whenever it
  changes via any path, so all three surfaces stay consistent without a refresh.

`GET /api/state` includes the same operator + roster snapshot for initial paint;
`POST /api/operator` accepts `{ discordId } | { username } | { clear: true }`.

## Data & state

### 2. Persistence

A new tenant+campaign-scoped key/value table, `settings` (mirroring the
`quest_flags` pattern), holds the resolved operator under
`operator.discord_user_id` (and, transiently, `operator.pending_username`). It
survives restarts, so designation is a one-time setup. The env var is *not*
auto-persisted — it stays a pure fallback, so clearing the persisted value falls
back to env cleanly.

A generic `settings` table (rather than a bespoke column) keeps room for other
console-settable persistent config later without further migrations.

### 4. Privacy & erasure (ADR-0010)

The stored value is the **operator's own** Discord user ID — operator-set
configuration, not player data collected about a subject. It is documented in
PRIVACY.md and erased the same way `quest_flags` is: by **FK cascade** when the
campaign row is deleted. The existing `CampaignAdapter` deletes the campaign on
both **campaign** and **tenant** erasure, so `settings` rows cascade away with no
new deletion adapter (matching the established convention). It is intentionally
*not* removed by **player-scope** erasure: a player asking to be forgotten
doesn't unset the table's operator. Consent still gates all audio; presence
remains transient (0023). No new product telemetry.

## Sequencing / implementation plan

Covered under Approach.

## Failure modes & edge cases

Covered under Approach.

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
|---------|-------------|--------------|
| 4.4 | Operator designation is friendly and runtime-settable, not a raw snowflake in `.env` | Three designation paths (slash command, console picker, @username field) all resolving to a stored snowflake; env var kept as headless fallback |
| 4.6 | Operator designation persists across restarts and is consistent across surfaces | Generic `settings` k/v table with FK-cascade erasure; SSE `operator` + `roster` events keep all three surfaces live-synced |

## Dependencies considered

None — no new third-party dependency introduced by this design.

## PRD conflicts surfaced (and resolution)

None — this design supersedes 0023 §4 for the *how* of operator designation; no PRD requirement proved infeasible or contradictory.

## Decisions to promote (ADR candidates)

None — the durable decision (operator designation resolves to a snowflake; generic `settings` table for console-settable config) is scoped to this doc and naturally follows ADR-0010's erasure-path convention.

## Alternatives considered

- **Keep the env-var-only snowflake** — rejected; the UX problem this doc exists
  to fix.
- **Store the display name instead of a snowflake** — rejected; display names and
  nicknames aren't unique (two "Chris"es collide) and can't be DMed directly.
- **Discord OAuth to link the console login to a Discord account** — rejected for
  v1; heavy (an OAuth flow + redirect URI) for a single-operator local app. The
  slash command achieves the same "it's me" binding with one command.
- **A bespoke `operator` column on `campaigns`** — rejected; a generic `settings`
  k/v avoids a migration for the next console-settable value and matches the
  existing `quest_flags` shape.
- **Standing gateway client so the picker works with no session** — rejected for
  v1; the operator is in voice during play, and pending-username covers
  pre-session setup.
- **A password argument on the slash command** (§5) — rejected; slash-command
  inputs are sent to Discord and can surface in client UIs/logs unmasked, so it
  would leak the secret into chat. A Discord permission is the native equivalent.
- **A server-wide permission (Manage Server / Administrator) for the slash
  command** (§5) — viable, but a voice-channel-scoped Manage Channel ties
  authority to the actual play room, which better matches what "operator" means;
  admins still pass via the admin override either way.

## Eval implications

Pure + unit-tested: the username→member resolution (`resolveOperatorFromMembers`:
exact-username match, ambiguity, miss), the env/persisted precedence, the
`settings` accessor + erasure adapter, and which slash actions are privileged
(`operatorActionIsPrivileged`). The live roster SSE, the slash command + its
Manage-Channel permission check, and the DM delivery are operator live-validated
(gateway I/O).

## Open questions

- **Multiple operators / co-DM** — still single-operator (one
  `operator.discord_user_id`); a set/list could come later on the same table.
- **Free-form operator DM replies** — still deferred (privileged MessageContent
  intent); slash commands + console cover control for now.
