// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import type { Utterance } from "@skeinkeeper/orchestrator";
import {
  DeepgramStreamingSTT,
  type DeepgramSocket,
} from "./deepgram_streaming_stt.js";

/** Fake Deepgram socket the test drives explicitly. */
class FakeSocket implements DeepgramSocket {
  readonly sentBinary: Uint8Array[] = [];
  readonly sentText: string[] = [];
  url = "";
  private openCb: (() => void) | undefined;
  private msgCb: ((t: string) => void) | undefined;
  private closeCb: (() => void) | undefined;
  private errCb: ((e: Error) => void) | undefined;

  send(data: Uint8Array | string): void {
    if (typeof data === "string") this.sentText.push(data);
    else this.sentBinary.push(data);
  }
  close(): void {
    this.closeCb?.();
  }
  onOpen(cb: () => void): void {
    this.openCb = cb;
  }
  onMessage(cb: (t: string) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  onError(cb: (e: Error) => void): void {
    this.errCb = cb;
  }

  emitOpen(): void {
    this.openCb?.();
  }
  emitMessage(obj: unknown): void {
    this.msgCb?.(JSON.stringify(obj));
  }
  emitClose(): void {
    this.closeCb?.();
  }
  emitError(e: Error): void {
    this.errCb?.(e);
  }
}

async function* audioChunks(...chunks: number[][]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield new Uint8Array(c);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("DeepgramStreamingSTT", () => {
  it("streams audio and yields one Utterance per final segment", async () => {
    const fake = new FakeSocket();
    const stt = new DeepgramStreamingSTT({
      apiKey: "k",
      encoding: "linear16",
      sampleRate: 48_000,
      channels: 2,
      socketFactory: (url) => {
        fake.url = url;
        return fake;
      },
    });

    const out: Utterance[] = [];
    const collect = (async () => {
      for await (const u of stt.transcribe(audioChunks([1, 2], [3, 4]), {
        speaker: "discord:1",
        displayName: "Alice",
      })) {
        out.push(u);
      }
    })();

    fake.emitOpen();
    await flush();
    // Audio forwarded after open, then a CloseStream signal.
    expect(fake.sentBinary.map((b) => Array.from(b))).toEqual([[1, 2], [3, 4]]);
    expect(fake.sentText).toContain(JSON.stringify({ type: "CloseStream" }));

    // Interim result is parsed but not yielded; the final is.
    fake.emitMessage({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: "i open" }] } });
    fake.emitMessage({
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ transcript: "i open the door", confidence: 0.96 }] },
    });
    fake.emitClose();
    await collect;

    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("i open the door");
    expect(out[0]!.speaker).toBe("discord:1");
    expect(out[0]!.displayName).toBe("Alice");
    expect(out[0]!.confidence).toBe(0.96);
  });

  it("requests interim results + the PCM format in the URL", async () => {
    const fake = new FakeSocket();
    const stt = new DeepgramStreamingSTT({
      apiKey: "k",
      encoding: "linear16",
      sampleRate: 48_000,
      channels: 2,
      socketFactory: (url) => {
        fake.url = url;
        return fake;
      },
    });
    const collect = (async () => {
      for await (const _u of stt.transcribe(audioChunks(), { speaker: "d", language: "en" })) {
        // drain
      }
    })();
    fake.emitOpen();
    await flush();
    fake.emitClose();
    await collect;

    expect(fake.url).toContain("/v1/listen");
    expect(fake.url).toContain("interim_results=true");
    expect(fake.url).toContain("encoding=linear16");
    expect(fake.url).toContain("sample_rate=48000");
    expect(fake.url).toContain("channels=2");
    expect(fake.url).toContain("language=en");
  });

  it("ignores empty final transcripts", async () => {
    const fake = new FakeSocket();
    const stt = new DeepgramStreamingSTT({ apiKey: "k", socketFactory: () => fake });
    const out: Utterance[] = [];
    const collect = (async () => {
      for await (const u of stt.transcribe(audioChunks([9]), { speaker: "d" })) out.push(u);
    })();
    fake.emitOpen();
    await flush();
    fake.emitMessage({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "" }] } });
    fake.emitClose();
    await collect;
    expect(out).toHaveLength(0);
  });
});
