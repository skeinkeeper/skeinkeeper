// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type {
  FoundryChatEvent,
  FoundryClient,
  InboundSurface,
  OutboundSurface,
  SurfaceInputEvent,
} from "@skeinkeeper/orchestrator";
import { AsyncQueue } from "@skeinkeeper/orchestrator";
import { isSkeinkeeperCommand, parseSkeinkeeperCommand } from "./command_parse.js";

export interface CommandAnalytics {
  track(name: "surface.command.parsed", props: { verb: string; ok: boolean }): void;
}

export interface FoundryChatCommandSurfaceOptions {
  client: FoundryClient;
  /** Inline parse-error replies (FoundryGmChatSurface in production). */
  reply: OutboundSurface;
  analytics?: CommandAnalytics;
}

export class FoundryChatCommandSurface implements InboundSurface {
  readonly name = "foundry-chat-command";
  private readonly inbound = new AsyncQueue<SurfaceInputEvent>();
  private unsub: (() => void) | undefined;

  constructor(private readonly opts: FoundryChatCommandSurfaceOptions) {}

  async handleChatEvent(event: FoundryChatEvent): Promise<SurfaceInputEvent | undefined> {
    if (event.isWhisper) return undefined;
    if (!isSkeinkeeperCommand(event.text)) return undefined;
    const parsed = parseSkeinkeeperCommand(event.text);
    this.opts.analytics?.track("surface.command.parsed", { verb: parsed.verb, ok: parsed.ok });
    if (!parsed.ok) {
      await this.opts.reply.emit({
        audience: { kind: "gm" },
        text: parsed.error,
        meta: { replyTo: event.foundryUserId },
      });
      return undefined;
    }
    const mapped: SurfaceInputEvent = {
      kind: "chat.command",
      surface: "foundry-chat-command",
      foundryUserId: event.foundryUserId,
      verb: parsed.verb,
      args: parsed.args,
      raw: parsed.raw,
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
      void this.handleChatEvent(event);
    });
  }
}
