// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { fakeLlmFromEvents } from "../interfaces/index.js";
import { preplanIntent, shouldPreplan } from "./anticipation.js";

describe("shouldPreplan (design doc 0028 §P3)", () => {
  it("waits until the partial has enough words", () => {
    expect(shouldPreplan("I draw my")).toBe(false); // 3 words
    expect(shouldPreplan("I draw my sword and lunge")).toBe(true); // 6 words
  });

  it("respects a custom minWords", () => {
    expect(shouldPreplan("I open the door", { minWords: 3 })).toBe(true);
    expect(shouldPreplan("I open the door", { minWords: 8 })).toBe(false);
  });

  it("holds off when the partial trails off mid-thought (hyphen or ellipsis)", () => {
    expect(shouldPreplan("I want to sneak past the guard and—")).toBe(false);
    expect(shouldPreplan("I want to sneak past the guard and...")).toBe(false);
    // A settled clause with enough words is fine.
    expect(shouldPreplan("I want to sneak past the guard quietly")).toBe(true);
  });
});

describe("preplanIntent (design doc 0028 §P3)", () => {
  it("returns the model's one-line opening hint on the cheap tier", async () => {
    const llm = fakeLlmFromEvents([
      { kind: "text_delta", text: "The cultist's back is turned, candlelight wavering." },
      { kind: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const hint = await preplanIntent(llm, { partialTranscript: "I sneak up behind the" });
    expect(hint).toBe("The cultist's back is turned, candlelight wavering.");
    expect(llm.receivedRequests[0]?.modelTier).toBe("orchestration");
  });

  it("returns '' (never throws) on a model error", async () => {
    const llm = fakeLlmFromEvents([
      { kind: "error", error: { kind: "rate_limited", message: "slow down" } },
    ]);
    expect(
      await preplanIntent(llm, { partialTranscript: "I look around the room carefully" }),
    ).toBe("");
  });
});
