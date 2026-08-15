// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Multiplexed inbound events from every registered `InboundSurface`.
 * `foundryUserId` is opaque here; TDD 0036's identity map resolves it.
 */
export type SurfaceInputEvent =
  | {
      kind: "voice.utterance";
      surface: "discord-voice";
      speakerDiscordId: string;
      text: string;
      convention?: "ic" | "ooc";
    }
  | {
      kind: "voice.presence";
      surface: "discord-voice";
      members: ReadonlyArray<{ discordId: string; displayName?: string }>;
    }
  | {
      kind: "consent.response";
      surface: "discord-consent";
      discordId: string;
      decision: "accept" | "decline";
    }
  | {
      kind: "chat.public";
      surface: "foundry-public";
      foundryUserId: string;
      text: string;
      convention?: "ic" | "ooc";
    }
  | {
      kind: "chat.whisper.player-to-dm";
      surface: "foundry-whisper";
      foundryUserId: string;
      text: string;
    }
  | {
      kind: "chat.command";
      surface: "foundry-chat-command";
      foundryUserId: string;
      verb: string;
      args: ReadonlyArray<string>;
      raw: string;
    }
  | {
      kind: "console.control";
      surface: "web-console";
      operatorActorId: string;
      control: ConsoleControl;
    };

/** Operator-control payload on the web-console inbound surface (TDD 0025 / 0040). */
export type ConsoleControl =
  | { control: "session"; action: "start" | "stop" | "pause" | "resume" }
  | { control: "eagerness"; level: string }
  | { control: "voice"; action: "list" }
  | { control: "voice"; action: "set"; persona: string }
  | { control: "operator"; action: "claim" | "clear" | "show" }
  | { control: "intake"; id: string; option: string }
  | { control: "consent"; decision: "accept" | "decline" }
  | { control: "map"; discordUser: string; character: string }
  | { control: "pvp"; enabled: boolean };

/** TTS byte stream consumed only by the voice surface. */
export type TtsStream = AsyncIterable<Uint8Array>;
