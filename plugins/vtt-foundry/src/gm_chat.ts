// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type {
  FoundryClient,
  FoundrySurfaceLifecycleGate,
  OutboundSurface,
  SurfaceOutput,
} from "@skeinkeeper/orchestrator";
import { emitSkippedWhilePaused } from "./public_chat.js";

export interface FoundryGmChatSurfaceOptions {
  client: FoundryClient;
  /** When known, escalations also whisper this Foundry user (TDD 0034 §2). */
  operatorFoundryUserId?: string | (() => string | undefined);
  /** Design doc 0039: while paused-foundry-down, emits no-op (coalesced skip). */
  lifecycle?: FoundrySurfaceLifecycleGate;
}

export class FoundryGmChatSurface implements OutboundSurface {
  readonly name = "foundry-gm";
  readonly handles = ["gm"] as const;

  constructor(private readonly opts: FoundryGmChatSurfaceOptions) {}

  async emit(output: SurfaceOutput): Promise<void> {
    if (emitSkippedWhilePaused(this.opts.lifecycle, this.name, output)) return;
    const content = output.text ?? "";
    if (content.length === 0) return;
    const replyTo = output.meta?.replyTo;
    if (replyTo !== undefined) {
      await this.opts.client.postChatMessage({
        content,
        mode: "whisper",
        whisperTo: [replyTo],
      });
      return;
    }
    await this.opts.client.postChatMessage({ content, mode: "gm" });
    const operatorId =
      typeof this.opts.operatorFoundryUserId === "function"
        ? this.opts.operatorFoundryUserId()
        : this.opts.operatorFoundryUserId;
    if (output.meta?.escalation === true && operatorId !== undefined) {
      await this.opts.client.postChatMessage({
        content,
        mode: "whisper",
        whisperTo: [operatorId],
      });
    }
  }
}
