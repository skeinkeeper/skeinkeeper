# ADR-0026: Fully-remote, all-individual table configuration

Status: accepted
Date: 2026-05-27
Scope: session-model

## Context

The original PRD framing supported a hybrid table — some players physically
co-located around a shared microphone and shared screen, others remote on
Discord voice — with Skeinkeeper accommodating both. The PRD-rev
`9f8518a` → `59a0fda` revision narrowed this materially: v0.5 supports
**only** the fully-remote configuration where every participant has their
own Discord voice connection, their own Foundry login, and their own
chat surface.

The narrowing is driven by what the surface model (ADR-0025) requires to
work:

1. **Per-player voice attribution requires a per-player audio stream.**
   The always-listening loop attributes utterances by Discord user ID
   (TDD 0015). A shared microphone breaks that attribution — multiple
   players speaking through one Discord user produces speaker
   confusion that's hard to disambiguate live.
2. **Per-audience whispers require a per-player Foundry session.** The
   Foundry whisper primitive routes by Foundry user ID. A shared Foundry
   client (one operator screen-sharing to the room) can't deliver a
   whisper to one player without exposing it to the table — the whisper
   renders on the shared screen.
3. **Per-player consent requires a per-player Discord identity.** The
   one-time DM consent flow (TDD 0036) presupposes each player can be
   reached over a 1:1 Discord channel and respond as themselves.
4. **Pre-flight identity verification assumes one Discord ↔ one Foundry ↔
   one actor.** TDD 0036's 3-way identity map verifies a 1:1:1 mapping;
   shared identities break the verifier's invariants.

Supporting hybrid configurations safely would require either materially
weakening the per-audience invariants (rejected per ADR-0017) or building
parallel code paths for shared-identity edge cases that v0.5 cannot
afford. The cheaper alternative — and the one the PRD revision selects —
is to scope v0.5 to the configuration where the surface model and
identity model already hold, and revisit other configurations in a
superseding ADR.

## Decision

**v0.5 supports exactly one table configuration: fully-remote,
all-individual.** Every participant has:

- Their own Discord identity and their own active voice connection to the
  campaign's voice channel.
- Their own Foundry user account and their own Foundry session active
  during play.
- Their own DM-consent on file (one-time, per [TDD 0036](../tdd/0036-onboarding-and-foundry-user-preflight.md)).
- A 3-way identity binding (Discord user ↔ Foundry user ↔ actor) verified
  at pre-flight.

The operator is themselves one such participant (they get a Discord
identity, a Foundry GM user, and — if also playing a character — a player
actor binding). The operator's GM role is what differentiates them from
players; everything else in the configuration is symmetric.

**Corollaries**

- **No co-located audio.** A single Discord voice connection carries
  exactly one named speaker; multi-speaker microphones are out of scope.
  Two players sharing one mic at v0.5 produces "I don't know who that
  was" handling, not silent acceptance.
- **No shared Foundry screens for private content delivery.** A
  screen-sharing operator who broadcasts Foundry to the room would
  defeat the whisper layer of the anti-leak model (ADR-0025
  corollary 2). That configuration isn't _blocked_ by code, but it is
  _unsupported_ — Skeinkeeper's privacy guarantees assume per-player
  Foundry sessions, and the operator running a shared-screen table has
  silently opted out of those guarantees. The behavior spec / PRIVACY
  doc names this explicitly so operators aren't misled.
- **The pre-flight verifier is strict, not heuristic, on 1:1:1.** Multiple
  players sharing one Foundry user → `extra-foundry-users-not-mapped` or
  `foundry-user-not-owning-actor` finding, depending on the shape; the
  operator must resolve before Start.
- **Operator-only-table is supported (and tested).** An operator playing
  a solo session against the AI is the fully-remote-all-individual
  configuration with N=1 players + the operator. The audience model
  collapses (`table` and `gm` largely overlap; `player:<id>` has at most
  one target) but the surface model and identity model still hold.

## Consequences

**Positive**

- The audience model from ADR-0017 holds end-to-end: every audience tag
  resolves to exactly one carrier instance per recipient.
- The anti-leak model from ADR-0025 holds — the two layers (Skeinkeeper
  composition + Foundry whisper render) both presuppose per-player
  Foundry sessions, which this ADR makes a session-precondition.
- Pre-flight invariants are simpler to verify and to test: 1:1:1 is a
  deterministic shape, not a probabilistic match.
- Scoping v0.5 prevents a category of latent bugs that hybrid
  configurations would silently produce (cross-player whisper leakage,
  mis-attributed turn input, ambiguous consent).
- The constraint maps cleanly to the v0.5 reference deployment (a remote
  friend group on Discord + each running their own Foundry session) —
  it's not artificial scoping, it's the actual table.

**Negative / accepted**

- **Co-located tables are explicitly out of scope.** A user group with
  three players in a room and two remote can't run Skeinkeeper in its
  natural configuration. The recommended workaround is "everyone joins
  Discord on their own device even when co-located," which is awkward
  for in-person play. There is no v0.5 better answer; a future ADR may
  re-open the question.
- **A "casual" table where two siblings share a Discord account is
  unsupported.** The fix is per-player Discord accounts; we do not try
  to de-multiplex one identity across two voices.
- **Operator-as-screen-sharer for the table table is silently
  unsupported.** This is a real configuration some tables run; we name
  it as out-of-scope in PRIVACY rather than silently failing, but we do
  not provide a different mode for it.
- **The pre-flight verifier rejects shapes that human DMs would
  intuitively accept** (e.g., one Foundry user controlling multiple
  PCs for one player; one Foundry account shared by a parent-child
  pair). This is a deliberate cost of strict 1:1:1; loosen in a
  superseding ADR if reference deployments hit it often.

**Neutral**

- This ADR does not pick a _voice topology_ (mesh vs. SFU vs. native
  Discord) — it relies on Discord's existing voice infrastructure, which
  is per-user by construction. Future voice plugins (per ADR-0021's
  cascaded voice architecture) would inherit the per-user constraint.
- The configuration does not constrain _count_ of players (the table
  invariants from ADR-0020 still apply). It only constrains _identity
  shape per participant_.

## Revisit when

- A reference deployment with a strong hybrid-table use case emerges
  and the cost of co-located audio mis-attribution is concretely
  measured.
- Foundry adds a feature that decouples a player's view from their
  user session in a way that preserves whisper visibility (e.g., a
  "shared display" mode that doesn't render private content).
- A voice provider plugin lands that natively supports speaker
  diarization for multi-speaker microphones with high enough accuracy
  to drive turn attribution.
- The privacy/consent posture changes enough that "everyone uses their
  own device" is no longer a pre-condition for the audience model
  (which would itself need a superseding ADR-0017 or ADR-0025).
