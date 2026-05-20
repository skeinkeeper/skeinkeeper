// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { fakeLlmFromEvents, FakeLLMProvider } from "../interfaces/fake_llm_provider.js";
import type { TokenUsage } from "../interfaces/llm.js";
import type { DialogueTurn } from "../hot_context.js";
import { generateEpisodicSummary, EpisodicSummaryError } from "./summarize.js";

const USAGE: TokenUsage = { inputTokens: 20, outputTokens: 10 };
const DIALOGUE: DialogueTurn[] = [
  { speaker: "discord:1", displayName: "Alice", text: "I spare the goblin Yeemik.", timestamp: 1 },
  { speaker: "narrator", text: "Yeemik flees into the dark, owing you a debt.", timestamp: 2 },
];

function llm(json: string): FakeLLMProvider {
  return fakeLlmFromEvents([
    { kind: "text_delta", text: json },
    { kind: "done", stopReason: "end_turn", usage: USAGE },
  ]);
}

describe("generateEpisodicSummary", () => {
  it("parses prose + structured deltas", async () => {
    const provider = llm(
      '{"summary": "The party spared Yeemik.", "deltas": {"npcs": {"yeemik": "spared, owes a debt"}}}',
    );
    const out = await generateEpisodicSummary(provider, DIALOGUE);
    expect(out.text).toBe("The party spared Yeemik.");
    expect(out.deltas).toEqual({ npcs: { yeemik: "spared, owes a debt" } });
    expect(provider.receivedRequests[0]!.modelTier).toBe("orchestration");
  });

  it("defaults deltas to {} when omitted", async () => {
    const out = await generateEpisodicSummary(llm('{"summary": "A quiet session."}'), DIALOGUE);
    expect(out.deltas).toEqual({});
  });

  it("throws on empty dialogue", async () => {
    await expect(generateEpisodicSummary(llm("{}"), [])).rejects.toBeInstanceOf(EpisodicSummaryError);
  });

  it("throws when the model returns no usable summary", async () => {
    await expect(generateEpisodicSummary(llm("no json here"), DIALOGUE)).rejects.toBeInstanceOf(
      EpisodicSummaryError,
    );
  });
});
