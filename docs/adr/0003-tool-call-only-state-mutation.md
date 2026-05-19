# ADR-0003: All State Mutations and Dice Rolls Occur via Typed Tool Calls

## Status
Accepted (2026-05-17)

## Context

LLMs are excellent at narration and judgment, and unreliable at mechanical bookkeeping. A model asked to "track HP across the encounter and narrate the fight" will, with high reliability:

- Forget current HP partway through.
- Apply a damage value incorrectly (transposed digits, wrong target).
- Silently revise prior outcomes ("the orc, now at 12 HP" — except it was at 8 last turn).
- Roll dice "in its head" by generating numbers that have a plausible distribution but aren't actually random.

In a single-shot story-generation context, none of this matters. In a persistent multi-session game where players are tracking their HP, planning resource usage, and trusting that the world is consistent, all of it matters. Player trust collapses fast when mechanics drift.

Tool use solves this. Deterministic code rolls the dice, mutates the state, and returns the result. The LLM narrates over the deterministic outcome.

## Decision

**The LLM mutates no state directly. Every mechanical change in the world happens through a typed tool call.** Specifically:

- All **dice rolls** invoke `roll(formula, advantage?, secret?)`. The model never produces a die result in prose. The result returned from the tool is what the model narrates.
- All **state mutations** invoke typed tools: `apply_damage`, `heal`, `set_condition`, `clear_condition`, `update_inventory`, `set_quest_flag`, `move_party`, `move_token`, `update_npc_disposition`, `advance_time`, etc.
- All **VTT operations** invoke the `VTTDriver` interface, which routes to Foundry MCP commands.
- The **fudging capability** is itself a tool (`fudge_roll`); see [behavior spec §5.4](../../behavior/default.md) for when it may be invoked.

The orchestrator enforces this at the engine level: any model output that *appears* to assert a state change but does not call a tool is flagged. Initially we surface these as warnings in the audit log; eventually we may classify and reject them.

## Consequences

**Positive**
- Mechanical state is correct by construction. The model can hallucinate narrative; it cannot hallucinate HP.
- All changes to the world are **logged**, **typed**, and **replayable**. The audit log answers "why did the rogue die in Session 7?" with a full causal chain.
- Dice are actually random. The fudge tool exists as a deliberate, logged, narrowly-permitted exception (per the behavior spec §5.4). Outside that, the model has no path to influence outcomes.
- Tool-use traces are observable in tools like Langfuse / Braintrust, making debugging tractable.

**Negative**
- More tool definitions to maintain. ~30 tools at MVP, growing as new rule systems load.
- Latency. Each tool call is a round-trip; combat turns may chain 3–5 calls. Mitigation: parallel tool calls where possible (Anthropic's API supports this).
- The model has to learn to reach for tools, not narrate around them. This is a real prompt-engineering and eval problem, especially when models drift toward "shortcut" narration under load.

**Neutral**
- This is the same pattern that production agent systems converge on (assistant-tools, function-calling). We're applying it strictly rather than loosely.

## Implied design rules
- Tool definitions live in `/ruleset/{system}/tools.ts` and are loaded into the LLM context per active ruleset.
- Every tool call is logged with: caller, args, result, latency, session/turn ID.
- Tests for tools are deterministic and run in CI separately from LLM evals.
- The model **never** sees raw warm-state JSON in context; it sees a structured natural-language summary built by the orchestrator from the DB. Reads also go through a thin retrieval layer, not direct DB access — this keeps the model's view of state consistent and auditable.
