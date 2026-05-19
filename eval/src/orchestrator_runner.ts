// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { LLMProvider, LLMRequest } from "@skeinkeeper/orchestrator";
import type { Fixture, Turn } from "./fixture.js";
import type { Runner, RunnerInput, RunnerOutput, ToolCallRecord } from "./runner.js";

/**
 * Eval-harness runner that drives an injected LLMProvider. In CI runs that
 * provider is a `FakeLLMProvider` scripted by the fixture's `llm_script`;
 * future Phase 1.6+ behavior fixtures will optionally run against the real
 * AnthropicProvider via a separate `pnpm eval:live` entry point.
 *
 * Per design doc 0008 § "Eval implications" and design doc 0004 § "Phase 1.5
 * swaps MockRunner for an OrchestratorRunner."
 */
export class OrchestratorRunner implements Runner {
  readonly name = "orchestrator";

  constructor(private readonly llm: LLMProvider) {}

  async run({ fixture }: RunnerInput): Promise<RunnerOutput> {
    const req: LLMRequest = {
      systemPrompt: buildSystemPrompt(fixture),
      messages: buildMessages(fixture.scenario.turns),
      tools: [],
      modelTier: "narration",
    };

    let narration = "";
    const toolCalls: ToolCallRecord[] = [];

    for await (const ev of this.llm.complete(req)) {
      if (ev.kind === "text_delta") {
        narration += ev.text;
      } else if (ev.kind === "tool_call") {
        toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
      } else if (ev.kind === "error") {
        // Leave narration / toolCalls as captured so far. Phase 2's real
        // turn loop will decide retry policy; for evals we just surface
        // what we got.
        break;
      }
    }

    return { narration, toolCalls };
  }
}

function buildSystemPrompt(fixture: Fixture): string {
  // Phase 1.6 will replace this with a real behavior-spec load. Until then
  // the system prompt is a placeholder; FakeLLMProvider ignores it anyway.
  return fixture.behaviorSpecVersion
    ? `[Skeinkeeper behavior spec ${fixture.behaviorSpecVersion}; loader lands in Phase 1.6]`
    : `[Skeinkeeper behavior spec placeholder; loader lands in Phase 1.6]`;
}

function buildMessages(turns: ReadonlyArray<Turn>): LLMRequest["messages"] {
  // For Phase 1.5c we collapse the fixture's scenario turns into a single
  // user message. Multi-turn dialogue with proper user/assistant alternation
  // and hot-context insertion lands in Phase 2's real turn loop.
  const text = turns.map((t) => `[${t.speaker}] ${t.text}`).join("\n");
  return [{ role: "user", content: [{ type: "text", text }] }];
}
