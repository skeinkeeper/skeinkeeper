# ADR-0020: Single shared scene invariant (no party-splitting)

Status: accepted
Date: 2026-05-24
Scope: session-model
Relates to: ADR-0003, ADR-0015, ADR-0017

> This ADR formalizes the load-bearing constraint introduced in §1 of
> [TDD 0026 (1:1 Player↔DM Side-Channels)](../tdd/0026-player-dm-side-channels.md).
> The *design* of side-channels (the Coordinator/concurrency model, the audience data model,
> behavior rules) stays in TDD 0026; the audience/erasure dimension is its own decision in
> ADR-0017. This ADR records only the session-model invariant the rest of that design rests on.

## Context

An AI DM connected over Discord has no "one mouth, one attention budget" limit, so it *can*
hold private 1:1 side-channels with individual players while the table plays on. The open
question that design raised is how far that parallelism extends — in particular, whether the
group's world can fork into separate concurrent scenes (party-splitting). That choice is
load-bearing: the data-model and concurrency seams are cheap to set now and brutal to retrofit
once code assumes a single, table-only conversation.

## Decision

**One shared world, one timeline, one active scene. No party-splitting.**

- A side-channel is always **1:1** (one player ↔ the DM); no private group sub-conversations.
- Foundry exposes a single active scene and already personalizes *within* it (per-player
  fog/vision, per-player handout reveals) — enough for private knowledge without separate scenes.
- **The single-scene invariant:** a private action is permitted only if it **resolves entirely
  within the current shared scene and does not require or presume another PC's choices.** This
  is what keeps the shared timeline coherent and private actions resolvable.

## Consequences

- The **serialized writer** becomes load-bearing, not a safety belt: all world-state mutations
  flow through a single per-campaign serialized writer (per ADR-0003, tool-call-only), so
  parallel side-channel reasoning never races the world.
- Private knowledge and private actions are supported; **forked timelines, concurrent scenes,
  and party-splitting are not.**
- Cheap to assume now; expensive to retrofit later — which is exactly why it is fixed here.
- Reversing it (supporting party-splitting / multiple concurrent scenes) would require a
  superseding ADR and a substantial concurrency redesign.
