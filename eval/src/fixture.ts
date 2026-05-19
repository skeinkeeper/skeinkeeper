// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { StopReason } from "@skeinkeeper/orchestrator";

export type Speaker = "player" | "operator" | "system";

export interface Turn {
  speaker: Speaker;
  text: string;
}

export type Expectation =
  | { kind: "not_empty"; field: string; description?: string }
  | { kind: "contains"; field: string; text: string; description?: string }
  | { kind: "contains_any_of"; field: string; texts: ReadonlyArray<string>; description?: string }
  | { kind: "not_contains"; field: string; text: string; description?: string }
  | { kind: "regex_match"; field: string; pattern: string; description?: string }
  | { kind: "tool_called"; name: string; description?: string }
  | { kind: "tool_not_called"; name: string; description?: string };

export interface ScriptedToolCall {
  /** Generated automatically if absent. */
  id?: string;
  name: string;
  input: unknown;
}

/**
 * Shorthand for what the fake LLM should emit in response to the scenario.
 * Converted to an LLMEvent stream by the harness; consumed by the
 * OrchestratorRunner via a FakeLLMProvider.
 */
export interface LlmScript {
  /** Single accumulated narration string. Emitted as one `text_delta` event. */
  narration?: string;
  /** Each entry produces one `tool_call` event before the `done` event. */
  toolCalls?: ReadonlyArray<ScriptedToolCall>;
  /** Defaults to "tool_use" if `toolCalls` is non-empty, otherwise "end_turn". */
  stopReason?: StopReason;
}

export interface Scenario {
  state?: Record<string, unknown>;
  turns: ReadonlyArray<Turn>;
}

export interface Fixture {
  /** Source file path, populated by the loader. */
  path: string;
  name: string;
  description?: string;
  behaviorSpecVersion?: string;
  /** Non-empty string => skip with this reason. */
  skip?: string;
  scenario: Scenario;
  llmScript?: LlmScript;
  expectations: ReadonlyArray<Expectation>;
}
