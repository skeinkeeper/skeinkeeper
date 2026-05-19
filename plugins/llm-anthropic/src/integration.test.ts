// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Live-API integration test for AnthropicProvider. Gated by
 * ANTHROPIC_API_KEY: skipped in CI, runs locally when the env var is set.
 *
 * Uses Claude Haiku 4.5 (orchestration tier) for low cost — a single
 * round-trip is well under $0.001.
 */

import { describe, expect, it } from "vitest";
import type { LLMEvent } from "@skeinkeeper/orchestrator";
import { AnthropicProvider } from "./anthropic_provider.js";

const apiKey = process.env["ANTHROPIC_API_KEY"];
const suite = apiKey ? describe : describe.skip;

suite("AnthropicProvider (live API)", () => {
  it("completes a small request against Haiku and returns text + usage", async () => {
    const provider = new AnthropicProvider({ apiKey: apiKey! });

    const events: LLMEvent[] = [];
    for await (const ev of provider.complete({
      systemPrompt:
        "You are a test echo bot. Respond with exactly the single word: PONG (no punctuation).",
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      tools: [],
      modelTier: "orchestration",
      maxTokens: 50,
    })) {
      events.push(ev);
    }

    const errorEvent = events.find((e) => e.kind === "error");
    if (errorEvent?.kind === "error") {
      throw new Error(
        `Live API call returned an error: ${errorEvent.error.kind} — ${errorEvent.error.message}`,
      );
    }

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.stopReason).toBe("end_turn");
      expect(done.usage.inputTokens).toBeGreaterThan(0);
      expect(done.usage.outputTokens).toBeGreaterThan(0);
    }

    const text = events
      .filter((e): e is { kind: "text_delta"; text: string } => e.kind === "text_delta")
      .map((e) => e.text)
      .join("");
    expect(text.toUpperCase()).toContain("PONG");
  }, 30_000);
});
