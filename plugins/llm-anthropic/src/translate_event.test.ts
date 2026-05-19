// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages";
import type { LLMEvent } from "@skeinkeeper/orchestrator";
import { translateStreamEvents } from "./translate_event.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (e: any): BetaRawMessageStreamEvent => e as BetaRawMessageStreamEvent;

async function* iter(...events: BetaRawMessageStreamEvent[]): AsyncIterable<BetaRawMessageStreamEvent> {
  for (const e of events) yield e;
}

async function collect(events: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
  const out: LLMEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("translateStreamEvents", () => {
  it("translates a simple text-only response", async () => {
    const got = await collect(
      translateStreamEvents(
        iter(
          ev({
            type: "message_start",
            message: { usage: { input_tokens: 100, output_tokens: 0 } },
          }),
          ev({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
          ev({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello " },
          }),
          ev({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "world." },
          }),
          ev({ type: "content_block_stop", index: 0 }),
          ev({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 25 },
          }),
          ev({ type: "message_stop" }),
        ),
      ),
    );

    expect(got.map((e) => e.kind)).toEqual([
      "text_delta",
      "text_delta",
      "done",
    ]);
    const done = got.find((e) => e.kind === "done");
    if (done?.kind === "done") {
      expect(done.stopReason).toBe("end_turn");
      expect(done.usage.inputTokens).toBe(100);
      expect(done.usage.outputTokens).toBe(25);
    }
  });

  it("captures cache token counts from message_start", async () => {
    const got = await collect(
      translateStreamEvents(
        iter(
          ev({
            type: "message_start",
            message: {
              usage: {
                input_tokens: 50,
                output_tokens: 0,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 800,
              },
            },
          }),
          ev({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 0 },
          }),
          ev({ type: "message_stop" }),
        ),
      ),
    );
    const done = got[got.length - 1];
    if (done?.kind === "done") {
      expect(done.usage.cacheCreationInputTokens).toBe(100);
      expect(done.usage.cacheReadInputTokens).toBe(800);
    }
  });

  it("accumulates tool_use input_json deltas and emits a single tool_call", async () => {
    const got = await collect(
      translateStreamEvents(
        iter(
          ev({
            type: "message_start",
            message: { usage: { input_tokens: 100, output_tokens: 0 } },
          }),
          ev({
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tu_123", name: "roll", input: {} },
          }),
          ev({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"formula":"' },
          }),
          ev({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '1d20+5"}' },
          }),
          ev({ type: "content_block_stop", index: 0 }),
          ev({
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 30 },
          }),
          ev({ type: "message_stop" }),
        ),
      ),
    );
    const toolCalls = got.filter((e) => e.kind === "tool_call");
    expect(toolCalls).toHaveLength(1);
    if (toolCalls[0]?.kind === "tool_call") {
      expect(toolCalls[0].id).toBe("tu_123");
      expect(toolCalls[0].name).toBe("roll");
      expect(toolCalls[0].input).toEqual({ formula: "1d20+5" });
    }
    const done = got[got.length - 1];
    if (done?.kind === "done") expect(done.stopReason).toBe("tool_use");
  });

  it("emits thinking_delta events", async () => {
    const got = await collect(
      translateStreamEvents(
        iter(
          ev({
            type: "message_start",
            message: { usage: { input_tokens: 50, output_tokens: 0 } },
          }),
          ev({
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          }),
          ev({
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "considering options" },
          }),
          ev({ type: "content_block_stop", index: 0 }),
          ev({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 10 },
          }),
          ev({ type: "message_stop" }),
        ),
      ),
    );
    const thinking = got.find((e) => e.kind === "thinking_delta");
    expect(thinking).toBeDefined();
    if (thinking?.kind === "thinking_delta") {
      expect(thinking.text).toBe("considering options");
    }
  });

  it("maps pause_turn stop reason to `compacted`", async () => {
    const got = await collect(
      translateStreamEvents(
        iter(
          ev({
            type: "message_start",
            message: { usage: { input_tokens: 100000, output_tokens: 0 } },
          }),
          ev({
            type: "message_delta",
            delta: { stop_reason: "pause_turn", stop_sequence: null },
            usage: { output_tokens: 100 },
          }),
          ev({ type: "message_stop" }),
        ),
      ),
    );
    const done = got[got.length - 1];
    if (done?.kind === "done") expect(done.stopReason).toBe("compacted");
  });

  it("handles malformed input_json gracefully (emits empty input)", async () => {
    const got = await collect(
      translateStreamEvents(
        iter(
          ev({
            type: "message_start",
            message: { usage: { input_tokens: 50, output_tokens: 0 } },
          }),
          ev({
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tu_x", name: "broken", input: {} },
          }),
          ev({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"broken":' },
          }),
          ev({ type: "content_block_stop", index: 0 }),
          ev({
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 5 },
          }),
          ev({ type: "message_stop" }),
        ),
      ),
    );
    const call = got.find((e) => e.kind === "tool_call");
    if (call?.kind === "tool_call") {
      expect(call.input).toEqual({});
    }
  });
});
