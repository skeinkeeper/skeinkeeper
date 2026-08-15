// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { Audience } from "./audience.js";
import type { SurfaceInputEvent, TtsStream } from "./events.js";

export interface SurfaceOutput {
  audience: Audience;
  text?: string;
  audio?: TtsStream | null;
  meta?: {
    escalation?: boolean;
    sceneChange?: { fromSceneId: string; toSceneId: string };
    diceReceipt?: {
      formula: string;
      result: number;
      rollMode?: "public" | "gm" | "blind" | "whisperTo";
      whisperTo?: ReadonlyArray<string>;
    };
    handout?: { journalRef: string; recipients: ReadonlyArray<string> };
    /** Inline reply target (Foundry user id) — command-parse errors. */
    replyTo?: string;
  };
}

export interface OutboundSurface {
  readonly name: string;
  readonly handles: ReadonlyArray<Audience["kind"]>;
  /**
   * Voice narration is not timeout-bounded by the router (TDD 0034 open
   * questions — its budget IS the voice round-trip).
   */
  readonly unboundedEmit?: boolean;
  emit(output: SurfaceOutput): Promise<void>;
}

export interface InboundSurface {
  readonly name: string;
  events(): AsyncIterable<SurfaceInputEvent>;
}

export function isOutboundSurface(
  surface: OutboundSurface | InboundSurface,
): surface is OutboundSurface {
  return "emit" in surface && typeof surface.emit === "function" && "handles" in surface;
}

export function isInboundSurface(
  surface: OutboundSurface | InboundSurface,
): surface is InboundSurface {
  return "events" in surface && typeof surface.events === "function";
}
