# ADR-0025: Foundry is the table-text + operator surface

Status: accepted
Date: 2026-05-27
Scope: surface-model

## Context

[ADR-0023](./0023-operator-as-host-model.md) settled the operator's _role_
(host, not DM) and [ADR-0024](./0024-silence-is-success-operator-escalation.md)
settled the _discipline_ for talking to that operator. Neither settled the
question of **which platform** carries which kind of message at the table.

Through 0024, the implicit model was: Discord for everyone (voice for the
table, DM threads for private content + operator escalations + player
consent), Foundry for mechanical state (per [ADR-0018](./0018-foundry-source-of-truth.md)).
That model has three pressure points that surfaced together in the
PRD-rev `9f8518a` → `59a0fda` revision:

1. **Operator immersion.** ADR-0023 names the operator as a player at their
   own table. Discord DMs interrupt — they pop notifications, they pull
   attention, they're a separate window from the one the operator is
   already looking at (Foundry). Routing every operator-facing escalation
   through Discord DM works against the immersion ADR-0023 protects.
2. **The "second chat surface" problem for players.** Discord DMs as the
   private-content carrier means each player has _two_ chat surfaces during
   play: the Discord client (DM thread) plus Foundry (table-visible chat,
   character sheet, map). The behavior spec asks players to "stay in
   fiction"; asking them to also keep two chat windows in view splits
   attention against that ask.
3. **Anti-leak fragility.** Private content delivered over Discord DMs
   leaves Skeinkeeper as the _only_ enforcement layer for per-audience
   visibility (the bridge plays no role; the carrier doesn't know about
   audiences). Foundry's whisper primitive enforces visibility _itself_ —
   a whispered chat message is rendered only to the named users by the
   client. A two-layer model (Skeinkeeper composition + Foundry render)
   is structurally safer than a one-layer model (Skeinkeeper composition
   only).

The surface decision is cross-cutting. It dictates how operator
escalations route (TDD 0036, TDD 0031), how player whispers/PvP land
(TDD 0035), how operator commands are received (TDD 0040), how erasure
cascades (TDD 0038), and how the session-down failure mode notifies
(TDD 0039). Without an ADR, every new TDD touching a surface has to
re-derive the model and risks drifting.

This ADR is the _where_ of platform routing — the companion to ADR-0023's
_what_ and ADR-0024's _how_.

## Decision

**Foundry is the operator's primary surface and the table's text surface.
Discord is the voice surface and the one-time consent surface — nothing
more.** The web console is operator-only and stays at parity with the
Foundry operator surface (per [ADR-0016](./0016-operator-control-parity-across-surfaces.md)).

The full mapping:

| Surface              | Carrier           | Audience          | Role                                                                       |
| -------------------- | ----------------- | ----------------- | -------------------------------------------------------------------------- |
| `DiscordVoice`       | Discord voice     | table (broadcast) | DM narration, NPC voicing, player speech (turn input)                      |
| `DiscordConsent`     | Discord DM        | individual player | One-time consent DM to enable later private content; **no other use**      |
| `FoundryPublicChat`  | Foundry chat      | table             | Table-visible text — narration text, summaries, dice-roll public outputs   |
| `FoundryWhisper`     | Foundry whisper   | `player:<id>`     | Private content to one player (PvP, secret rolls, journal share, whispers) |
| `FoundryGmChat`      | Foundry GM chat   | operator (GM)     | All operator-facing escalations + after-the-fact notifications             |
| `FoundryChatCommand` | Foundry chat (in) | operator (GM)     | Operator commands — `/skeinkeeper <verb> <args>` parsed by the bridge      |
| `WebConsole`         | local HTTP        | operator          | Operator config + live observability; parity with `FoundryChatCommand`     |

**Corollaries**

- **Discord DM has exactly two exceptions to the consent-only rule.** The
  first is the consent DM itself (initiated by the operator's `consent
request` action). The second is the operator pause notification when
  Foundry is unreachable (TDD 0039) — there is by definition no Foundry
  surface in that state. Both exceptions require explicit operator/player
  DM-consent on file; neither is opt-out at v0.5. New exceptions require
  a superseding ADR.
- **Anti-leak is two-layer.** Skeinkeeper composes a single recipient
  payload (Layer 1: TDD 0035 §"Two-layer anti-leak"); Foundry renders
  that payload to only the named users (Layer 2: Foundry whisper
  semantics). Either layer alone would be sufficient for the visibility
  invariant; together they form defense in depth.
- **Surface routing is a single abstraction.** The SurfaceRouter
  (TDD 0034) takes `(audience, content, meta)` and dispatches to the
  surfaces above. No call site routes by carrier directly. This keeps
  the mapping centrally testable and the future "additional surface"
  (e.g., a mobile companion) an additive change.
- **Operator command parity is on Foundry chat, not Discord slash.** The
  parity table that previously paired the web console with Discord slash
  commands now pairs the web console with Foundry chat commands
  (TDD 0040 supersedes TDD 0025). The `/skeinkeeper <verb> <args>` verb
  taxonomy carries forward verbatim; only the bridge driver's chat-event
  listener replaces Discord's slash-command handler.
- **The bridge listener is on the v0.5 critical path.** Operator commands
  on Foundry require the bridge to surface chat events; the gap is
  Band A in TDD 0037 (supersedes TDD 0027). v0.5 cannot ship without it
  landing upstream or in the fork.

## Consequences

**Positive**

- Operator immersion is structural: with the GM chat as the carrier, an
  operator who stays in Foundry never has to alt-tab to read an
  escalation. ADR-0023's "operator as a player at their own table"
  invariant gains a platform-level enforcement.
- Players see one chat surface during play (Foundry's), not two. Discord
  is voice-only after the consent DM lands; "stay in fiction" is easier
  when the platform doesn't pull attention to a second window.
- Per-audience visibility gains a second enforcement layer at zero
  Skeinkeeper-side complexity — Foundry's whisper primitive does the
  work. The two-layer model survives a Skeinkeeper-side compose bug in
  a way the one-layer model would not.
- The SurfaceRouter abstraction localizes the mapping. A future surface
  (mobile-companion app; co-DM display) adds a row to the table; existing
  call sites do not change.
- Erasure cascades naturally to a Foundry-owned medium (per TDD 0038's
  `FoundryWhisperDeletionAdapter`): the bridge's filtered
  `delete-chat-messages` removes the artifact at the carrier, in addition
  to the Skeinkeeper-side record.

**Negative / accepted**

- **Foundry-down is now a session pause.** Under the old Discord-DM model,
  Foundry being unreachable meant a degraded but still-running session.
  Under this model, the operator can't read escalations, players can't
  receive whispers, and operator commands can't be sent — Foundry is
  load-bearing for the table-text and operator surfaces. The failure mode
  is explicit (TDD 0039: `paused-foundry-down`) but it adds an operational
  responsibility (operator keeps Foundry up) and a new failure mode the
  v0.5 has to handle.
- **The bridge is now critical for v0.5 _as a chat surface_, not just a
  mechanical-state surface.** ADR-0011 already preferred OSS bridges; this
  ADR raises the stakes — `post-chat-message` with audience targeting,
  filtered `delete-chat-messages`, and a chat-event listener are now
  v0.5-blocking. The fork-as-Plan-B clause of ADR-0011 is more likely to
  trigger.
- **Discord DM as carrier for the operator pause notification (TDD 0039)
  is the _only_ surface that can deliver "Foundry is down" — by
  definition.** That second DM-consent exception is unavoidable; it is
  named in TDD 0039 and constrained by operator DM-consent on file.
- **One-platform operator immersion is bought with one-platform fragility.**
  If Foundry goes down, the operator loses their primary surface during
  play. The web console parity (ADR-0016) covers this from the desktop,
  but the trade-off is real: this ADR puts more eggs in the Foundry
  basket than the previous model did.

**Neutral**

- This ADR does not constrain _what_ messages route to which surface — that
  is per-feature design (TDDs decide whether an event is GM-visible, table-
  visible, player-specific). It only constrains _which carrier_ a given
  audience uses, and how the routing is implemented.
- The fully-remote-all-individual table model assumed by this ADR is
  separately captured in [ADR-0026](./0026-fully-remote-all-individual-configuration.md);
  hybrid/in-person variations would alter the carrier list (e.g., a shared
  monitor for `FoundryPublicChat`) but not the audience→surface mapping.

## Revisit when

- A new carrier becomes viable that materially changes the mapping (e.g.,
  Foundry adds a first-class private-DM API at the application layer; the
  bridge adds a non-chat operator channel).
- The bridge fork lands enough capability to make a Foundry-side reveal
  (per TDD 0033) superior to the whisper-fallback model, and the
  Skeinkeeper-side Layer-1 composition is reconsidered as redundant.
- Hybrid/in-person table support is added in a future PRD — the audience
  model may need a new audience kind (`co-located:<table>`) that doesn't
  fit the surfaces here.
- An ADR-superseding event around Foundry availability (e.g., Foundry
  going read-only, the operator's instance becoming hosted elsewhere)
  changes the assumption that Foundry is operator-controlled.
