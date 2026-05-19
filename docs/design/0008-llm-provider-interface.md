# Design Doc 0008: LLM Provider Interface (Phase 1.5)

> Status: Accepted
> Author: maintainers
> Date: 2026-05-19
> Related ADRs: [ADR-0003 (tool-call-only mutation)](../adr/0003-tool-call-only-state-mutation.md), [ADR-0004 (plugin interface pattern)](../adr/0004-plugin-interface-pattern.md), [ADR-0009 (telemetry opt-in)](../adr/0009-telemetry-opt-in.md), [ADR-0012 (Ruleset drop)](../adr/0012-drop-ruleset-plugin-interface.md), [ADR-0013 (warm-tier post-Foundry)](../adr/0013-warm-tier-after-foundry-source-of-truth.md)
> Related design docs: [0001 (telemetry library)](./0001-telemetry-library.md), [0004 (eval harness)](./0004-eval-harness.md), [0006 (tool registry)](./0006-tool-registry.md), [0007 (Foundry-as-source-of-truth)](./0007-foundry-as-source-of-truth.md)

## Context

Per ADR-0004 (with the `Ruleset` portion superseded by [ADR-0012](../adr/0012-drop-ruleset-plugin-interface.md)), `LLMProvider` is one of three remaining plugin interfaces. Phase 1.5 lands the interface plus its first implementation, `AnthropicProvider`. This doc captures the design of both.

The orchestrator runs a per-turn loop: assemble hot context (per [ADR-0013](../adr/0013-warm-tier-after-foundry-source-of-truth.md)), call the LLM with the assembled prompt and the available tool set (per [design doc 0006](./0006-tool-registry.md)), dispatch any tool calls the model emits (auditing each one per [ADR-0003](../adr/0003-tool-call-only-state-mutation.md)), feed results back, and repeat until the model produces a final narration. The interface must support this loop without leaking provider-specific concepts into orchestrator code.

Three forces shape the interface:

1. **Streaming-first.** AI DM narration is long-form (multiple paragraphs per turn) and player UX wants TTS to start before the LLM finishes. Synchronous round-trip APIs are wrong; streaming is the default.
2. **Tool use is first-class.** Per ADR-0003 the model mutates nothing directly — it always emits tool calls. The interface must model tool-use messages and tool-result messages as native concepts, not text-encoded JSON.
3. **Provider-neutral, but Anthropic-shaped where it matters.** Anthropic's Messages API has the most expressive primitives in 2026 (tool use, thinking, extended caching, server-side compaction, task budgets). Other providers (OpenAI, Grok, Gemini) implement subsets. We use the Anthropic shape as our internal lingua franca and have non-Anthropic implementations down-convert.

## Decision

### Interface shape

```ts
// orchestrator/src/interfaces/llm.ts

export type ModelTier = "narration" | "orchestration";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LLMToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. The orchestrator converts its
   *  Zod `ToolDefinition`s to this shape once per session. */
  inputSchemaJson: Record<string, unknown>;
}

export interface LLMTextContent { type: "text"; text: string; }
export interface LLMToolUseContent { type: "tool_use"; id: string; name: string; input: unknown; }
export interface LLMToolResultContent {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}
/** Opaque compaction block returned by the provider on a prior turn.
 *  Treated as a black box and round-tripped verbatim. See "Compaction" below. */
export interface LLMCompactionContent { type: "compaction"; opaque: unknown; }

export type LLMContent =
  | LLMTextContent
  | LLMToolUseContent
  | LLMToolResultContent
  | LLMCompactionContent;

export interface LLMMessage {
  role: "user" | "assistant";
  content: ReadonlyArray<LLMContent>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface LLMRequest {
  systemPrompt: string;
  messages: ReadonlyArray<LLMMessage>;
  tools: ReadonlyArray<LLMToolSpec>;
  modelTier: ModelTier;
  effort?: Effort;
  /** Max tokens the model may emit in this response. Provider-enforced
   *  ceiling that the model is NOT aware of. */
  maxTokens?: number;
  /** Opus-4.7+ only: a soft budget the model *is* aware of and
   *  self-moderates against across an agentic loop. Minimum 20_000. */
  taskBudgetTokens?: number;
  /** Defaults to true. When true, the provider applies prompt caching
   *  to the system prompt + tool list (the stable prefix). */
  cacheSystemPrompt?: boolean;
}

export interface LLMOptions {
  signal?: AbortSignal;
  /** Called when usage is known (typically once, near the `done` event). */
  onUsage?: (usage: TokenUsage) => void;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "compacted"
  | "refusal";

export type LLMErrorKind =
  | "rate_limited"
  | "overloaded"
  | "invalid_request"
  | "auth"
  | "network"
  | "cancelled"
  | "unknown";

export interface LLMErrorInfo {
  kind: LLMErrorKind;
  message: string;
  retryAfterMs?: number;
}

export type LLMEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "compaction"; block: LLMCompactionContent }
  | { kind: "done"; stopReason: StopReason; usage: TokenUsage }
  | { kind: "error"; error: LLMErrorInfo };

export interface LLMProvider {
  readonly name: string;
  complete(req: LLMRequest, opts?: LLMOptions): AsyncIterable<LLMEvent>;
}
```

### Streaming-first

`complete()` returns `AsyncIterable<LLMEvent>`. Consumers iterate the stream and react event-by-event (TTS starts on the first `text_delta`; tool dispatch starts on the first `tool_call`). A `done` event terminates the stream. An `error` event also terminates, with structured failure info.

Callers who want a non-streaming result accumulate the events into a final message themselves — the abstraction does not provide a `complete()`-returns-`Promise<Result>` variant. This keeps the interface minimal; sync sugar can be added later in `orchestrator/src/run_turn.ts` if needed.

### Model tier abstraction

The interface accepts `modelTier: "narration" | "orchestration"`, not raw model IDs. The orchestrator never names a model directly. Per-provider configuration maps tiers to model IDs:

- `AnthropicProvider`: `narration` → `claude-opus-4-7`, `orchestration` → `claude-haiku-4-5`. Overridable per provider config; environment variables `ANTHROPIC_MODEL_NARRATION` / `ANTHROPIC_MODEL_ORCHESTRATION` provide a no-recompile escape hatch for operators.
- Future providers map their own equivalents.

Rationale: the model-name landscape changes constantly. Locking orchestrator code to specific IDs creates a tight coupling that breaks every time a provider releases a new model. Tier-based dispatch lets the orchestrator say *"use the strong model for narration, the cheap model for orchestration meta-decisions"* and lets each provider answer that in its own terms.

### Effort and thinking

`effort` maps to Anthropic's `output_config.effort` parameter (GA, no beta header). The parameter is accepted on Opus 4.5+ and Sonnet 4.6 but **rejected on Haiku 4.5 / Sonnet 4.5** with a 400 *"this model does not support the effort parameter."* `AnthropicProvider`:

- On `narration` tier (Opus 4.7 by default): sets `effort: "xhigh"` — the documented sweet spot for agentic work that needs intelligence but not max cost.
- On `orchestration` tier (Haiku 4.5 by default): **omits `output_config` entirely** to avoid the 400. The Haiku tier accepts the caller's `effort` only if the operator has overridden the default model to one that supports it.
- A custom narration model like `claude-opus-4-5` also gets the configured effort.

Adaptive thinking is enabled on the same set of models that accept `effort` (Opus 4.5+, Sonnet 4.6) via `thinking: { type: "adaptive", display: "summarized" }`. Summarized display means thinking blocks stream with summarized content the operator can see in the audit log, without exposing player-facing thinking. Haiku 4.5 does not support thinking; `AnthropicProvider` omits the parameter on that tier.

### Tool use

Tools are passed in the request as `LLMToolSpec[]` — name, description, JSON Schema input. The orchestrator converts its Zod-typed `ToolDefinition`s once per session via a small `toolDefinitionToLlmSpec()` helper that calls `zod-to-json-schema`. The conversion happens at the orchestrator-↔-provider boundary; the orchestrator's own `ToolRegistry` continues to be Zod-typed for runtime validation and TypeScript ergonomics.

When the model emits a tool-use block, the provider emits a `tool_call` event with the tool name and parsed input. The caller dispatches the tool through the existing `ToolDispatcher` (which validates input against the Zod schema as a defense-in-depth check, then runs the handler, then audits the call). The caller then constructs an `LLMMessage` of role `user` whose content array carries one `tool_result` block per dispatched call, and feeds it back into the next `complete()` invocation. This is the standard Anthropic tool-use loop.

### Prompt caching

Per the Claude API skill guidance, prompt caching is a prefix-match optimization: the cache key is everything up to the last `cache_control` breakpoint. The system prompt + tool list are stable across a session; the per-turn dialogue is volatile. The provider applies `cache_control: { type: "ephemeral" }` to the end of the system prompt and the end of the tool list (max 4 breakpoints; we use 2). The 5-minute TTL covers most turns within a session.

`cacheSystemPrompt` defaults to `true`. Set to `false` for one-off requests (e.g., post-session summary generation against a fresh prompt) where caching would be wasted.

### Token usage tracking (per Open Question #1, signed off)

`LLMOptions.onUsage?: (usage: TokenUsage) => void` fires once per `done` event with input/output/cache token counts. The orchestrator uses this for two things:

1. **Audit log entry per turn** — write the token usage into the same `audit_log` row as the LLM call, so a session replay can compute per-turn cost.
2. **Cost-tracking store** (deferred to Phase 4+) — a future local cost dashboard reads from this; design doc 0001 (telemetry library) noted this need.

The `llm.completed` telemetry event also carries bucketed token counts (no exact values; bucketed). See Telemetry section below.

### Compaction support from day 1 (per Open Question #2, signed off)

Anthropic 4.7/4.6 support server-side compaction at the 1M-context boundary (beta header `compact-2026-01-12`). When the model's accumulated context approaches the trigger threshold, Anthropic compresses earlier history into a `compaction` block and returns it in the response. The next request must include that block verbatim in `messages[0].content[]` — Anthropic uses it to restore the compacted history server-side.

The interface models this with `LLMCompactionContent` in the `LLMContent` union and a `compaction` event on the stream. The orchestrator's turn-loop persistence layer stores the compaction block alongside the session's message history; on the next turn it's restored to the request as if it were any other content block.

For Phase 1.5 we don't hit context limits in tests (the eval harness operates on small prompts), but the wire-format support is in place so we don't have to retrofit later.

### Errors

`LLMEvent` includes an `error` variant with structured `LLMErrorInfo`. Anthropic SDK errors map as:

- `429 rate_limit_error` → `rate_limited` with `retryAfterMs` from the `Retry-After` header.
- `529 overloaded_error` → `overloaded`.
- `400 invalid_request_error` → `invalid_request` (likely a bug — message goes to the audit log).
- `401 authentication_error` → `auth`.
- Network failures → `network`.
- `AbortError` from the signal → `cancelled`.
- Anything else → `unknown` with the SDK's message.

No silent retries inside the provider. The orchestrator's turn-loop decides whether to retry rate-limit/overload errors with backoff — that's a policy concern above the provider.

### FakeLLMProvider for tests and the eval harness

Same package as the interface (`orchestrator/src/interfaces/`). A scripted `LLMProvider`:

```ts
export interface FakeScript {
  /** Optional matcher. If absent, this is the catch-all default. */
  match?: (req: LLMRequest) => boolean;
  events: ReadonlyArray<LLMEvent>;
}

export class FakeLLMProvider implements LLMProvider {
  readonly name = "fake";
  constructor(private readonly scripts: ReadonlyArray<FakeScript>) {}
  // ...iterates the first matching script
}
```

Tests construct a `FakeLLMProvider` with one or more scripts; the eval harness (in a follow-up commit) replaces its `MockRunner` placeholder with an `OrchestratorRunner` that takes a `FakeLLMProvider` driven by per-fixture scripts. The real `AnthropicProvider` is exercised against the SDK's mock transport in unit tests and against the live API in an opt-in integration test gated by `ANTHROPIC_API_KEY` (skipped in CI).

## Alternatives considered

- **Vercel AI SDK as the abstraction.** It's a multi-provider TypeScript SDK with similar primitives. Rejected: it pulls in a substantial React/Next.js-flavored runtime we don't need, its tool-use model is OpenAI-shaped (less expressive than Anthropic's tool use + thinking + caching), and we'd lose the audit-log integration we get from owning the boundary.
- **LangChain.** Rejected as the orchestration framework long ago (orchestrator is hand-written). Adding it just for the LLM-provider abstraction is taking on the whole ecosystem for one boundary.
- **No abstraction; orchestrator calls the Anthropic SDK directly.** Rejected — explicitly violates ADR-0004's plugin-interface principle and would block future providers. The cost of the abstraction is one TypeScript file with ~80 LOC of types.
- **OpenAI-shaped lingua franca instead of Anthropic-shaped.** Rejected: OpenAI's tool-use protocol has lower expressiveness (no thinking, weaker caching primitives, no compaction). Building toward the weaker shape would force us to abandon features we want from Anthropic. Adapters from Anthropic-shape down to OpenAI-shape are straightforward; the reverse is information-losing.

## Telemetry implications

One new event registered in `telemetry/src/events.ts`:

```ts
"llm.completed": {
  v: 1,
  description: "An LLM completion finished. Tokens and duration are bucketed; no PII or prompt content.",
  props: {} as {
    providerName: string;          // e.g., "anthropic", "fake"
    modelTier: string;              // "narration" | "orchestration"
    success: boolean;
    stopReason: string;             // mapped from StopReason
    inputTokensBucket: string;      // "<500" | "<2000" | "<10000" | "<50000" | ">=50000"
    outputTokensBucket: string;     // same buckets
    cacheReadTokensBucket: string;  // same buckets
    durationMsBucket: string;       // "<500" | "<2000" | "<10000" | "<30000" | ">=30000"
  },
}
```

No PII, no prompt content, no model name (operators who care can read their own provider's billing dashboard). Per ADR-0009, telemetry routes through the typed wrapper only.

## Privacy implications

- The provider receives the full assembled prompt — system prompt (behavior spec + warm state) + dialogue history + tools. This may include the Discord IDs of players (in dialogue) and quest-flag content. That's a `PII<T>`-adjacent flow, but the data is going to the configured LLM provider (a service the operator has a billing relationship with), not to Skeinkeeper's maintainers. The operator-facing privacy disclosure (`docs/PRIVACY.md`) already covers this: *"the LLM provider receives the assembled prompt for each turn"*.
- The `audit_log` records the request that went out (with prompt content) and the response that came back. This is on the operator's machine, encrypted at rest, and falls under the existing erasure paths (`ErasureService.deleteForPlayer(discordId)` cascades to audit log entries that reference that ID).
- No new consents required — the existing voice-processing consent does not extend to LLM submission, but text submission to the operator's chosen LLM is part of the *gameplay itself* and is inherent to "running Skeinkeeper." This is documented in `docs/PRIVACY.md` and is the right default for self-hosted software.

## Eval implications

Phase 1.5 unblocks the eval harness's real runner. In this commit:

- The `MockRunner` placeholder in `eval/src/runner.ts` (per design doc 0004) stays for now; replacement is a follow-up commit.

In the follow-up commit (also part of Phase 1.5):

- `eval/src/orchestrator_runner.ts` wraps a `FakeLLMProvider` driven by per-fixture scripts. Fixtures gain an `llmScript` field that names a script to load.
- Existing fixtures continue to pass; new fixtures can assert on tool calls + final text.

Real-API eval runs (against a live Anthropic key) are out of scope for Phase 1.5 — they require a wired behavior spec (Phase 1.6) and meaningful prompt context. A single smoke-test integration test in `plugins/llm-anthropic/` is the only live-API check in this phase.

## Open questions

- **Retry policy.** Should the orchestrator's turn loop retry `rate_limited` and `overloaded` errors automatically, or surface them to the operator immediately? Defer: implement in Phase 2 alongside the real turn loop; the provider just reports.
- **Streaming chunk size.** Anthropic streams character-level deltas; for TTS we may want to buffer to sentence boundaries before handing off to ElevenLabs to avoid choppy speech. That's a Voice/TTS-side concern, not the LLM provider's. Defer to Phase 2.
- **Multiple Anthropic SDK clients.** Today, one provider config → one `client` object. If future per-campaign API-key isolation is needed (one operator running campaigns for multiple groups with separate billing), we'd add a `clientFor(tenantId)` step. Out of scope for alpha; revisit when multi-tenant becomes a real ask.
- **Whether to keep `LLMCompactionContent` as a public content type.** It's opaque to everyone except the provider. Could be a private impl detail of `AnthropicProvider`. Decision: keep it public, because the orchestrator's persistence layer needs to recognize compaction blocks for round-tripping (it needs to know "this is a block; preserve it verbatim and put it at index 0 next turn").
