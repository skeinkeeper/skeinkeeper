// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type {
  InboundSurface,
  OutboundSurface,
  SurfaceInputEvent,
  SurfaceOutput,
  VoiceIO,
} from "@skeinkeeper/orchestrator";
import {
  AsyncQueue,
  parseNarrationSegments,
  resolveSegmentVoices,
} from "@skeinkeeper/orchestrator";

export interface DiscordVoiceRouting {
  dmVoiceId: string;
  getNpcVoice: (npcKey: string) => string | undefined;
  assignNpcVoice: (npcKey: string) => Promise<string>;
}

/**
 * Table-audience voice surface (TDD 0034). `emit` speaks via the existing
 * VoiceIO TTS path — streaming inside `speak` is unchanged.
 */
export class DiscordVoiceSurface implements OutboundSurface, InboundSurface {
  readonly name = "discord-voice";
  readonly handles = ["table"] as const;
  readonly unboundedEmit = true;
  private readonly inbound = new AsyncQueue<SurfaceInputEvent>();
  private pumping = false;

  constructor(
    private readonly voiceIO: VoiceIO,
    private readonly voiceRouting?: DiscordVoiceRouting,
  ) {}

  async emit(output: SurfaceOutput): Promise<void> {
    if (output.audience.kind !== "table") return;
    const text = output.text ?? "";
    if (text.length === 0) return;
    const routing = this.voiceRouting;
    if (routing !== undefined) {
      const resolved = await resolveSegmentVoices(parseNarrationSegments(text), routing);
      for (const seg of resolved) {
        await this.voiceIO.speak(seg.text, { voiceId: seg.voiceId });
      }
      return;
    }
    await this.voiceIO.speak(text);
  }

  events(): AsyncIterable<SurfaceInputEvent> {
    if (!this.pumping) {
      this.pumping = true;
      void this.pump();
    }
    return this.inbound;
  }

  close(): void {
    this.inbound.close();
  }

  private async pump(): Promise<void> {
    for await (const ev of this.voiceIO.listen()) {
      if (ev.kind === "utterance") {
        this.inbound.push({
          kind: "voice.utterance",
          surface: "discord-voice",
          speakerDiscordId: ev.utterance.speaker,
          text: ev.utterance.text,
        });
      } else if (ev.kind === "presence") {
        this.inbound.push({
          kind: "voice.presence",
          surface: "discord-voice",
          members: ev.members.map((m) =>
            m.displayName !== undefined
              ? { discordId: m.id, displayName: m.displayName }
              : { discordId: m.id },
          ),
        });
      }
    }
    this.inbound.close();
  }
}
