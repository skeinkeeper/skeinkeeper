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
import { isSkeinkeeperCommand } from "./command_parse.js";
import { parseChatConvention } from "./convention.js";

export interface FoundryPublicChatSurfaceOptions {
  client: FoundryClient;
  wakePhrase?: string;
}

export class FoundryPublicChatSurface implements OutboundSurface, InboundSurface {
  readonly name = "foundry-public";
  readonly handles = ["table"] as const;
  private readonly inbound = new AsyncQueue<SurfaceInputEvent>();
  private unsub: (() => void) | undefined;

  constructor(private readonly opts: FoundryPublicChatSurfaceOptions) {}

  async emit(output: SurfaceOutput): Promise<void> {
    const content = formatPublicContent(output);
    if (content.length === 0) return;
    await this.opts.client.postChatMessage({ content, mode: "public" });
  }

  handleChatEvent(event: FoundryChatEvent): SurfaceInputEvent | undefined {
    if (event.isWhisper) return undefined;
    if (isSkeinkeeperCommand(event.text)) return undefined;
    const convention = parseChatConvention(
      event.text,
      this.opts.wakePhrase !== undefined ? { wakePhrase: this.opts.wakePhrase } : undefined,
    );
    const mapped: SurfaceInputEvent = {
      kind: "chat.public",
      surface: "foundry-public",
      foundryUserId: event.foundryUserId,
      text: event.text,
      ...(convention !== undefined ? { convention } : {}),
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

function formatPublicContent(output: SurfaceOutput): string {
  const scene = output.meta?.sceneChange;
  if (scene !== undefined) {
    return `Scene changed: ${scene.fromSceneId} → ${scene.toSceneId}`;
  }
  const dice = output.meta?.diceReceipt;
  if (dice !== undefined) {
    return `🎲 ${dice.formula} = ${dice.result}`;
  }
  return output.text ?? "";
}
