# ADR-0031: Errata — operator-escalation carrier (ADR-0024) and durable-surface list (ADR-0027)

Status: accepted
Date: 2026-08-15
Scope: operator-controls, session-model
Relates to: ADR-0024, ADR-0025, ADR-0027, ADR-0018

## Context

Two accepted ADRs drifted from the as-built design and can mislead a future TDD
author who reads them in isolation (they are binding under the index rule "only
`accepted` ADRs are binding constraints for new TDDs"):

1. **ADR-0024** ("silence is success") was written before the surface model and
   describes operator escalation as flowing over "the Discord `notify_operator`
   channel." [ADR-0025](./0025-foundry-as-table-text-and-operator-surface.md)
   subsequently re-homed that carrier to Foundry GM chat, and the shipped code
   (`SessionManager.emitOperatorNote` → `FoundryGmChatSurface`) matches ADR-0025,
   not ADR-0024's wording.

2. **ADR-0027** ("sessions are session-bounded") presents its durable-surface
   list as _closed_ ("a new surface joins the list only via an ADR or TDD"), but
   the list omits several surfaces the shipped schema already persists across
   sessions. Read literally, the closed list is inconsistent with the database.

Under the project's append-only ADR discipline, the substance of an accepted ADR
is a historical record; corrections are made in a new ADR rather than by
rewriting the original. This ADR is that correction for both items. The originals
carry an editorial pointer here; their Context/Decision/Consequences are
otherwise unchanged.

## Decision

**1. The operator-escalation carrier is Foundry GM chat, not Discord.**
Wherever ADR-0024 refers to "Discord" as the escalation carrier, the binding
carrier is **Foundry GM chat** — a whisper to the operator's Foundry user when
one is known, GM-broadcast otherwise — per ADR-0025's surface mapping. ADR-0024's
_discipline_ is unchanged and remains binding: autonomous-by-default; degrade
silently on non-critical failure; escalate only on a critical gap, a genuine
ambiguity, or a declined judgment call. The two standing Discord-DM exceptions
(the one-time consent DM, and — once [TDD 0039](../tdd/0039-foundry-down-session-lifecycle.md)
lands — the Foundry-down pause notification) are the only operator/player text
uses of Discord.

**2. ADR-0027's durable-surface list additionally includes the following**, which
the shipped schema already persists across sessions and which each already have a
deletion path (directly or by FK cascade), so they are durable-by-construction,
not new state:

- The **dialogue transcript store** (`dialogue`) — [TDD 0013](../tdd/0013-dialogue-persistence-session-lifecycle.md);
  erased by `DialogueAdapter` (player/tenant) and FK cascade (campaign).
- **`quest_flags`** — the AI-DM internal plot state ([ADR-0018](./0018-foundry-source-of-truth.md));
  campaign-scoped, cascades on campaign delete.
- The **`sessions` and `campaigns`** rows themselves — campaign/tenant scoped,
  covered by `CampaignAdapter` + FK cascade.
- **Voice assignments** (`voice_assignment`) — [TDD 0017](../tdd/0017-voice-assignment.md);
  campaign-scoped.

ADR-0027's actual rule — _new_ durable state must be introduced by an ADR or a
TDD that names it durable and ships a deletion adapter — stands unchanged. This
ADR only makes the enumerated list match the database as-built so "the list is
closed" is a true statement.

## Consequences

- A TDD author reading ADR-0024 or ADR-0027 reaches the correct conclusion about
  the escalation carrier and the durable-surface set without having to reconcile
  the drift themselves.
- No code change: the code already routes escalations to Foundry GM chat and
  already persists + erases the listed surfaces. This ADR is documentation
  reconciliation, not a behavior change.
- The session-bounded _default_ (ADR-0027) is unchanged: anything not on the
  (now-complete) list is still born at Start and released at Stop.

## Revisit when

- A further surface migration changes which carrier holds operator escalations
  (would supersede ADR-0025 and moot part 1 here).
- A genuinely new durable surface is added — that still requires its own ADR/TDD
  with a deletion adapter, per ADR-0027's unchanged rule.
