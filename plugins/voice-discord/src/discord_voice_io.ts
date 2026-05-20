// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  entersState,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import prism from "prism-media";
import type {
  PresenceMember,
  STTProvider,
  SpeakOptions,
  TTSProvider,
  VoiceEvent,
  VoiceIO,
} from "@skeinkeeper/orchestrator";
import { AsyncQueue } from "./async_queue.js";

/**
 * Voice-channel roster source (design doc 0023). DiscordVoiceIO stays free of
 * the discord.js gateway client (see the class doc) — the operator app, which
 * owns the client + guild, supplies presence the same way it supplies consent
 * DMs. `current()` is the snapshot at listen() time; `subscribe` reports
 * join/leave changes until the returned unsubscribe is called. Both exclude
 * the bot itself.
 */
export interface PresenceSource {
  current(): ReadonlyArray<PresenceMember>;
  subscribe(onChange: (members: ReadonlyArray<PresenceMember>) => void): () => void;
}

/**
 * Discord voice transport for the always-listening loop (design docs 0012 +
 * 0015). Receives per-speaker Opus audio from a joined voice channel, gates
 * on consent BEFORE STT, decodes + transcribes consented speech into
 * `utterance` events, emits `lull` events when the table goes quiet, and
 * plays TTS narration back.
 *
 * LIVE-VALIDATION REQUIRED. This is real-time audio I/O against Discord +
 * an STT provider; it cannot be exercised by the unit-test suite (no audio,
 * no gateway). The pure pieces around it (AsyncQueue, the provider adapters)
 * are unit-tested; this transport is validated by an operator on a live
 * channel. Requires an ffmpeg binary on PATH for TTS playback (standard for
 * Discord audio bots), plus an opus engine (opusscript) and an encryption
 * backend (Node native aes-256-gcm, or libsodium-wrappers). Discord now
 * mandates its DAVE end-to-end-encryption protocol on voice channels, so
 * @discordjs/voice >= 0.19 (which bundles @snazzah/davey) is required —
 * older versions are rejected during the voice handshake with close code
 * 4017 ("E2EE/DAVE protocol required").
 *
 * The caller (operator app / Phase 5) owns joining the channel and supplies
 * the `VoiceConnection`; this adapter does not depend on discord.js's gateway
 * client, keeping its surface small. The caller MUST join with
 * `selfDeaf: false` — `joinVoiceChannel` defaults to deafened, and a
 * deafened bot receives no audio (speaking events still fire from the
 * gateway, so it looks alive while transcribing nothing).
 */
export interface DiscordVoiceIOOptions {
  connection: VoiceConnection;
  stt: STTProvider;
  tts: TTSProvider;
  /** Consent gate, checked before any audio reaches STT (ADR-0010). */
  isConsented: (discordUserId: string) => boolean;
  /** Optional display-name lookup for friendlier prompt rendering. */
  resolveDisplayName?: (discordUserId: string) => string | undefined;
  /** Quiet-time before a `lull` event fires (ms). Default 1500. */
  lullMs?: number;
  /** End-of-utterance silence for receiver subscription (ms). Default 800. */
  silenceMs?: number;
  /** STT language hint, e.g., "en". */
  language?: string;
  /** Voice-channel roster source for the onboarding ritual (design doc 0023).
   *  When set, `listen()` emits a `presence` event on start and on each
   *  join/leave. Omitted → no presence events (onboarding stays dormant). */
  presence?: PresenceSource;
}

const DISCORD_SAMPLE_RATE = 48_000;
const DISCORD_CHANNELS = 2;
const DISCORD_FRAME_SIZE = 960;

export class DiscordVoiceIO implements VoiceIO {
  readonly name = "discord";
  private readonly player: AudioPlayer;
  private readonly active = new Set<string>();
  /** Speakers we've already sent a consent prompt for, so a noisy room
   *  doesn't re-prompt on every speaking burst. Cleared once they consent. */
  private readonly consentPrompted = new Set<string>();
  private queue: AsyncQueue<VoiceEvent> | null = null;
  private lullTimer: NodeJS.Timeout | null = null;
  private unsubscribePresence: (() => void) | null = null;
  private closed = false;

  constructor(private readonly options: DiscordVoiceIOOptions) {
    this.player = createAudioPlayer();
    this.options.connection.subscribe(this.player);
  }

  async *listen(): AsyncIterable<VoiceEvent> {
    const queue = new AsyncQueue<VoiceEvent>();
    this.queue = queue;
    const receiver = this.options.connection.receiver;

    receiver.speaking.on("start", (userId: string) => {
      this.armLullTimer();
      void this.handleSpeaker(userId, queue);
    });

    // Presence (design doc 0023): emit the initial roster, then push updates as
    // members join/leave. The loop diffs these to drive the onboarding ritual.
    const presence = this.options.presence;
    if (presence !== undefined) {
      queue.push({ kind: "presence", members: presence.current() });
      this.unsubscribePresence = presence.subscribe((members) => {
        if (!this.closed) queue.push({ kind: "presence", members });
      });
    }

    yield* queue;
  }

  private armLullTimer(): void {
    const lullMs = this.options.lullMs ?? 1500;
    if (this.lullTimer) clearTimeout(this.lullTimer);
    this.lullTimer = setTimeout(() => {
      if (!this.closed) this.queue?.push({ kind: "lull", durationMs: lullMs });
    }, lullMs);
  }

  private async handleSpeaker(userId: string, queue: AsyncQueue<VoiceEvent>): Promise<void> {
    if (this.active.has(userId)) return;

    if (!this.options.isConsented(userId)) {
      // Prompt once per unconsented speaker — not on every burst.
      if (this.consentPrompted.has(userId)) return;
      this.consentPrompted.add(userId);
      const displayName = this.options.resolveDisplayName?.(userId);
      queue.push({
        kind: "consent_needed",
        speaker: userId,
        ...(displayName !== undefined ? { displayName } : {}),
      });
      return;
    }

    // Consented — reset the prompt guard so a future withdrawal re-prompts.
    this.consentPrompted.delete(userId);
    this.active.add(userId);
    try {
      const opusStream = this.options.connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: this.options.silenceMs ?? 800 },
      });
      const decoder = new prism.opus.Decoder({
        rate: DISCORD_SAMPLE_RATE,
        channels: DISCORD_CHANNELS,
        frameSize: DISCORD_FRAME_SIZE,
      });
      const pcm = opusStream.pipe(decoder) as unknown as AsyncIterable<Uint8Array>;

      const displayName = this.options.resolveDisplayName?.(userId);
      for await (const utterance of this.options.stt.transcribe(pcm, {
        speaker: userId,
        ...(displayName !== undefined ? { displayName } : {}),
        ...(this.options.language !== undefined ? { language: this.options.language } : {}),
      })) {
        this.armLullTimer();
        queue.push({ kind: "utterance", utterance });
      }
    } finally {
      this.active.delete(userId);
    }
  }

  async speak(text: string, opts?: SpeakOptions): Promise<void> {
    const voiceId = opts?.voiceId;
    const bytes = await this.options.tts.synthesize(text, voiceId !== undefined ? { voiceId } : undefined);
    const resource = createAudioResource(Readable.from(Buffer.from(bytes)), {
      inputType: StreamType.Arbitrary,
    });
    this.player.play(resource);
    // VoiceIO contract: resolve when playback ends. Confirm it started, then
    // wait for the player to return to Idle. If it never starts (empty/errored
    // resource), don't hang.
    try {
      await entersState(this.player, AudioPlayerStatus.Playing, 10_000);
    } catch {
      return;
    }
    await entersState(this.player, AudioPlayerStatus.Idle, 10 * 60_000);
  }

  async requestConsent(_subjectId: string, _consentText: string): Promise<void> {
    // The consent prompt is delivered out-of-band (a Discord DM / slash-command
    // flow) by the operator app, which owns the gateway client. This transport
    // only gates audio; it does not send DMs. Wired in Phase 5.
    throw new Error(
      "DiscordVoiceIO.requestConsent is delivered by the operator app (gateway client), not the voice transport.",
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.lullTimer) clearTimeout(this.lullTimer);
    if (this.unsubscribePresence) this.unsubscribePresence();
    this.player.stop(true);
    this.queue?.close();
  }
}
