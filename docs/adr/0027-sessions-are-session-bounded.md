# ADR-0027: Sessions are session-bounded

Status: accepted
Date: 2026-05-27
Scope: session-model

> **Durable-list errata ([ADR-0031](./0031-errata-escalation-carrier-and-durable-surfaces.md)).**
> The durable-surface list below reads as closed but omits surfaces the shipped
> schema already makes durable — the dialogue transcript store (TDD 0013),
> `quest_flags` (ADR-0018), the `sessions`/`campaigns` rows, and voice assignments
> (TDD 0017). ADR-0031 adds them. The rule — new durable state is named by an
> ADR/TDD with a deletion path — is unchanged; those surfaces already have one.

## Context

The §4 surface model (ADR-0025) and the operator-as-host model
(ADR-0023) both presuppose a clear answer to a question that has been
implicit: **what state survives a session?** Without an explicit
position, every new feature has to re-derive the rule, and the gravity
is always toward "this state would be useful to keep around" — which is
how observability surfaces grow into databases, and how warm-tier
caches grow into hidden authoritative state.

The PRD-rev `9f8518a` → `59a0fda` revision made the implicit answer
explicit: **a session begins with Start and ends with Stop. Nothing
in-session state survives Stop except the small, named set of durable
surfaces that are independently justified.** Specifically:

- The `player_character_map` (TDD 0036) — durable identity bindings.
- Consents (TDD 0036 / privacy posture) — durable, revocable.
- The audit log (cross-cutting) — durable, append-only.
- Cold memory (TDD 0019) — durable, campaign-scoped.
- `SessionConfig.intake` (TDD 0031) — durable, per-campaign,
  operator-resolvable.
- `session_intake_finding` (TDD 0031) — durable, per-campaign;
  resolved/unresolved findings persist across sessions for re-Start
  determinism (deletion cascades on campaign delete per ADR-0014).
- The `deletion_log` (TDD 0038) — durable, append-only.

Everything else — the in-flight turn, the active scene's transient
context, the lull-and-greet state, the Coordinator's queue, the
`SessionRunState.coldIndexReady` flag, the active Foundry-event-stream
subscriptions, voice connection state, the LLM conversation window —
is born at Start and dies at Stop. Foundry-owned mechanical state per
ADR-0018 outlives sessions, but that's Foundry's responsibility, not
Skeinkeeper's.

The reason to ADR-ify the rule rather than leave it as design
convention: every TDD that touches lifecycle (TDD 0036 onboarding,
TDD 0039 Foundry-down lifecycle, TDD 0035 Coordinator, TDD 0031
intake) has to make consistent choices about what to persist. Without
the rule named, the choices drift; with the rule named, "is this
session-bounded or durable?" becomes a yes/no question with a clear
default.

## Decision

**Sessions are session-bounded. State is durable only when it is
named on the explicit durable-surface list above, and only when an
ADR or TDD names it durable. Everything else is born at Start and
released at Stop.**

**Corollaries**

- **The list of durable surfaces is closed.** A new surface joins
  the list only via an ADR or via a TDD that explicitly identifies
  itself as adding a durable surface (with a deletion adapter,
  per [ADR-0010](./0010-privacy-as-architecture.md)). The default
  for any new state is session-bounded; turning that default off is
  a deliberate, reviewed act.
- **Stop is the release point.** When `SessionManager.stop()` fires,
  the orchestrator releases the Coordinator, the SurfaceRouter, the
  `SessionRunState`, the perception subscriptions, the voice
  connection, and the LLM conversation. None of these need an
  "are you sure?" prompt; the design is that they are cheap to
  reconstruct on the next Start.
- **Pause is not Stop.** TDD 0039's `paused-foundry-down` state
  preserves the Coordinator and `SessionRunState` so a resume picks
  up where the pause began. Pause is a session-lifecycle state, not
  a session end.
- **Reconstruction must be cheap and deterministic.** Because
  session state evaporates, anything that needs to recover after a
  crash or a Skeinkeeper restart mid-session has to either (a)
  resume from a durable surface (e.g., the consent state recovers
  from the consent table) or (b) accept that the data is lost and
  the session restarts from `announceReady`. The Coordinator's
  in-flight turn does _not_ survive a restart; the audit log
  records what fired before the crash, but the turn does not resume.
- **Re-Start is a fresh session.** A second Start on the same
  campaign produces a new `sessionId`, a new Coordinator, a new
  `SessionRunState`. Prior session's transcripts, turn logs,
  Coordinator state are not re-loaded. The durable surfaces above
  _are_ loaded (so the AI remembers cold-tier content, prior intake
  resolutions, the identity map).
- **Cross-session state lives in cold memory or Foundry.** When a
  TDD reaches for "let me cache this between sessions" — that's
  cold-tier memory (TDD 0019) or it's Foundry-owned mechanical
  state (ADR-0018). It is not a new Skeinkeeper-side session-
  spanning table.

## Consequences

**Positive**

- The default for new state is the safe default: session-bounded.
  Reviewers can ask "what's the deletion path?" with the working
  assumption that the answer is "none — it dies at Stop" and only
  escalate to "show me the deletion adapter" when a TDD claims
  durability.
- The privacy posture (ADR-0010) tightens: every durable surface is
  on the list, every durable surface has a deletion adapter, no
  durable surfaces hide in transient-looking code.
- Stop semantics are simple: release in-process state, close
  carriers, done. No catalog of "and remember to clean up X" rules.
- Memory profile is bounded by session activity, not by total
  campaign-history activity, for any state that doesn't claim a
  durability ADR. Skeinkeeper at idle (between sessions) holds only
  the durable-surface data, not the full active-session footprint.
- Bug surface shrinks: cross-session state is the source of many
  subtle bugs ("X worked in the first session but broke in the
  second"). With the default being release, those bugs become
  loud (the second Start doesn't know about X) rather than quiet
  (X is stale and gives wrong answers).

**Negative / accepted**

- **Crash-recovery is "restart the session", not "resume the turn".**
  An LLM call mid-turn that gets killed by a Skeinkeeper restart
  loses that turn. The behavior spec accepts this as a v0.5
  posture; resilient mid-turn recovery is a future feature, not a
  v0.5 ask.
- **Some "useful between sessions" state has to either earn a
  durability ADR or get reconstructed every Start.** For example, a
  hypothetical "operator's favorite eagerness setting" — that's
  durable (a campaign-config field, with a deletion path); a
  hypothetical "the AI's running theory about which player is the
  traitor" — that's session-bounded (or it joins the cold-tier
  episodic memory with explicit retention).
- **TDDs cannot grandfather durable state.** A TDD that introduces
  state has to make the call up front: session-bounded or durable.
  Retrofitting durability later requires either an ADR or an
  explicit TDD-level declaration. This shifts work to design time,
  not implementation time — which is the right place for the
  trade-off, but it's _more_ work than "decide later."

**Neutral**

- The rule does not constrain _behavior across sessions_ — the AI
  legitimately remembers prior sessions via cold-tier memory and via
  Foundry-owned state. The constraint is on _Skeinkeeper-side
  storage of in-session transients_, not on the AI's apparent
  continuity.
- The rule does not constrain external observers (the operator
  watching telemetry; a future Langfuse export of a session
  transcript). Those operate on the audit log and telemetry, which
  _are_ durable surfaces; the rule scopes Skeinkeeper-side
  in-process state, not observer-facing exports.

## Revisit when

- A new use case requires durable cross-session state that doesn't
  fit any of the existing durable surfaces (cold memory,
  identity map, consent, audit log, intake config, deletion log).
  The question is whether to extend an existing surface or to add a
  new one — both are valid, but both need explicit decision.
- The "crash mid-turn restart" cost becomes high enough in practice
  that a turn-level checkpoint surface is worth introducing
  (likely paired with an ADR-0010 deletion path).
- A future cross-session feature (e.g., "show me the AI's running
  notes from last session") emerges and forces a clear distinction
  between "AI internal state we let the operator see" (a new durable
  surface) vs. "AI internal state we keep but don't expose" (still
  session-bounded; not what's being asked for).
