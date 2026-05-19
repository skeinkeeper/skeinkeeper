// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { scriptToEvents, fakeLlmFromScript } from "./llm_script.js";

describe("scriptToEvents", () => {
  it("emits a single text_delta plus a done(end_turn) for a narration-only script", () => {
    const events = scriptToEvents({ narration: "You stand at the village edge." });
    expect(events.map((e) => e.kind)).toEqual(["text_delta", "done"]);
    expect(events[0]).toMatchObject({ kind: "text_delta", text: "You stand at the village edge." });
    expect(events[1]).toMatchObject({ kind: "done", stopReason: "end_turn" });
  });

  it("emits tool_call events in order and infers tool_use stop reason", () => {
    const events = scriptToEvents({
      narration: "I'll need to roll for that.",
      toolCalls: [
        { name: "roll", input: { formula: "1d20+3" } },
        { name: "set_quest_flag", input: { campaignId: "c1", key: "k", value: "v" } },
      ],
    });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["text_delta", "tool_call", "tool_call", "done"]);
    const done = events[3];
    if (done?.kind === "done") expect(done.stopReason).toBe("tool_use");
  });

  it("auto-generates tool_call ids when not provided", () => {
    const events = scriptToEvents({
      toolCalls: [{ name: "roll", input: {} }, { name: "whisper", input: {} }],
    });
    const calls = events.filter((e) => e.kind === "tool_call");
    if (calls[0]?.kind === "tool_call") expect(calls[0].id).toBe("tu_1");
    if (calls[1]?.kind === "tool_call") expect(calls[1].id).toBe("tu_2");
  });

  it("respects an explicit stop_reason override", () => {
    const events = scriptToEvents({ narration: "...", stopReason: "max_tokens" });
    const done = events[events.length - 1];
    if (done?.kind === "done") expect(done.stopReason).toBe("max_tokens");
  });

  it("emits only a done event when narration and tool_calls are both absent", () => {
    const events = scriptToEvents({});
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("done");
  });

  it("fakeLlmFromScript yields the scripted events to the consumer", async () => {
    const provider = fakeLlmFromScript({
      narration: "ok",
      toolCalls: [{ name: "roll", input: { formula: "1d6" } }],
    });
    const seen: string[] = [];
    for await (const ev of provider.complete({
      systemPrompt: "",
      messages: [],
      tools: [],
      modelTier: "narration",
    })) {
      seen.push(ev.kind);
    }
    expect(seen).toEqual(["text_delta", "tool_call", "done"]);
  });
});
