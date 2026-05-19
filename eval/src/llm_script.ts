// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { fakeLlmFromEvents, type FakeLLMProvider, type LLMEvent } from "@skeinkeeper/orchestrator";
import type { LlmScript } from "./fixture.js";

const DEFAULT_USAGE = { inputTokens: 100, outputTokens: 50 };

/**
 * Expand a fixture's shorthand `llm_script` into the LLMEvent stream that
 * a FakeLLMProvider should emit in response. Pure function; testable.
 *
 * Mapping:
 * - `narration` → one `text_delta` with the full string
 * - each `toolCalls` entry → one `tool_call` event
 * - `stopReason` (or inferred default) → one `done` event with stub usage
 */
export function scriptToEvents(script: LlmScript): LLMEvent[] {
  const events: LLMEvent[] = [];
  if (script.narration && script.narration.length > 0) {
    events.push({ kind: "text_delta", text: script.narration });
  }
  const toolCalls = script.toolCalls ?? [];
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]!;
    events.push({
      kind: "tool_call",
      id: tc.id ?? `tu_${i + 1}`,
      name: tc.name,
      input: tc.input,
    });
  }
  const stopReason = script.stopReason ?? (toolCalls.length > 0 ? "tool_use" : "end_turn");
  events.push({ kind: "done", stopReason, usage: DEFAULT_USAGE });
  return events;
}

/** Build a FakeLLMProvider whose single script comes from a fixture's `llmScript`. */
export function fakeLlmFromScript(script: LlmScript): FakeLLMProvider {
  return fakeLlmFromEvents(scriptToEvents(script));
}
