# ADR-0024: Silence is success — operator escalation discipline

Status: accepted
Date: 2026-05-26
Scope: operator-controls

## Context

[ADR-0023](./0023-operator-as-host-model.md) moves DM work — both pre-game
setup and in-play action — onto Skeinkeeper, narrowing the operator to host
pre-flight + observability + override. That decision settles **what** the AI
does. It leaves open the question of **how** the AI talks to the operator
when it is doing all that work autonomously.

A naïve implementation of an autonomous AI-DM produces a chatty operator
channel — every scene activation, every actor-ownership write, every
compendium import surfaces a notification "for transparency." The operator,
who under ADR-0023 is _a player at their own table_, then ends up
half-DMing again — reading messages from the AI, acknowledging routine
actions, getting pulled out of the fiction by the platform talking to them.
That defeats the premise.

The §4.8 PRD update at git SHA `9f8518a` named this directly:

> The AI's default is to proceed with what it inferred and tell the operator
> after the fact. It interrupts the operator only when a gap is genuinely
> blocking, a choice is genuinely ambiguous, or a judgment call has multiple
> equally-valid options and the operator's preference is needed. Silence is
> success.

This is a cross-cutting design pattern. All three of the §4.8 TDDs (0031,
0032, 0033) implement it: TDD 0031's intake classifier emits findings in
three kinds with different escalation behavior; TDD 0032's autonomous setup
actions degrade silently and surface recommendations on the _next_ intake
pass rather than interrupting mid-session; TDD 0033's triggered-action tool
handlers surface failures to the AI's turn loop (which decides how to
narrate the failure) but route to `notify_operator` only on a configurable
severity threshold. Without an ADR, every future TDD that touches the
operator channel has to re-derive the same rules and risks drifting.

This ADR is the _how_ of operator communication. It's the companion to
ADR-0023's _what_ of operator responsibilities, and it builds on
[ADR-0016](./0016-operator-control-parity-across-surfaces.md)'s decision
that _every_ operator-facing surface uses the same write path — so the
discipline applies uniformly to Discord DMs and the web console.

## Decision

**Operator-facing communication follows three rules, applied uniformly across
the Discord `notify_operator` channel and the web console's live-session
view.**

1. **Autonomous-by-default.** When an AI-driven decision has a clear-enough
   path forward — by a deterministic rubric, by a single unambiguous
   resolution, or by a prior operator-resolved choice carried in
   `SessionConfig` — the AI proceeds and records what it did in an
   informational "for your info" report (delivered with the next batched
   operator communication, not as its own interrupt). The operator can read
   it or not; nothing requires acknowledgement.

2. **Degrade silently on non-critical failures.** When an autonomous action
   fails on a non-critical surface (e.g., Foundry-side ownership assignment
   fails but the Skeinkeeper-side player-character map writes successfully;
   one indexing source errors while others succeed; one item in a loot
   distribution fails while others go through), the failure does not
   interrupt the operator. It is logged in the audit trail + telemetry, and
   surfaced as a `RECO_*` recommendation on the _next_ intake pass so the
   operator sees a consolidated batch of "things to maybe fix" rather than a
   stream of mid-session interruptions.

3. **Escalate only on critical gap, genuine ambiguity, or judgment call.**
   An interruption to the operator (any push notification, any blocking
   prompt) is justified only when:
   - A **critical gap** prevents the AI from proceeding at all (a hard-block
     finding under TDD 0031's classifier — no party actors, unrecognized
     system, missing required player content), or
   - A **genuine ambiguity** between equally-valid options requires operator
     preference (two campaign modules loaded, multiple plausible starting
     scenes, multiple source packs for the same creature), or
   - A **judgment call** the AI explicitly declines to make autonomously
     (where the rubric is intentionally narrow because the cost of choosing
     wrong is high — e.g., resolving a private PvP action when the toggle
     is off).

   Anything that doesn't meet one of these three bars is _not_ an
   escalation. It's either an autonomous action (rule 1) or a silent
   degradation surfacing as a recommendation (rule 2).

**Corollaries**

- **Recommendations are informational, not blocking.** A `recommendation`-kind
  finding (TDD 0031) renders in the "For your info" section of the intake
  report and never blocks any AI action. Operators may override via the
  finding-resolution path, but the default is "AI proceeds; here's what it
  did; correct it if you disagree."
- **Critical findings are the only blockers.** Only `critical-gap`-kind
  findings block the orchestrator's `announceReady`. Ambiguities defer
  _specific_ downstream actions (e.g., `AMBIG_STARTING_SCENE` defers scene
  activation but not onboarding); they do not block session-start as a
  whole.
- **Mid-session correction is a control, not an escalation.** When the
  operator wants to change something the AI did autonomously (switch the
  active scene, reassign a player's character, edit the Discord↔Foundry
  user map), they use the existing operator-control surfaces — slash
  commands + web-console controls per ADR-0016. The AI does not need to
  notify the operator that overrides are _possible_; the platform's
  affordances handle that.
- **Telemetry counts, not text.** The audit log records _what_ the AI did
  for replay; telemetry records counts + codes for system health. Neither is
  an "operator notification" — they're observability surfaces the operator
  can pull on, not channels the AI pushes onto.

## Consequences

**Positive**

- An operator who completes host pre-flight and never receives a
  `notify_operator` message has had a successful session. This is the
  testable end-state for the operator-experience invariant ADR-0023 names.
- Every future TDD touching the operator channel inherits a clear rubric:
  "is this a critical gap, a genuine ambiguity, a judgment call, or none of
  the above? If none, it's autonomous or a recommendation." Reduces the
  design surface area of every subsequent operator-facing feature.
- Reinforces ADR-0016's "one write path" model: the rules apply to whichever
  surface delivers the message, because both surfaces flow through the
  same write path.
- Sets the priority direction for the bridge gap roadmap: a gap that forces
  an escalation that wouldn't otherwise happen is higher-priority than a
  cosmetic gap. (For instance, the missing `list-users` tool degrades into
  a `RECO_FOUNDRY_OWNERSHIP_UNRESOLVED` recommendation under this discipline
  — which is silently-acceptable v0.5 behavior — rather than forcing
  per-player interruptions.)

**Negative / accepted**

- "Silence" is a discipline, not an automatic property. Implementers will
  reach for `notify_operator` for things that _feel_ important but don't
  meet the three-bar test (a config drift, a transient bridge error,
  recoverable retry chatter). Code review and the telemetry budget have to
  enforce the discipline — pure design rules don't.
- When the rubric for "critical gap vs. ambiguity vs. judgment call"
  disagrees with operator expectations in live use, the operator
  experiences either too much chatter (bar too low) or feels surprised by
  AI choices they wish they'd been asked about (bar too high). The fix is
  iteration on the rubric (the `FindingCode` set + classifier tables), not
  ad-hoc additions to the notification stream.
- An operator who _wants_ a play-by-play log of what the AI is doing has to
  pull on the audit log + web-console observability, not subscribe to a
  notification firehose. That's a deliberate tradeoff in favor of the
  default-quiet experience.

**Neutral**

- This ADR sets discipline; it does not constrain the operator's _ability_
  to ask the AI for a verbose-mode session (e.g., a "narrate every
  autonomous action" debug flag). Such a mode is a configuration choice,
  not a default; if it ships, it lives behind an explicit operator opt-in
  per the configurability spirit of [ADR-0009](./0009-telemetry-opt-in.md).
- The discipline is bounded by the operator-channel role. It does not
  govern player-facing communication — that lives in the behavior spec.

## Revisit when

- A live-session debugging mode is added (a verbose escalation flag the
  operator can toggle on for troubleshooting); ensure the verbose mode
  doesn't quietly become a default.
- A new escalation surface is introduced (e.g., an email/SMS channel beyond
  Discord); confirm the three-bar test still discriminates well on the new
  surface.
- The rubric for "judgment call" expands enough that re-evaluating against
  this ADR (rather than augmenting per-TDD) becomes worthwhile.
