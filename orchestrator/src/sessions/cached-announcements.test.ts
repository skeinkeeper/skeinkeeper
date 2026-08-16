// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import type { BehaviorSpec } from "../behavior.js";
import { fakeLlmFromEvents } from "../interfaces/fake_llm_provider.js";
import type { TokenUsage } from "../interfaces/llm.js";
import type { TTSOptions, TTSProvider } from "../interfaces/voice.js";
import {
  DEFAULT_PAUSE_ANNOUNCEMENT,
  DEFAULT_RESUME_ANNOUNCEMENT,
  prepareLifecycleAnnouncements,
} from "./cached-announcements.js";

const USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5 };
const SPEC: BehaviorSpec = { content: "You are the AI DM.", version: "v0.1", path: "/t/spec.md" };

class FakeTts implements TTSProvider {
  readonly name = "fake-tts";
  readonly calls: Array<{ text: string; opts: TTSOptions | undefined }> = [];
  failWith: Error | undefined;

  async synthesize(text: string, opts?: TTSOptions): Promise<Uint8Array> {
    if (this.failWith !== undefined) throw this.failWith;
    this.calls.push({ text, opts });
    return new TextEncoder().encode(`audio:${text}`);
  }
}

function announcementConfig() {
  // Only behaviorSpec is read from the SessionConfig at announcement time.
  return { behaviorSpec: SPEC } as Parameters<typeof prepareLifecycleAnnouncements>[0]["config"];
}

describe("prepareLifecycleAnnouncements", () => {
  it("generates both announcements once and pre-renders TTS audio", async () => {
    const llm = fakeLlmFromEvents([
      {
        kind: "text_delta",
        text: '{"pause": "Pausing — Foundry lost contact.", "resume": "We are back."}',
      },
      { kind: "done", stopReason: "end_turn", usage: USAGE },
    ]);
    const tts = new FakeTts();
    const result = await prepareLifecycleAnnouncements({
      llm,
      tts,
      config: announcementConfig(),
      voiceId: "fake-voice-1",
    });
    expect(result.pauseFoundryDown.text).toBe("Pausing — Foundry lost contact.");
    expect(result.resumeOk.text).toBe("We are back.");
    expect(result.pauseFoundryDown.audio.length).toBeGreaterThan(0);
    expect(result.resumeOk.audio.length).toBeGreaterThan(0);
    expect(llm.receivedRequests).toHaveLength(1);
    expect(llm.receivedRequests[0]?.systemPrompt).toBe(SPEC.content);
    expect(tts.calls.map((c) => c.opts?.voiceId)).toEqual(["fake-voice-1", "fake-voice-1"]);
  });

  it("falls back to the default phrasings when the LLM fails", async () => {
    const llm = fakeLlmFromEvents([
      { kind: "error", error: { kind: "network", message: "down" } },
    ]);
    const tts = new FakeTts();
    const result = await prepareLifecycleAnnouncements({ llm, tts, config: announcementConfig() });
    expect(result.pauseFoundryDown.text).toBe(DEFAULT_PAUSE_ANNOUNCEMENT);
    expect(result.resumeOk.text).toBe(DEFAULT_RESUME_ANNOUNCEMENT);
  });

  it("falls back to the defaults when the LLM returns unusable JSON", async () => {
    const llm = fakeLlmFromEvents([
      { kind: "text_delta", text: "sure, here you go!" },
      { kind: "done", stopReason: "end_turn", usage: USAGE },
    ]);
    const result = await prepareLifecycleAnnouncements({
      llm,
      tts: new FakeTts(),
      config: announcementConfig(),
    });
    expect(result.pauseFoundryDown.text).toBe(DEFAULT_PAUSE_ANNOUNCEMENT);
    expect(result.resumeOk.text).toBe(DEFAULT_RESUME_ANNOUNCEMENT);
  });

  it("keeps the text with empty audio when TTS pre-render fails", async () => {
    const llm = fakeLlmFromEvents([
      { kind: "text_delta", text: '{"pause": "P.", "resume": "R."}' },
      { kind: "done", stopReason: "end_turn", usage: USAGE },
    ]);
    const tts = new FakeTts();
    tts.failWith = new Error("fake-tts-down");
    const result = await prepareLifecycleAnnouncements({ llm, tts, config: announcementConfig() });
    expect(result.pauseFoundryDown.text).toBe("P.");
    expect(result.pauseFoundryDown.audio.length).toBe(0);
    expect(result.resumeOk.audio.length).toBe(0);
  });
});
