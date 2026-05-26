# ADR-0023: Operator-as-host model

Status: accepted
Date: 2026-05-26
Scope: operator-model
Supersedes: ADR-0015

## Context

[ADR-0015](./0015-operator-pregame-ai-performs-in-play-dm-actions.md) drew the
operator/AI boundary by _phase_: the operator does pre-game world preparation
(importing the adventure, naming/curating scenes, providing keys, configuring the
DM voice and eagerness, gathering consents); the AI does every in-play DM action
once the session starts. That boundary made sense when "pre-game" meant the
human DM's content-curation work, and "in-play" meant the table actions a DM
performs during a session.

Two things changed since 0015 was accepted (2026-05-20):

1. **Live play surfaced that the operator's pre-game burden is the wrong thing
   for an AI-DM product to optimize for.** The original framing treated
   "preparing a session" as a fixed human cost ("the operator imports the
   adventure"). In practice, almost everything between sitting down at the
   table and starting to play — assessing what content is loaded, picking
   which scene to start in, mapping Discord users to character actors,
   deciding which monster stat block to use, importing the monsters the party
   will plausibly encounter — is _DM work that a human DM does in the
   between-sit-down-and-start gap_, not content curation. Making the operator
   do it before each session is asking them to be a DM, which is exactly what
   Skeinkeeper exists to remove.
2. **The Foundry MCP bridge surface, especially the writes (ownership
   assignment, scene activation, compendium-to-world actor import,
   journal/scene read), has matured enough that the AI can do this work
   autonomously.** What was originally one-time setup is now incremental and
   automatable.

Together these reframe the operator at the table: not the DM, but the **host**
— the person who launches the platform, opens the venue, and lets the AI run
the game. The PRD update at git SHA `9f8518a` (§3 + §4.8) made this explicit
and added concrete design requirements (session intake routine, intake report,
autonomous pre-game setup actions, operator-as-host principle, silence is
success). [TDDs 0031, 0032, 0033](../tdd/) design the implementation.

ADR-0015's specific text — "Pre-game = the operator" — is now wrong on
substance, not on wording. The operator no longer does pre-game setup work;
they do _host_ pre-flight, which is a smaller and qualitatively different set
of tasks. Under the throughline append-only rule, that's a supersession, not
an edit.

## Decision

**Split responsibilities by _role_, not by _phase_.**

- **Host pre-flight = the operator.** Before Start: Foundry is running with the
  intended campaign content (system + module + compendium packs) loaded; the
  Foundry MCP bridge is connected; a Discord voice channel exists and the bot
  has been invited; Skeinkeeper is running with credentials configured per
  §4.5; players have an invite to the Discord channel. That is the operator's
  total per-session obligation.
- **Everything else = Skeinkeeper.** All work that a human DM would do
  between sitting down and starting the game _and_ during the game itself is
  the AI's job: assessing materials, classifying gaps/ambiguities/recommendations,
  picking the starting scene, mapping Discord users to Foundry actors,
  assigning Foundry ownership, pre-loading expected content, indexing
  source material, plus every in-play DM action ADR-0015 already named
  (activating/switching scenes, moving and revealing tokens, applying
  conditions and damage, rolling for NPCs/secret checks, advancing combat,
  revealing fog, voicing NPCs, adjudicating rules, pacing, narrating).

**Corollaries** (carried forward from ADR-0015 with the boundary updated):

1. **Any work the operator must do at the table beyond host pre-flight is a
   bug**, tracked and closed — not an accepted limitation. This generalizes
   ADR-0015's "any in-play DM action that requires the operator is a bug" to
   also cover pre-game setup work that fell to the operator under ADR-0015.
2. **The AI must have a tool for every DM action — pre-game setup _and_
   in-play.** Where the VTT supports an action but the MCP bridge does not
   expose it, that is a coverage gap to close (wire it, contribute upstream,
   or fork). The DM-action coverage audit (TDD 0022) and the bridge gap
   re-audit (TDD 0027) extend to pre-game writes — actor ownership
   assignment, compendium-to-world imports without token placement, world-
   level user enumeration — not only in-play writes.
3. **The operator console is host pre-flight + observability + override**, not
   a DM control panel and not a pre-game setup wizard. It configures and lets
   the operator _watch_ and _correct_; it is not where the game (or its
   setup) is _run_ from.
4. **Out of scope for the AI** (unchanged from ADR-0015 §corollary 4): things
   a VTT shouldn't decide either — what an NPC does next, the story, the
   rolls' _meaning_. Those are DM _judgment_, not VTT _actions_ and not
   setup actions. The boundary is about table and setup **actions**, not
   authoring.
5. **Operator escalation is autonomous-by-default.** The AI proceeds with
   what it inferred and tells the operator after the fact; it interrupts the
   operator only on a critical gap, a genuine ambiguity between equally-valid
   options, or a judgment call where the operator's preference is needed.
   This corollary is the seed of the companion ADR on operator escalation
   discipline ([ADR-0024](./0024-silence-is-success-operator-escalation.md)).

## Consequences

**Positive**

- Restores the product premise. The operator is a player at their own table,
  not a between-session DM-assistant; everything that would force them to be
  the DM is closed as a bug.
- Drives a concrete, growing requirement set for the bridge: not just in-play
  writes (ADR-0015), but also pre-game writes (ownership assignment, world-
  level user enumeration, audience-targeted content reveal). Bridge
  contributions and the fork-as-Plan-B clause (ADR-0011) extend naturally.
- Makes "silence is success" a measurable invariant: an operator who
  completes host pre-flight and never sees a notify_operator message has had
  a working session. That is a testable end-state for the experience, not a
  marketing claim.
- Aligns the operator console's role around three verbs only: configure
  (host pre-flight), watch (observability), correct (override). No fourth
  verb of "prepare per session" leaks back in.

**Negative / accepted**

- Closing the pre-game write surface raises the priority of bridge work that
  ADR-0015 already raised the priority of: ownership assignment was already
  on the list; world-user enumeration is new and is added to TDD 0027's
  upstream batch. The fork-as-Plan-B path is now load-bearing for setup
  features the bridge doesn't yet support.
- The AI takes on judgment that ADR-0015 explicitly left to the operator
  (e.g., picking the starting scene when more than one is plausibly the
  starter). This is accepted as the right judgment surface — the operator can
  override via finding-resolution (TDD 0031) or via the live-session
  control — but it does change what "failure" looks like: an AI that picks
  wrong is now a behavior bug, not an unhelpful prompt.
- Increases the per-session intake compute cost (read the Foundry world,
  classify findings, index source material). Concurrency mitigates (TDD 0031
  - 0032 run extended intake in parallel with the onboarding ritual), but it
    is non-zero new work at Start.

**Neutral**

- The reframe doesn't change the table-action invariant from ADR-0015
  (everything the human DM would do _at the table_ is still the AI's job);
  it widens the scope to also cover between-sit-down-and-start setup.
- Existing TDDs that name ADR-0015 as a constraint (0022, 0023, 0026, 0027)
  remain correct in their existing scope. New TDDs (0031, 0032, 0033) name
  this ADR as the operative constraint. Updating prior TDDs' frontmatter to
  cite this ADR alongside 0015 is not required (the supersession is recorded
  here); TDDs that ship under this ADR cite this one directly.

## Revisit when

- A "no-VTT, text-only" mode is added (the invariant still holds; both
  pre-game and in-play action sets just shrink).
- A multi-operator or team-of-DMs configuration is contemplated (would change
  whose pre-flight is whose; not on the roadmap).
- The bridge gains a feature that makes some specific pre-game work cheaper
  to leave to the operator after all (none is known today; a hypothetical
  example would be an operator-side authoring UX that's better than any
  AI-driven version we can produce).
