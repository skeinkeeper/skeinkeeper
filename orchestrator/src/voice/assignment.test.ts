// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { fakeLlmFromEvents, FakeLLMProvider } from "../interfaces/fake_llm_provider.js";
import type { TokenUsage } from "../interfaces/llm.js";
import { type VoiceLibraryEntry } from "./library.js";
import {
  assignNpcVoice,
  resolveSegmentVoices,
  VoiceAssignmentError,
} from "./assignment.js";
import type { NarrationSegment } from "./markers.js";

const USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5 };

const LIBRARY: ReadonlyArray<VoiceLibraryEntry> = [
  { id: "v-deep", name: "Boulder", description: "deep, gravelly, older male, gruff" },
  { id: "v-reedy", name: "Pip", description: "thin, reedy, nervous, youthful" },
  { id: "v-warm", name: "Hazel", description: "warm, mid, female, kindly" },
];

function llmReturning(json: string): FakeLLMProvider {
  return fakeLlmFromEvents([
    { kind: "text_delta", text: json },
    { kind: "done", stopReason: "end_turn", usage: USAGE },
  ]);
}

describe("assignNpcVoice", () => {
  it("returns the voice id the model picked", async () => {
    const llm = llmReturning('{"voiceId": "v-deep", "reason": "gruff dwarf smith"}');
    const res = await assignNpcVoice(llm, {
      npcKey: "klarg",
      npcDescription: "a hulking bugbear chieftain",
      library: LIBRARY,
    });
    expect(res.providerVoiceId).toBe("v-deep");
    expect(res.reason).toBe("gruff dwarf smith");
  });

  it("falls back to matching the model's answer by name", async () => {
    const llm = llmReturning('{"voiceId": "Pip"}');
    const res = await assignNpcVoice(llm, {
      npcKey: "shopkeeper",
      npcDescription: "a nervous shopkeeper",
      library: LIBRARY,
    });
    expect(res.providerVoiceId).toBe("v-reedy");
  });

  it("throws when the model returns an unknown voice", async () => {
    const llm = llmReturning('{"voiceId": "does-not-exist"}');
    await expect(
      assignNpcVoice(llm, { npcKey: "x", npcDescription: "y", library: LIBRARY }),
    ).rejects.toBeInstanceOf(VoiceAssignmentError);
  });

  it("throws on an empty library", async () => {
    const llm = llmReturning('{"voiceId": "v-deep"}');
    await expect(
      assignNpcVoice(llm, { npcKey: "x", npcDescription: "y", library: [] }),
    ).rejects.toBeInstanceOf(VoiceAssignmentError);
  });

  it("passes the voice catalog to the model in the prompt", async () => {
    const llm = llmReturning('{"voiceId": "v-warm"}');
    await assignNpcVoice(llm, {
      npcKey: "innkeeper",
      npcDescription: "a kindly innkeeper",
      library: LIBRARY,
    });
    const sent = llm.receivedRequests[0]!;
    expect(sent.modelTier).toBe("orchestration");
    const userText = sent.messages[0]!.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    expect(userText).toContain("v-warm");
    expect(userText).toContain("kindly innkeeper");
  });
});

describe("resolveSegmentVoices", () => {
  const segments: ReadonlyArray<NarrationSegment> = [
    { kind: "dm", text: "The door creaks open." },
    { kind: "npc", npcKey: "sildar", text: '"Thank the gods."' },
    { kind: "npc", npcKey: "sildar", text: '"We must hurry."' },
  ];

  it("uses the DM voice for DM segments and a persisted voice for NPCs", async () => {
    const resolved = await resolveSegmentVoices(segments, {
      dmVoiceId: "dm-voice",
      getNpcVoice: (k) => (k === "sildar" ? "sildar-voice" : undefined),
      assignNpcVoice: async () => {
        throw new Error("should not assign — already persisted");
      },
    });
    expect(resolved).toEqual([
      { text: "The door creaks open.", voiceId: "dm-voice" },
      { text: '"Thank the gods."', voiceId: "sildar-voice" },
      { text: '"We must hurry."', voiceId: "sildar-voice" },
    ]);
  });

  it("assigns a voice on first encounter when none is persisted", async () => {
    const assigned: string[] = [];
    const resolved = await resolveSegmentVoices(segments, {
      dmVoiceId: "dm-voice",
      getNpcVoice: () => undefined,
      assignNpcVoice: async (k) => {
        assigned.push(k);
        return "newly-assigned";
      },
    });
    expect(resolved[1]!.voiceId).toBe("newly-assigned");
    // Both NPC segments share the key; the loop calls the assigner for each
    // missing lookup — callers persist after first assign so getNpcVoice would
    // then return it, but with a stub getNpcVoice it is called twice.
    expect(assigned).toEqual(["sildar", "sildar"]);
  });
});
