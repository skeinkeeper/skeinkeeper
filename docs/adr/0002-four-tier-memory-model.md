# ADR-0002: Four-Tier Memory Model

## Status
Accepted (2026-05-17). **Warm-tier contents description superseded by [ADR-0013](./0013-warm-tier-after-foundry-source-of-truth.md) (2026-05-19)** following the Foundry-as-source-of-truth shift; the four-tier framing itself remains current.

## Context

A persistent AI DM running multi-session campaigns has four very different memory needs, and conflating them is the most common architectural failure in current AI-DM products:

1. The **current scene** — what's happening right now, last ~20 turns of dialogue.
2. **Mechanical state** — HP, spell slots, inventory, conditions, location, quest flags.
3. **Static content** — the Phandelver module text, SRD rules, monster stat blocks.
4. **Historical state** — what happened in prior sessions and how that shapes the present.

Naïve implementations stuff all four into the context window. This fails predictably: token cost explodes linearly with session count, the model gets distracted by stale detail, mechanical state drifts ("the model forgot we have 4 HP, not 24"), and at ~50k tokens of history the model starts losing the thread.

## Decision

**We adopt a four-tier memory model with distinct mechanisms per tier.**

| Tier | Contents | Mechanism | Update cadence |
|---|---|---|---|
| Hot | Current scene, last ~20 turns, active NPCs, active rules subset | In-prompt, sliding window | Every turn |
| Warm | HP, slots, inventory, conditions, location, quest flags, faction reputation, time-of-day | Structured DB (SQLite for v1), mutated via tool calls only | On every state change |
| Cold | Campaign content, SRD rules, monster stat blocks, map metadata | Vector store (LanceDB for v1), chunked + embedded | At campaign upload; rare updates |
| Episodic | Per-session structured summaries, key beats, NPC state deltas, party choices | Generated post-session; embedded; periodically consolidated into arc summaries | Post-session + periodic consolidation |

**Hot context** is assembled per turn from: warm-state snapshot (always), retrieved cold chunks (relevance-based), retrieved episodic summaries (relevance-based), and the dialogue window.

**Episodic consolidation** runs when episodic memory exceeds a configured token budget. Older session summaries are merged into higher-level "arc summaries" that preserve structured deltas (quest completions, NPC deaths) while compressing prose.

## Consequences

**Positive**
- Per-turn token cost stays roughly constant regardless of how many sessions have been played.
- Mechanical state lives in a real database, so it's correct by construction — the model can't forget the rogue's HP because it doesn't store it.
- Vector retrieval keeps Phandelver out of the prompt except where relevant, so the model isn't distracted by the entire module on every turn.
- Episodic memory lets the AI reference Session 2 events in Session 9 without dragging the full transcript along.

**Negative**
- More moving parts than "throw it all in context." We need a vector store, an embedder, a retrieval pipeline, and a consolidation job.
- Retrieval quality matters. Bad chunking of Phandelver = bad recall = AI improvises when it should follow the module. The chunking strategy is a real design problem, not a checkbox.
- Episodic consolidation is a place where information can be lost. We must preserve structured deltas separately from prose summaries.

**Neutral**
- This is the pattern most production LLM-agent systems converge on (CrewAI, LangGraph, AutoGPT-descendants). We're not inventing; we're following.
- The four-tier model is implementation-agnostic — SQLite + LanceDB for v1 is a choice, not a constraint. v2 could use Postgres + pgvector for multi-user deployments without changing the model.

## Hard rules implied by this ADR
- The LLM **never** reads warm state from its own prior turns; it reads from the DB.
- The LLM **never** mutates warm state via free text; only via typed tool calls (see [ADR-0003](./0003-tool-call-only-state-mutation.md)).
- Cold content is **never** placed in the prompt en masse; always retrieved per turn.
