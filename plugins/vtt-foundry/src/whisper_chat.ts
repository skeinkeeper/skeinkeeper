// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type {
  FoundryChatEvent,
  FoundryClient,
  InboundSurface,
  OutboundSurface,
  SurfaceInputEvent,
  SurfaceOutput,
} from "@skeinkeeper/orchestrator";
import { AsyncQueue } from "@skeinkeeper/orchestrator";

export interface FoundryWhisperSurfaceOptions {
  client: FoundryClient;
  /** Discord player id → Foundry user id (TDD 0036 3-way map). */
  resolveFoundryUserId?: (playerId: string) => string | undefined;
  /** When set, only whispers listing this recipient are inbound DM-to-AI. */
  dmFoundryUserId?: string;
}

export class FoundryWhisperSurface implements OutboundSurface, InboundSurface {
  readonly name = "foundry-whisper";
  readonly handles = ["player"] as const;
  private readonly inbound = new AsyncQueue<SurfaceInputEvent>();
  private unsub: (() => void) | undefined;

  constructor(private readonly opts: FoundryWhisperSurfaceOptions) {}

  async emit(output: SurfaceOutput): Promise<void> {
    if (output.audience.kind !== "player") return;
    const foundryUserId = this.opts.resolveFoundryUserId?.(output.audience.playerId);
    if (foundryUserId === undefined) {
      throw new Error("unresolved-foundry-user");
    }
    const handout = output.meta?.handout;
    const content = handout !== undefined ? `Handout: ${handout.journalRef}` : (output.text ?? "");
    if (content.length === 0) return;
    await this.opts.client.postChatMessage({
      content,
      mode: "whisper",
      whisperTo: [foundryUserId],
    });
  }

  handleChatEvent(event: FoundryChatEvent): SurfaceInputEvent | undefined {
    if (!event.isWhisper) return undefined;
    const dm = this.opts.dmFoundryUserId;
    if (dm !== undefined && event.recipients !== undefined && !event.recipients.includes(dm)) {
      return undefined;
    }
    const mapped: SurfaceInputEvent = {
      kind: "chat.whisper.player-to-dm",
      surface: "foundry-whisper",
      foundryUserId: event.foundryUserId,
      text: event.text,
    };
    this.inbound.push(mapped);
    return mapped;
  }

  events(): AsyncIterable<SurfaceInputEvent> {
    this.ensureSubscribed();
    return this.inbound;
  }

  close(): void {
    this.unsub?.();
    this.unsub = undefined;
    this.inbound.close();
  }

  private ensureSubscribed(): void {
    if (this.unsub !== undefined) return;
    this.unsub = this.opts.client.subscribeChatEvents((event) => {
      this.handleChatEvent(event);
    });
  }
}
