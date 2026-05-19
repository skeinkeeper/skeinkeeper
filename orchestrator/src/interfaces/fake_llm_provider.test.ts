// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it, vi } from "vitest";
import {
  FakeLLMProvider,
  fakeLlmFromEvents,
  type FakeScript,
} from "./fake_llm_provider.js";
import type { LLMEvent, LLMRequest, TokenUsage } from "./llm.js";

function makeReq(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    systemPrompt: "you are an AI DM",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    modelTier: "narration",
    ...overrides,
  };
}

const SIMPLE_USAGE: TokenUsage = { inputTokens: 100, outputTokens: 50 };

const HELLO_THEN_DONE: LLMEvent[] = [
  { kind: "text_delta", text: "Hello, " },
  { kind: "text_delta", text: "adventurer." },
  { kind: "done", stopReason: "end_turn", usage: SIMPLE_USAGE },
];

describe("FakeLLMProvider", () => {
  it("rejects construction with zero scripts", () => {
    expect(() => new FakeLLMProvider([])).toThrow(/at least one/);
  });

  it("emits the scripted events for a default (no-matcher) script", async () => {
    const fake = fakeLlmFromEvents(HELLO_THEN_DONE);
    const received: LLMEvent[] = [];
    for await (const ev of fake.complete(makeReq())) received.push(ev);
    expect(received).toEqual(HELLO_THEN_DONE);
  });

  it("calls onUsage exactly once with the final usage payload", async () => {
    const onUsage = vi.fn();
    const fake = fakeLlmFromEvents(HELLO_THEN_DONE);
    for await (const _ of fake.complete(makeReq(), { onUsage })) {
      void _;
    }
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(SIMPLE_USAGE);
  });

  it("stops emitting after `done` even if the script has more events after it", async () => {
    const fake = fakeLlmFromEvents([
      { kind: "text_delta", text: "first" },
      { kind: "done", stopReason: "end_turn", usage: SIMPLE_USAGE },
      // Should never be emitted:
      { kind: "text_delta", text: "after-done" },
    ]);
    const received: LLMEvent[] = [];
    for await (const ev of fake.complete(makeReq())) received.push(ev);
    expect(received).toHaveLength(2);
    expect(received[received.length - 1]?.kind).toBe("done");
  });

  it("stops emitting after `error`", async () => {
    const fake = fakeLlmFromEvents([
      { kind: "text_delta", text: "first" },
      { kind: "error", error: { kind: "overloaded", message: "boom" } },
      { kind: "text_delta", text: "should-not-appear" },
    ]);
    const received: LLMEvent[] = [];
    for await (const ev of fake.complete(makeReq())) received.push(ev);
    expect(received).toHaveLength(2);
    expect(received[1]?.kind).toBe("error");
  });

  it("aborts mid-stream when the signal fires, yielding a cancelled error", async () => {
    const ac = new AbortController();
    const fake = fakeLlmFromEvents(HELLO_THEN_DONE);
    const received: LLMEvent[] = [];
    for await (const ev of fake.complete(makeReq(), { signal: ac.signal })) {
      received.push(ev);
      if (received.length === 1) ac.abort();
    }
    const last = received[received.length - 1];
    expect(last?.kind).toBe("error");
    if (last?.kind === "error") expect(last.error.kind).toBe("cancelled");
  });

  it("selects the first matching script when multiple are provided", async () => {
    const scripts: FakeScript[] = [
      {
        match: (r) => r.modelTier === "orchestration",
        events: [
          { kind: "text_delta", text: "orchestration-path" },
          { kind: "done", stopReason: "end_turn", usage: SIMPLE_USAGE },
        ],
      },
      {
        match: (r) => r.modelTier === "narration",
        events: [
          { kind: "text_delta", text: "narration-path" },
          { kind: "done", stopReason: "end_turn", usage: SIMPLE_USAGE },
        ],
      },
      // Catch-all fallback (no match)
      {
        events: [
          { kind: "text_delta", text: "fallback" },
          { kind: "done", stopReason: "end_turn", usage: SIMPLE_USAGE },
        ],
      },
    ];
    const fake = new FakeLLMProvider(scripts);

    const got = async (tier: "narration" | "orchestration") => {
      let text = "";
      for await (const ev of fake.complete(makeReq({ modelTier: tier }))) {
        if (ev.kind === "text_delta") text += ev.text;
      }
      return text;
    };
    expect(await got("narration")).toBe("narration-path");
    expect(await got("orchestration")).toBe("orchestration-path");
  });

  it("yields an invalid_request error when no script matches and no fallback exists", async () => {
    const fake = new FakeLLMProvider([
      {
        match: (r) => r.modelTier === "orchestration",
        events: HELLO_THEN_DONE,
      },
    ]);
    const received: LLMEvent[] = [];
    for await (const ev of fake.complete(makeReq({ modelTier: "narration" }))) {
      received.push(ev);
    }
    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe("error");
    if (received[0]?.kind === "error") {
      expect(received[0].error.kind).toBe("invalid_request");
      expect(received[0].error.message).toMatch(/no matching script/);
    }
  });

  it("supports tool_call and compaction events in the stream", async () => {
    const fake = fakeLlmFromEvents([
      { kind: "thinking_delta", text: "considering the goblin's options" },
      { kind: "tool_call", id: "tu_1", name: "roll", input: { formula: "1d20" } },
      {
        kind: "compaction",
        block: { type: "compaction", opaque: { server: "anthropic", id: "c1" } },
      },
      { kind: "done", stopReason: "tool_use", usage: SIMPLE_USAGE },
    ]);
    const events: LLMEvent[] = [];
    for await (const ev of fake.complete(makeReq())) events.push(ev);
    expect(events.map((e) => e.kind)).toEqual([
      "thinking_delta",
      "tool_call",
      "compaction",
      "done",
    ]);
  });
});
