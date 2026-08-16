// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { playerAudience, playerConversation } from "@skeinkeeper/server";
import { runTurn, type Session } from "../session.js";
import type { SurfaceInputEvent } from "../surfaces/events.js";
import type { SurfaceRouter } from "../surfaces/router.js";
import type { SideChannelIdentityMap } from "./identity_map.js";

export { SideChannelIdentityMap } from "./identity_map.js";

export type SideChannelDispatchResult =
  | { dispatched: true; playerId: string }
  | { dispatched: false; reason: "unmapped" | "ignored" | "stopped" };

export interface SideChannelCoordinatorOptions {
  session: Session;
  router: SurfaceRouter;
  identity: SideChannelIdentityMap;
  /** Max concurrent side-channel LLM turns. Table loop is exempt. Default 3. */
  semaphore?: number;
  /** Per-player coalesce window for rapid-fire whispers. Default 0 (off). */
  coalesceMs?: number;
  /** Foundry `/skeinkeeper` commands (TDD 0036 / 0040). */
  onOperatorCommand?: (
    event: Extract<SurfaceInputEvent, { kind: "chat.command" }>,
  ) => Promise<void>;
}

/**
 * Multiplexes inbound Foundry whispers onto 0026's player conversations
 * (TDD 0035 §3). The table loop stays on AlwaysListening; this owns only
 * `chat.whisper.player-to-dm`.
 */
export class SideChannelCoordinator {
  private stopped = false;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly maxInFlight: number;
  private readonly coalesceMs: number;
  private readonly buffers = new Map<string, string[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopWait: Promise<void>;
  private resolveStop: () => void = () => undefined;

  constructor(private readonly opts: SideChannelCoordinatorOptions) {
    this.maxInFlight = opts.semaphore ?? 3;
    this.coalesceMs = opts.coalesceMs ?? 0;
    this.stopWait = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
  }

  /** Consume `router.events()` until {@link stop}. */
  start(): Promise<void> {
    this.stopped = false;
    this.stopWait = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
    return this.pump();
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.resolveStop();
  }

  async handleEvent(event: SurfaceInputEvent): Promise<SideChannelDispatchResult> {
    if (this.stopped) return { dispatched: false, reason: "stopped" };
    if (event.kind === "chat.command") {
      await this.opts.onOperatorCommand?.(event);
      return { dispatched: false, reason: "ignored" };
    }
    if (event.kind !== "chat.whisper.player-to-dm") {
      return { dispatched: false, reason: "ignored" };
    }
    const playerId = this.opts.identity.discordIdForFoundryUser(event.foundryUserId);
    if (playerId === undefined) {
      console.warn(
        `[side-channel] unmapped Foundry whisper from user=${event.foundryUserId}; not dispatched`,
      );
      return { dispatched: false, reason: "unmapped" };
    }
    if (this.coalesceMs > 0) {
      return this.enqueue(playerId, event.text);
    }
    return this.dispatch(playerId, event.text);
  }

  private async pump(): Promise<void> {
    const iterator = this.opts.router.events()[Symbol.asyncIterator]();
    while (!this.stopped) {
      const next = await Promise.race([
        iterator.next(),
        this.stopWait.then(() => ({ done: true as const, value: undefined })),
      ]);
      if (this.stopped || next.done) break;
      if (next.value !== undefined) {
        await this.handleEvent(next.value);
      }
    }
  }

  private enqueue(playerId: string, text: string): Promise<SideChannelDispatchResult> {
    const buf = this.buffers.get(playerId) ?? [];
    buf.push(text);
    this.buffers.set(playerId, buf);
    const existing = this.timers.get(playerId);
    if (existing !== undefined) clearTimeout(existing);
    return new Promise((resolve) => {
      this.timers.set(
        playerId,
        setTimeout(() => {
          this.timers.delete(playerId);
          const texts = this.buffers.get(playerId) ?? [];
          this.buffers.delete(playerId);
          void this.dispatch(playerId, texts.join("\n")).then(resolve);
        }, this.coalesceMs),
      );
    });
  }

  private async dispatch(playerId: string, text: string): Promise<SideChannelDispatchResult> {
    await this.acquire();
    try {
      const hasher = this.opts.session.config.tenantDb.piiCrypto;
      const conversationId = playerConversation(hasher, playerId);
      const audience = playerAudience(hasher, playerId);
      await runTurn(
        this.opts.session,
        { speaker: playerId, text },
        {
          conversation: { id: conversationId, audience },
          modelTier: "orchestration",
        },
      );
      return { dispatched: true, playerId };
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < this.maxInFlight) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.inFlight += 1;
  }

  private release(): void {
    this.inFlight -= 1;
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }
}
