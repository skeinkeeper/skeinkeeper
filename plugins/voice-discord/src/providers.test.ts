// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { ElevenLabsVoiceLibrary } from "./elevenlabs_voice_library.js";
import { ElevenLabsTTS } from "./elevenlabs_tts.js";
import { DeepgramSTT } from "./deepgram_stt.js";
import { ElevenLabsScribeSTT } from "./elevenlabs_stt.js";

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(
  response: Response,
  captured: Captured[],
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    captured.push({ url: String(input), init });
    return response;
  }) as typeof fetch;
}

async function* bytes(...chunks: number[][]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield new Uint8Array(c);
}

describe("ElevenLabsVoiceLibrary", () => {
  it("maps voices and caches the result", async () => {
    const captured: Captured[] = [];
    const res = new Response(
      JSON.stringify({
        voices: [
          { voice_id: "v1", name: "Boulder", labels: { gender: "male", age: "old", timbre: "gravelly" } },
          { voice_id: "v2", name: "Hazel", description: "warm, kindly, female" },
        ],
      }),
      { status: 200 },
    );
    const lib = new ElevenLabsVoiceLibrary({ apiKey: "k", fetchImpl: fakeFetch(res, captured) });
    const entries = await lib.list();
    expect(entries).toEqual([
      { id: "v1", name: "Boulder", description: "male, old, gravelly", labels: { gender: "male", age: "old", timbre: "gravelly" } },
      { id: "v2", name: "Hazel", description: "warm, kindly, female" },
    ]);
    await lib.list();
    expect(captured).toHaveLength(1); // cached, not re-fetched
    expect(captured[0]!.url).toContain("/v1/voices");
  });

  it("throws on a non-OK response", async () => {
    const lib = new ElevenLabsVoiceLibrary({
      apiKey: "k",
      fetchImpl: fakeFetch(new Response("nope", { status: 401 }), []),
    });
    await expect(lib.list()).rejects.toThrow(/failed: 401/);
  });
});

describe("ElevenLabsTTS", () => {
  it("posts to the voice endpoint and returns audio bytes", async () => {
    const captured: Captured[] = [];
    const audio = new Uint8Array([1, 2, 3, 4]);
    const res = new Response(audio, { status: 200 });
    const tts = new ElevenLabsTTS({ apiKey: "k", fetchImpl: fakeFetch(res, captured) });
    const out = await tts.synthesize("Hello there.", { voiceId: "v-dm" });
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    expect(captured[0]!.url).toContain("/v1/text-to-speech/v-dm");
    expect(captured[0]!.init?.method).toBe("POST");
  });

  it("throws when no voice id is available", async () => {
    const tts = new ElevenLabsTTS({ apiKey: "k", fetchImpl: fakeFetch(new Response(""), []) });
    await expect(tts.synthesize("x")).rejects.toThrow(/no voiceId/);
  });
});

describe("DeepgramSTT", () => {
  it("drains audio, posts to listen, and yields a transcript utterance", async () => {
    const captured: Captured[] = [];
    const res = new Response(
      JSON.stringify({
        results: { channels: [{ alternatives: [{ transcript: "i open the door", confidence: 0.97 }] }] },
      }),
      { status: 200 },
    );
    const stt = new DeepgramSTT({ apiKey: "k", fetchImpl: fakeFetch(res, captured) });
    const out = [];
    for await (const u of stt.transcribe(bytes([1, 2], [3, 4]), { speaker: "discord:1", displayName: "Alice" })) {
      out.push(u);
    }
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("i open the door");
    expect(out[0]!.speaker).toBe("discord:1");
    expect(out[0]!.confidence).toBe(0.97);
    expect(captured[0]!.url).toContain("/v1/listen");
  });

  it("yields nothing for empty audio", async () => {
    const stt = new DeepgramSTT({ apiKey: "k", fetchImpl: fakeFetch(new Response("{}"), []) });
    const out = [];
    for await (const u of stt.transcribe(bytes(), { speaker: "discord:1" })) out.push(u);
    expect(out).toHaveLength(0);
  });
});

describe("ElevenLabsScribeSTT", () => {
  it("posts a multipart request and yields a transcript utterance", async () => {
    const captured: Captured[] = [];
    const res = new Response(JSON.stringify({ text: "we have to flee", language_probability: 0.99 }), {
      status: 200,
    });
    const stt = new ElevenLabsScribeSTT({ apiKey: "k", fetchImpl: fakeFetch(res, captured) });
    const out = [];
    for await (const u of stt.transcribe(bytes([5, 6, 7]), { speaker: "discord:2" })) out.push(u);
    expect(out[0]!.text).toBe("we have to flee");
    expect(out[0]!.confidence).toBe(0.99);
    expect(captured[0]!.url).toContain("/v1/speech-to-text");
    expect(captured[0]!.init?.body).toBeInstanceOf(FormData);
  });
});
