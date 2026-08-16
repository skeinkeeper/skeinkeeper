// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { AnalyticsClient } from "@skeinkeeper/telemetry";
import type { Audience } from "./audience.js";
import { AsyncQueue } from "./async_queue.js";
import type { SurfaceInputEvent } from "./events.js";
import {
  isInboundSurface,
  isOutboundSurface,
  type InboundSurface,
  type OutboundSurface,
  type SurfaceOutput,
} from "./surface.js";

export interface EmitReport {
  perSurface: ReadonlyArray<{ surface: string; status: "ok" | "failed"; error?: string }>;
  totalSurfaces: number;
}

export interface SurfaceRouterOptions {
  analytics?: AnalyticsClient;
  hashPlayerId?: (playerId: string) => string;
  /** Default per-surface emit timeout. Voice is unbounded. Default 1500. */
  emitTimeoutMs?: number;
  /** Timeout for gm-audience escalations (not on the voice path). Default 5000. */
  gmEscalationTimeoutMs?: number;
  /** Per-surface emit outcome, for the Foundry-down detector (design doc 0039
   *  §2b): the Coordinator feeds Foundry-side failures/successes to the
   *  LifecycleController's consecutive-failure counter. */
  onEmitResult?: (surface: string, status: "ok" | "failed", reason?: string) => void;
}

export class NoHandlingSurfaceError extends Error {
  readonly audienceKind: Audience["kind"];
  readonly registered: ReadonlyArray<string>;

  constructor(audienceKind: Audience["kind"], registered: ReadonlyArray<string>) {
    super(`no surface for audience kind=${audienceKind}`);
    this.name = "NoHandlingSurfaceError";
    this.audienceKind = audienceKind;
    this.registered = registered;
  }
}

const DEFAULT_EMIT_TIMEOUT_MS = 1500;
const DEFAULT_GM_ESCALATION_TIMEOUT_MS = 5000;

export class SurfaceRouter {
  private readonly outbound: OutboundSurface[] = [];
  private readonly inbound: InboundSurface[] = [];
  private readonly analytics: AnalyticsClient | undefined;
  private readonly hashPlayerId: ((playerId: string) => string) | undefined;
  private readonly emitTimeoutMs: number;
  private readonly gmEscalationTimeoutMs: number;
  private readonly onEmitResult: SurfaceRouterOptions["onEmitResult"];

  constructor(opts: SurfaceRouterOptions = {}) {
    this.analytics = opts.analytics;
    this.hashPlayerId = opts.hashPlayerId;
    this.emitTimeoutMs = opts.emitTimeoutMs ?? DEFAULT_EMIT_TIMEOUT_MS;
    this.gmEscalationTimeoutMs = opts.gmEscalationTimeoutMs ?? DEFAULT_GM_ESCALATION_TIMEOUT_MS;
    this.onEmitResult = opts.onEmitResult;
  }

  register(surface: OutboundSurface | InboundSurface): void {
    if (isOutboundSurface(surface)) this.outbound.push(surface);
    if (isInboundSurface(surface)) this.inbound.push(surface);
  }

  async emit(output: SurfaceOutput): Promise<EmitReport> {
    const kind = output.audience.kind;
    const targets = this.outbound.filter((s) => s.handles.includes(kind));
    if (targets.length === 0) {
      const registered = this.outbound.map((s) => s.name);
      console.error(
        `[surface-router] no surface for audience kind=${kind}; registered=[${registered.join(",")}]`,
      );
      this.analytics?.track("surface.emit.failed", {
        surface: "(none)",
        audience: this.audiencePayload(output.audience),
        reason: "no-handling-surface",
      });
      throw new NoHandlingSurfaceError(kind, registered);
    }

    const timeoutMs = this.timeoutFor(output);
    const perSurface = await Promise.all(
      targets.map((surface) => this.emitOne(surface, output, timeoutMs)),
    );
    return { perSurface, totalSurfaces: targets.length };
  }

  events(): AsyncIterable<SurfaceInputEvent> {
    const queue = new AsyncQueue<SurfaceInputEvent>();
    const pumps = this.inbound.map(async (surface) => {
      for await (const event of surface.events()) {
        this.analytics?.track("surface.input", { surface: event.surface, kind: event.kind });
        queue.push(event);
      }
    });
    void Promise.all(pumps).then(() => queue.close());
    return queue;
  }

  private timeoutFor(output: SurfaceOutput): number {
    if (output.audience.kind === "gm" && output.meta?.escalation === true) {
      return this.gmEscalationTimeoutMs;
    }
    return this.emitTimeoutMs;
  }

  private async emitOne(
    surface: OutboundSurface,
    output: SurfaceOutput,
    timeoutMs: number,
  ): Promise<{ surface: string; status: "ok" | "failed"; error?: string }> {
    const started = Date.now();
    const audience = this.audiencePayload(output.audience);
    try {
      if (surface.unboundedEmit === true) {
        await surface.emit(output);
      } else {
        await withTimeout(surface.emit(output), timeoutMs);
      }
      this.analytics?.track("surface.emit", {
        surface: surface.name,
        audience,
        latencyMs: Date.now() - started,
      });
      this.onEmitResult?.(surface.name, "ok");
      return { surface: surface.name, status: "ok" };
    } catch (err) {
      const reason = timeoutReason(err);
      this.analytics?.track("surface.emit.failed", {
        surface: surface.name,
        audience,
        reason,
      });
      this.onEmitResult?.(surface.name, "failed", reason);
      return { surface: surface.name, status: "failed", error: reason };
    }
  }

  private audiencePayload(audience: Audience): {
    kind: "table" | "player" | "gm";
    player?: string;
  } {
    if (audience.kind === "player") {
      const hashed = this.hashPlayerId?.(audience.playerId);
      return hashed !== undefined ? { kind: "player", player: hashed } : { kind: "player" };
    }
    return { kind: audience.kind };
  }
}

function timeoutReason(err: unknown): string {
  if (err instanceof EmitTimeoutError) return "timeout";
  if (err instanceof Error) return err.message.length > 0 ? err.message : err.name;
  return String(err);
}

class EmitTimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "EmitTimeoutError";
  }
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new EmitTimeoutError()), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
