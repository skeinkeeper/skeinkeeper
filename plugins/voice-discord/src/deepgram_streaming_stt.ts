// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { WebSocket, type RawData } from "ws";
import type { STTOptions, STTProvider, Utterance } from "@skeinkeeper/orchestrator";
import { AsyncQueue } from "./async_queue.js";
import { buildUtterance } from "./provider_util.js";

/**
 * Streaming Deepgram speech-to-text (design doc 0018). Opens a Deepgram live
 * WebSocket and forwards PCM chunks as they arrive, yielding an Utterance for
 * each finalized segment — so the transcript is ready ~the instant the speaker
 * stops, instead of the prerecorded path's silence-close + drain + REST
 * round-trip. The STTProvider interface is already streaming-shaped, so this
 * drops straight into DiscordVoiceIO.
 *
 * The socket is injectable (DeepgramSocketFactory) so the frame-parsing logic
 * is unit-tested with a fake socket — the same testability the REST adapters
 * get from fetchImpl injection. Network-bound otherwise.
 */

/** Minimal socket surface so tests can drive transcription with a fake. */
export interface DeepgramSocket {
  send(data: Uint8Array | string): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: Error) => void): void;
}

export type DeepgramSocketFactory = (url: string, apiKey: string) => DeepgramSocket;

export interface DeepgramStreamingSTTOptions {
  apiKey: string;
  /** Deepgram model, e.g., "nova-3". */
  model?: string;
  /** Audio encoding, e.g., "linear16" for Discord's decoded PCM. */
  encoding?: string;
  sampleRate?: number;
  channels?: number;
  /**
   * Endpointing silence (ms) before Deepgram finalizes a transcript / sets
   * `speech_final` — smarter, faster turn-ends than a fixed timer (design doc
   * 0028 P3). Default 300. Set 0 to disable (Deepgram's own default behavior).
   */
  endpointingMs?: number;
  /** Defaults to wss://api.deepgram.com. */
  baseUrl?: string;
  /** Injectable for tests; defaults to a `ws` WebSocket. */
  socketFactory?: DeepgramSocketFactory;
}

interface DeepgramAlternative {
  transcript?: string;
  confidence?: number;
}
interface DeepgramResultMessage {
  type?: string;
  is_final?: boolean;
  channel?: { alternatives?: DeepgramAlternative[] };
}

function defaultSocketFactory(url: string, apiKey: string): DeepgramSocket {
  const ws = new WebSocket(url, { headers: { Authorization: `Token ${apiKey}` } });
  ws.binaryType = "nodebuffer";
  return {
    send: (data) => ws.send(data),
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
    onOpen: (cb) => ws.on("open", cb),
    onMessage: (cb) =>
      ws.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) return;
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.from(data as Buffer).toString("utf8");
        cb(text);
      }),
    onClose: (cb) => ws.on("close", () => cb()),
    onError: (cb) => ws.on("error", (err: Error) => cb(err)),
  };
}

export class DeepgramStreamingSTT implements STTProvider {
  readonly name = "deepgram-streaming";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly factory: DeepgramSocketFactory;

  constructor(private readonly options: DeepgramStreamingSTTOptions) {
    this.baseUrl = options.baseUrl ?? "wss://api.deepgram.com";
    this.model = options.model ?? "nova-3";
    this.factory = options.socketFactory ?? defaultSocketFactory;
  }

  private buildUrl(opts: STTOptions): string {
    const url = new URL(`${this.baseUrl}/v1/listen`);
    url.searchParams.set("model", this.model);
    url.searchParams.set("interim_results", "true");
    url.searchParams.set("smart_format", "true");
    // Endpointing: finalize a turn after N ms of silence (design doc 0028 P3).
    const endpointingMs = this.options.endpointingMs ?? 300;
    if (endpointingMs > 0) url.searchParams.set("endpointing", String(endpointingMs));
    if (this.options.encoding) url.searchParams.set("encoding", this.options.encoding);
    if (this.options.sampleRate)
      url.searchParams.set("sample_rate", String(this.options.sampleRate));
    if (this.options.channels) url.searchParams.set("channels", String(this.options.channels));
    if (opts.language) url.searchParams.set("language", opts.language);
    return url.toString();
  }

  private parseFinal(text: string, opts: STTOptions): Utterance | null {
    let msg: DeepgramResultMessage;
    try {
      msg = JSON.parse(text) as DeepgramResultMessage;
    } catch {
      return null;
    }
    if (msg.type !== undefined && msg.type !== "Results") return null;
    if (msg.is_final !== true) return null; // interim — parsed, not yielded (doc 0018 §5)
    const alt = msg.channel?.alternatives?.[0];
    const transcript = alt?.transcript?.trim() ?? "";
    if (transcript.length === 0) return null;
    return buildUtterance(opts, transcript, alt?.confidence);
  }

  async *transcribe(audio: AsyncIterable<Uint8Array>, opts: STTOptions): AsyncIterable<Utterance> {
    const socket = this.factory(this.buildUrl(opts), this.options.apiKey);
    const queue = new AsyncQueue<Utterance>();

    let opened = false;
    const openPromise = new Promise<void>((resolve, reject) => {
      socket.onOpen(() => {
        opened = true;
        resolve();
      });
      socket.onError((err) => {
        if (opened) queue.close();
        else reject(err);
      });
    });
    socket.onMessage((text) => {
      const u = this.parseFinal(text, opts);
      if (u) queue.push(u);
    });
    socket.onClose(() => queue.close());

    // Pump audio to the socket once it's open; signal end-of-stream so
    // Deepgram flushes its trailing final, then let onClose end the queue.
    const pump = (async () => {
      await openPromise;
      for await (const chunk of audio) socket.send(chunk);
      socket.send(JSON.stringify({ type: "CloseStream" }));
    })();
    pump.catch(() => queue.close());

    try {
      yield* queue;
    } finally {
      socket.close();
    }
  }
}
