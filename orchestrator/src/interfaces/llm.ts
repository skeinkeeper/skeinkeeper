// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * LLMProvider interface per ADR-0004 (with the Ruleset portion superseded
 * by ADR-0012). The orchestrator interacts with any LLM through this
 * interface; provider-specific concerns (Anthropic SDK quirks, OpenAI's
 * weaker tool-use shape, etc.) stay inside the plugin implementation.
 *
 * See design doc 0008 for the full rationale.
 */

export type ModelTier = "narration" | "orchestration";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LLMToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. The orchestrator converts its
   *  Zod-typed ToolDefinitions to this shape once per session. */
  inputSchemaJson: Record<string, unknown>;
}

export interface LLMTextContent {
  type: "text";
  text: string;
}

export interface LLMToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface LLMToolResultContent {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/**
 * Opaque compaction block returned by the provider on a prior turn.
 * Treated as a black box and round-tripped verbatim on the next request.
 * See design doc 0008 § "Compaction support from day 1."
 */
export interface LLMCompactionContent {
  type: "compaction";
  opaque: unknown;
}

export type AudioMediaType =
  | "audio/wav"
  | "audio/mp3"
  | "audio/mpeg"
  | "audio/ogg"
  | "audio/webm"
  | "audio/flac";

/**
 * Audio content block per design doc 0010. Carries the audio payload
 * plus an optional pre-computed transcript for providers that don't
 * accept audio natively (Claude today). Audio-native providers
 * (OpenAI 4o-realtime, Gemini Live — future plugins) use `source`
 * directly; the AnthropicProvider falls back to `transcript`.
 */
export interface LLMAudioContent {
  type: "audio";
  source:
    | { kind: "base64"; mediaType: AudioMediaType; data: string }
    | { kind: "url"; url: string };
  /** Pre-computed STT transcript. Strongly recommended; required when
   *  the configured provider can't accept audio natively. */
  transcript?: string;
  /** Speaker label from STT (e.g., a Discord username). Helps the LLM
   *  attribute dialogue when the transcript-fallback path is used. */
  speakerName?: string;
}

export type LLMContent =
  | LLMTextContent
  | LLMToolUseContent
  | LLMToolResultContent
  | LLMCompactionContent
  | LLMAudioContent;

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
  /** Provider-enforced ceiling on output tokens. The model is NOT aware
   *  of this value. */
  maxTokens?: number;
  /** Opus-4.7+ only: a soft budget the model IS aware of and self-moderates
   *  against across an agentic loop. Minimum 20_000 per the Anthropic API. */
  taskBudgetTokens?: number;
  /** Defaults to true. When true, the provider applies prompt caching
   *  to the stable prefix (system prompt + tool list). */
  cacheSystemPrompt?: boolean;
}

export interface LLMOptions {
  signal?: AbortSignal;
  /** Called once per completion when usage is known, typically near
   *  the `done` event. The orchestrator wires this to audit-log entries
   *  (and, if a local cost-tracking store is added, into that store). */
  onUsage?: (usage: TokenUsage) => void;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "compacted" | "refusal";

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

/**
 * Bucket a duration in milliseconds for the `llm.completed` telemetry event.
 * Same bucket boundaries as the `tool.called` event for visual consistency.
 */
export function bucketDurationMs(ms: number): string {
  if (ms < 500) return "<500";
  if (ms < 2_000) return "<2000";
  if (ms < 10_000) return "<10000";
  if (ms < 30_000) return "<30000";
  return ">=30000";
}

/**
 * Bucket a token count for the `llm.completed` telemetry event.
 * Coarse buckets — operators who want exact counts read their provider's
 * billing dashboard.
 */
export function bucketTokens(n: number): string {
  if (n < 500) return "<500";
  if (n < 2_000) return "<2000";
  if (n < 10_000) return "<10000";
  if (n < 50_000) return "<50000";
  return ">=50000";
}
