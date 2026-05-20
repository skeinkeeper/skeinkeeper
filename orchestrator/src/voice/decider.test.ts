// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { FakeLLMProvider, fakeLlmFromEvents } from "../interfaces/fake_llm_provider.js";
import type { TokenUsage } from "../interfaces/llm.js";
import { decideShouldRespond } from "./decider.js";
import type { BufferFragment } from "./buffer.js";

const USAGE: TokenUsage = { inputTokens: 8, outputTokens: 4 };

function frag(speaker: string, text: string): BufferFragment {
  return { speaker, text, startTs: 1, endTs: 1, final: true };
}

function llmReturning(json: string): FakeLLMProvider {
  return fakeLlmFromEvents([
    { kind: "text_delta", text: json },
    { kind: "done", stopReason: "end_turn", usage: USAGE },
  ]);
}

describe("decideShouldRespond", () => {
  it("returns respond:true when the model says so", async () => {
    const llm = llmReturning('{"respond": true, "reason": "player addressed the DM"}');
    const d = await decideShouldRespond(llm, {
      fragments: [frag("alice", "DM, what do I see?")],
      eagerness: "balanced",
    });
    expect(d.respond).toBe(true);
    expect(d.reason).toContain("addressed");
  });

  it("returns respond:false for pure deliberation", async () => {
    const llm = llmReturning('{"respond": false, "reason": "inter-player chatter"}');
    const d = await decideShouldRespond(llm, {
      fragments: [frag("alice", "should we trust him?"), frag("bob", "dunno, seems shifty")],
      eagerness: "balanced",
    });
    expect(d.respond).toBe(false);
  });

  it("stays quiet on an empty buffer without calling the model", async () => {
    const llm = llmReturning('{"respond": true}');
    const d = await decideShouldRespond(llm, { fragments: [], eagerness: "eager" });
    expect(d.respond).toBe(false);
    expect(llm.receivedRequests).toHaveLength(0);
  });

  it("fails safe (quiet) on an unparseable response", async () => {
    const llm = llmReturning("I think the DM should probably speak now.");
    const d = await decideShouldRespond(llm, {
      fragments: [frag("alice", "hmm")],
      eagerness: "balanced",
    });
    expect(d.respond).toBe(false);
  });

  it("fails safe (quiet) on an LLM error", async () => {
    const llm = fakeLlmFromEvents([
      { kind: "error", error: { kind: "overloaded", message: "busy" } },
    ]);
    const d = await decideShouldRespond(llm, {
      fragments: [frag("alice", "hmm")],
      eagerness: "balanced",
    });
    expect(d.respond).toBe(false);
    expect(d.reason).toContain("error");
  });

  it("instructs the decider to respond to player introductions (intro ritual)", async () => {
    const llm = llmReturning('{"respond": true, "reason": "introduction"}');
    const d = await decideShouldRespond(llm, {
      fragments: [frag("alice", "Hi, I'm Chris, I'm playing Aragorn")],
      eagerness: "balanced",
    });
    expect(d.respond).toBe(true);
    expect(llm.receivedRequests[0]!.systemPrompt.toLowerCase()).toContain("introduce");
  });

  it("sends the orchestration tier and injects the eagerness instruction", async () => {
    const llm = llmReturning('{"respond": false}');
    await decideShouldRespond(llm, {
      fragments: [frag("alice", "I move into the dark corner")],
      eagerness: "reserved",
    });
    const sent = llm.receivedRequests[0]!;
    expect(sent.modelTier).toBe("orchestration");
    const userText = sent.messages[0]!.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    expect(userText).toContain("RESERVED");
    expect(userText).toContain("I move into the dark corner");
  });
});
