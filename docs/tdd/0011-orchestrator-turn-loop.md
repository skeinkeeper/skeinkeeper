# TDD 0011: Orchestrator Turn Loop (Phase 2a)
Status: implemented
PRD refs: 4.3, 5.3
PRD-rev: 10391ba
ADR constraints: 0002, 0003, 0008, 0013
Author: maintainers
Date: 2026-05-19
Related TDDs: [0006 (tool registry)](./0006-tool-registry.md), [0007 (Foundry-as-source-of-truth)](./0007-foundry-as-source-of-truth.md), [0008 (LLM provider interface)](./0008-llm-provider-interface.md), [0009 (behavior spec loader)](./0009-behavior-spec-loader.md), [0010 (audio-extensible interface)](./0010-audio-extensible-llm-interface.md)

## Approach

Phase 1 shipped each ingredient of an AI-DM turn in isolation: behavior spec loader (1.6), LLMProvider interface + AnthropicProvider (1.5b), tool registry + dispatcher (1.2), Zod→JSON Schema converter (1.5b), hot context assembler (1.3), warm state assembler reading Foundry + TenantDb (1.4 + 1.5c), audit log (1.1), telemetry library (0.1). Each is tested in isolation.

Phase 2a is the integration: a `runTurn(input)` function that pulls every ingredient into a single coherent loop and produces a session's narration + side-effects. Until this lands, the orchestrator package is a library of unconnected primitives. After this lands, it's an actual AI DM that operates a campaign — minus voice (Phase 2b) and live Foundry (Phase 3).

## Components & interfaces

### Two new orchestrator-level types: `Session` and `runTurn`

```ts
// orchestrator/src/session.ts

export interface SessionConfig {
  /** Identifies this orchestration; used in audit-log rows. */
  sessionId: string;
  /** The campaign this session is for. Determines warm-state scope and
   *  the behavior_spec_version it expects. */
  campaignId: string;
  /** Loaded once at session start; cached for every turn. */
  behaviorSpec: BehaviorSpec;
  /** LLM provider for this session. AnthropicProvider in production;
   *  FakeLLMProvider in tests and the eval harness. */
  llm: LLMProvider;
  /** Tool dispatcher; the orchestrator hands it the model's tool_call
   *  blocks and gets back results. */
  dispatcher: ToolDispatcher;
  /** Where mechanical state comes from. MockFoundryClient in tests;
   *  McpFoundryClient (Phase 3) in production. */
  foundry: FoundryClient;
  /** Tenant-scoped DB accessor for AI-DM-internal state (quest flags,
   *  audit log, etc.). */
  tenantDb: TenantDb;
  /** Optional analytics client for `session.*` and `llm.*` events. */
  analytics?: AnalyticsClient;
  /** Defaults to 10. Bound on the tool-dispatch iteration cap so a model
   *  in a tool-call loop doesn't run forever. */
  maxToolIterations?: number;
  /** Defaults to 20. Sliding-window size for the hot context's dialogue. */
  dialogueWindowSize?: number;
}

export class Session {
  /** Constructed once and shared across all turns in this session. */
  constructor(readonly config: SessionConfig);

  /** Mutable: appended to on each turn. Phase 2a keeps it in-memory; a
   *  later phase persists it via TenantDb when restart-resilience matters. */
  readonly dialogue: DialogueTurn[];
}

/** Run a single player turn through the AI DM. Idempotent per-call;
 *  side effects (tool dispatches, audit-log writes, dialogue appends)
 *  happen atomically per turn. */
export async function runTurn(
  session: Session,
  input: TurnInput,
): Promise<TurnOutput>;

export interface TurnInput {
  speaker: string;       // Discord user ID or "operator"
  displayName?: string;
  text: string;
}

export interface TurnOutput {
  /** Final narration the player(s) hear/read. Aggregated across all
   *  iterations of the tool-call loop. */
  narration: string;
  /** Tool calls the model emitted (and the dispatcher ran), in order.
   *  Useful for evals and the operator-side UI. */
  toolCalls: ReadonlyArray<{ id: string; name: string; input: unknown; output: unknown; ok: boolean }>;
  /** Resolved end-of-turn warm-state snapshot — what the LLM saw on
   *  the *last* iteration. Phase 5's UI shows this; Phase 2c uses it
   *  for state-diff highlights. */
  warmStateAfter: WarmStateSnapshot;
  /** Why the turn terminated (end_turn / refusal / max_tool_iterations /
   *  llm_error). */
  stopReason: TurnStopReason;
}

export type TurnStopReason = "end_turn" | "max_tool_iterations" | "refusal" | "llm_error";
```

### The turn loop

The hard part. Pseudocode:

```
runTurn(session, input):
  append input to session.dialogue
  warmState = buildWarmStateSnapshot(session.foundry, session.tenantDb, session.config.campaignId)
  hotContext = assembleHotContext(warmState, session.dialogue, { windowSize: dialogueWindowSize })

  systemPrompt = session.config.behaviorSpec.content + "\n\n" + formatHotContextAsText(hotContext)

  toolSpecs = registry.list().map(toolDefinitionToLlmSpec)

  // The model's response across iterations of the tool-call loop
  messages = [{ role: "user", content: [{ type: "text", text: formatTurnAsUserMessage(input) }] }]

  narration = ""
  toolCalls = []
  iter = 0
  while iter < maxToolIterations:
    iter += 1
    req = { systemPrompt, messages, tools: toolSpecs, modelTier: "narration" }

    iterationToolCalls = []
    pendingResults = []

    for await ev of session.llm.complete(req):
      if ev.kind == "text_delta": narration += ev.text
      elif ev.kind == "tool_call": iterationToolCalls.push(ev)
      elif ev.kind == "done":
        stopReason = ev.stopReason
      elif ev.kind == "error":
        return { narration, toolCalls, warmStateAfter: warmState, stopReason: "llm_error" }

    if iterationToolCalls.length == 0:
      // No tool calls this iteration → model is done. End loop.
      return { narration, toolCalls, warmStateAfter, stopReason: "end_turn" }

    // Dispatch all tool_calls from this iteration in order
    assistantContent = []
    if narration.length > 0:
      assistantContent.push({ type: "text", text: narration since last iteration })
    for tc of iterationToolCalls:
      assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input })
    messages.append({ role: "assistant", content: assistantContent })

    toolResultContent = []
    for tc of iterationToolCalls:
      result = await session.dispatcher.dispatch(
        { name: tc.name, input: tc.input },
        { tenantDb, sessionId, turnId: `${sessionId}-${iter}`, caller: "llm" }
      )
      toolCalls.push({ id: tc.id, name: tc.name, input: tc.input, output: result.ok ? result.output : { error: result.error }, ok: result.ok })
      toolResultContent.push({
        type: "tool_result",
        toolUseId: tc.id,
        content: result.ok ? JSON.stringify(result.output) : JSON.stringify({ error: result.kind, message: result.error }),
        isError: !result.ok,
      })
    messages.append({ role: "user", content: toolResultContent })

    // Refresh warm state — tools may have mutated it
    warmState = buildWarmStateSnapshot(...)
    hotContext = assembleHotContext(warmState, session.dialogue + currentTurn, ...)
    systemPrompt = recomputed with new hot context

  // Loop exhausted the iteration cap
  return { narration, toolCalls, warmStateAfter, stopReason: "max_tool_iterations" }
```

A few design decisions baked in:

1. **System prompt regeneration per iteration.** Tools mutate warm state; the hot context inside the system prompt reflects the new state on the next iteration. Cost: extra prompt-cache invalidations. Benefit: the model never sees stale state mid-turn.
2. **Tool dispatch is fully serial within an iteration.** If the model emits three tool calls, we dispatch them in order, attach all three results in one user message, then ask the model to continue. This matches Anthropic's documented pattern.
3. **The `caller: "llm"` flag on every dispatch.** Operator-gated tools (like `fudge_roll`) reject when invoked here unless the orchestrator has flipped the per-session fudge gate. The fudge gate UI lands in Phase 5; the runtime check is in place from this commit.
4. **Errors from the LLM provider terminate the turn with `stopReason: "llm_error"`.** No retries here. Phase 2b+ may layer a retry-on-rate-limit policy outside `runTurn`.
5. **`max_tool_iterations` defaults to 10.** A reasonable guard against pathological behavior. Operators can raise it for complex multi-tool turns (e.g., a model deciding to roll perception, advance time, set a quest flag, and narrate — that's only 3 iterations).

### Audit log

Per [ADR-0003](../adr/0003-tool-call-only-state-mutation.md), every state mutation goes through a tool call and the dispatcher already writes an `audit_log` row per call. `runTurn` adds two more audit-log rows per turn:

1. **Turn start**: actor `"orchestrator:run_turn"`, eventType `"turn_started"`, payload `{ speaker, displayName, textHash }`. The `textHash` is a short hash of the player's input — useful for replay correlation without storing the full text twice (it's already in the dialogue history).
2. **Turn end**: actor `"orchestrator:run_turn"`, eventType `"turn_completed"`, payload `{ stopReason, iterations, toolCallCount, durationMsBucket }`.

These let an operator reconstruct what happened in a turn by reading the audit log alone (without needing the dialogue history).

### Telemetry

`runTurn` emits the existing `session.started` (once per Session construction) and `session.ended` (when the operator-level `Session.close()` is called — out of scope for Phase 2a; deferred to 2c). It does not emit a new `turn.completed` event yet — `llm.completed` already fires once per LLM call inside the turn, and `tool.called` fires once per dispatch. Adding `turn.completed` is cheap but premature without knowing what slice of data is actually useful; defer.

### What `runTurn` does NOT do (yet)

- **Dialogue persistence.** Phase 2a keeps `Session.dialogue` in memory. A crash mid-session means the dialogue is gone (the audit log preserves enough to reconstruct, but not automatically). Phase 2c persists via `TenantDb`.
- **Streaming output back to the caller.** `runTurn` returns the final aggregated narration as a `Promise<TurnOutput>`. Phase 2b's voice IO will want a streaming variant (`runTurnStreaming`) that yields text fragments to the TTS layer as they arrive from the LLM. Add then; don't speculate now.
- **Session resumption / restart resilience.** Phase 2c.
- **Behavior-spec section retrieval.** §0 of the spec mentions sections are "also embedded for retrieval; relevant guidance is pulled into hot context." Phase 4+ (cold tier).

## Data & state

Covered under Approach.

## Sequencing / implementation plan

Covered under Approach.

## Failure modes & edge cases

- **LLM error mid-turn:** terminates immediately with `stopReason: "llm_error"`; no retries at this layer.
- **Max tool iterations reached:** returns `stopReason: "max_tool_iterations"` with narration and tool calls accumulated so far.
- **Tool dispatch failure:** result recorded with `ok: false`; the tool-result message carries the error JSON; the model continues the loop and decides how to respond.
- **Mid-turn LLM failure after partial tool dispatch:** operator sees partial state via the audit log; Phase 5's session inspector will make this inspectable and overridable. See also Open questions.

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
|---------|-------------|--------------|
| 4.3 | AI DM engine — orchestrates rolls, narration, tool calls, warm-state reads | `runTurn` wires behavior spec + hot context + LLMProvider + ToolDispatcher into the single turn loop |
| 4.3 | Tool calls are the only way the world changes (ADR-0003) | all state mutations go through `session.dispatcher.dispatch`; `caller: "llm"` flag gating enforced per call |
| 4.3 | Audit everything — operator can answer "why did the AI do that?" | `runTurn` writes `turn_started` / `turn_completed` audit rows; dispatcher already writes per-tool rows |
| 5.3 | Performance — voice round-trip target; streamed TTS; tool-call latency ≤ 500ms | turn loop is async; warm-state refresh per iteration is the primary latency driver; `runTurnStreaming` variant deferred to Phase 2b when latency matters |

## Dependencies considered

None — no new third-party dependency introduced by this design.

## PRD conflicts surfaced (and resolution)

None — this design integrates ADR-0002 (four-tier memory), ADR-0003 (tool-call-only mutation), ADR-0008 (tenant scoping), and ADR-0013 (warm-tier post-Foundry). No PRD requirement proved infeasible or contradictory.

## Decisions to promote (ADR candidates)

None — the durable architectural decisions are already captured: tool-call-only mutation (ADR-0003), four-tier memory (ADR-0002), tenant scoping (ADR-0008), plugin interfaces (ADR-0004).

## Alternatives considered

- **Make `runTurn` a generator that yields `TurnEvent`s** (text deltas, tool calls, etc.) instead of returning a flat `Promise<TurnOutput>`. Tempting for the voice IO use case. Rejected for Phase 2a: the eval harness doesn't need streaming; a flat result is simpler to test. The streaming variant lands in 2b alongside the voice IO that actually needs it.
- **Bypass the LLMProvider abstraction and call `client.messages.stream` directly.** Rejected — the whole point of [ADR-0004](../adr/0004-plugin-interface-pattern.md) is provider-swappability.
- **Recompute hot context only at turn start, not per iteration.** Cheaper (fewer prompt-cache misses) but mid-turn tool mutations don't reflect in the model's worldview until the next turn. Decided: refresh per iteration. Tool calls *are* the reason to loop; ignoring their effects defeats the purpose.
- **Limit total wall time per turn instead of iteration count.** Less predictable cap; harder to test. Iteration count is simpler. Phase 2b adds a soft wall-time cap when latency starts to matter for the voice UX.

## Telemetry implications

No new events. `session.started`, `session.ended`, `tool.called`, `llm.completed`, `behavior_spec.loaded`, `error.captured` all already cover what fires inside `runTurn`. If post-deployment data argues for a `turn.completed` event (e.g., "we want bucketed turn durations correlated with toolCallCount"), we add it then.

## Privacy implications

No new data paths. The behavior spec content goes to the LLM provider (same as Phase 1.6). Player input text goes to the LLM (same as any prompt-shaped data, per `docs/PRIVACY.md`). The audit log gains turn-level entries which contain a player-text *hash*, not the full text — small but worth calling out. The full text lives in `Session.dialogue` and (Phase 2c) in a persistent dialogue table; both are tenant-scoped and erasable.

## Eval implications

- Phase 2a's `runTurn` is unit-tested directly in `orchestrator/src/session.test.ts` using real `TenantDb` + `MockFoundryClient` + `FakeLLMProvider` + `ToolDispatcher`. 11 tests cover the single-iteration text path, multi-iteration tool dispatch (single and parallel tool_calls), tool-failure feedback, LLM-error early termination, max-iteration cap, and audit-log shape. This gives runTurn comprehensive coverage without depending on the eval harness.
- **The eval harness's `OrchestratorRunner` migration is deferred to a follow-up phase.** Migrating it cleanly requires either (a) extending the fixture `llm_script` schema to declare per-iteration scripts (so `001-tool-call-smoke.eval.yaml`'s tool calls have something to do on iteration 2), or (b) accepting that fixtures with tool calls become multi-iteration scripts. Either way, that's its own bounded scope and shouldn't block landing the turn loop itself. Until then, the existing OrchestratorRunner continues to handle single-iteration fixtures and the runTurn-driven coverage lives in the session unit tests.

## Open questions

- **Should the orchestrator hash-and-store player text in the audit log, or store the raw text?** This doc says hash, because the full text already lives in `Session.dialogue` (and eventually in a persistent dialogue store). But there's a redundancy argument: storing the raw text in the audit log means a single source can answer "what was said in this turn" without needing the dialogue store too. Defer; consistent with "audit log is structured events" per `CLAUDE.md`.
- **Mid-turn LLM failure recovery.** If a turn fails after dispatching two tool calls (state already mutated) and a third tool call is pending, what's the right `stopReason`? Today: `llm_error`, the operator sees the partial state, can override. Better long-term: the operator UI's session inspector (Phase 5) makes this kind of partial-state visible and overridable.
- **Token-budget tracking per turn vs per session.** `LLMRequest.taskBudgetTokens` is per-completion; a per-*session* budget that bounds total cost across many turns is a separate concept. Out of scope for 2a.
