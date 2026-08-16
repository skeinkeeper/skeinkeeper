// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { AnalyticsClient } from "@skeinkeeper/telemetry";

export type Unsubscribe = () => void;

export type Coords = { x: number; y: number };
export type ActorRef = string;
export type ActorState = Record<string, unknown>;

export type FoundryEvent =
  | { type: "scene-activated"; sceneId: string; activatedBy?: "ai" | "operator" }
  | { type: "token-moved"; tokenId: string; from: Coords; to: Coords; movedBy?: ActorRef }
  | { type: "combat-started"; combatId: string; sceneId: string }
  | { type: "combat-ended"; combatId: string }
  | { type: "combat-turn"; combatId: string; combatantId: string }
  | { type: "actor-updated"; actorId: string; patch: Partial<ActorState> }
  | { type: "journal-accessed"; journalId: string; byUserId?: string };

export interface FoundryEventStream {
  subscribe(handler: (event: FoundryEvent) => void): Unsubscribe;
}

export type PerceptionKind = "null" | "mock" | "real";

/** Production default — TDD 0041 evt is not wired yet. */
export class NullFoundryEventStream implements FoundryEventStream {
  subscribe(_handler: (event: FoundryEvent) => void): Unsubscribe {
    return () => {};
  }
}

/** Test-only stream; emit() delivers a scripted sequence. */
export class MockFoundryEventStream implements FoundryEventStream {
  private readonly handlers = new Set<(event: FoundryEvent) => void>();
  readonly ignored: unknown[] = [];
  readonly logs: string[] = [];

  subscribe(handler: (event: FoundryEvent) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(event: FoundryEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  ingest(raw: unknown): void {
    const parsed = parseFoundryEvent(raw, (msg) => this.logs.push(msg));
    if (parsed === undefined) {
      this.ignored.push(raw);
      return;
    }
    this.emit(parsed);
  }
}

/**
 * Typed seam over TDD 0041 `evt` frames (`scene` / `token` / `combat` /
 * `actor` / `journal`). No WebSocket gateway is invented here.
 */
export function liveAddonEventStream(source: {
  onFrame: (handler: (frame: unknown) => void) => Unsubscribe;
}): FoundryEventStream {
  return {
    subscribe(handler) {
      return source.onFrame((frame) => {
        const event = parseFoundryEvent(frame);
        if (event !== undefined) handler(event);
      });
    },
  };
}

export function parseFoundryEvent(
  raw: unknown,
  onLog?: (message: string) => void,
): FoundryEvent | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  if (isFoundryEvent(rec)) return rec;
  if (rec["type"] === "evt" && typeof rec["event"] === "string") {
    const mapped = mapAddonEvt(rec["event"], rec["payload"]);
    if (mapped !== undefined) return mapped;
    onLog?.(`unknown Foundry event type ignored: ${rec["event"]}`);
    return undefined;
  }
  onLog?.("unknown Foundry event type ignored");
  return undefined;
}

function isFoundryEvent(rec: Record<string, unknown>): rec is FoundryEvent {
  const t = rec["type"];
  return (
    t === "scene-activated" ||
    t === "token-moved" ||
    t === "combat-started" ||
    t === "combat-ended" ||
    t === "combat-turn" ||
    t === "actor-updated" ||
    t === "journal-accessed"
  );
}

function mapAddonEvt(kind: string, payload: unknown): FoundryEvent | undefined {
  const p =
    payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const str = (k: string): string | undefined =>
    typeof p[k] === "string" ? (p[k] as string) : undefined;
  switch (kind) {
    case "scene": {
      const sceneId = str("sceneId");
      if (sceneId === undefined) return undefined;
      const activatedBy = p["activatedBy"];
      return activatedBy === "ai" || activatedBy === "operator"
        ? { type: "scene-activated", sceneId, activatedBy }
        : { type: "scene-activated", sceneId };
    }
    case "token": {
      const tokenId = str("tokenId");
      const from = asCoords(p["from"]);
      const to = asCoords(p["to"]);
      if (tokenId === undefined || from === undefined || to === undefined) return undefined;
      const movedBy = str("movedBy");
      return movedBy !== undefined
        ? { type: "token-moved", tokenId, from, to, movedBy }
        : { type: "token-moved", tokenId, from, to };
    }
    case "combat": {
      const combatId = str("combatId") ?? "";
      const action = str("action") ?? str("kind");
      if (action === "ended" || action === "end") return { type: "combat-ended", combatId };
      if (action === "turn" || action === "combat-turn") {
        return { type: "combat-turn", combatId, combatantId: str("combatantId") ?? "" };
      }
      return { type: "combat-started", combatId, sceneId: str("sceneId") ?? "" };
    }
    case "actor": {
      const actorId = str("actorId");
      if (actorId === undefined) return undefined;
      const patch =
        p["patch"] !== null && typeof p["patch"] === "object"
          ? (p["patch"] as Partial<ActorState>)
          : {};
      return { type: "actor-updated", actorId, patch };
    }
    case "journal": {
      const journalId = str("journalId");
      if (journalId === undefined) return undefined;
      const byUserId = str("byUserId");
      return byUserId !== undefined
        ? { type: "journal-accessed", journalId, byUserId }
        : { type: "journal-accessed", journalId };
    }
    default:
      return undefined;
  }
}

function asCoords(value: unknown): Coords | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec["x"] !== "number" || typeof rec["y"] !== "number") return undefined;
  return { x: rec["x"], y: rec["y"] };
}

export function wireFoundryEventStream(args: {
  stream: FoundryEventStream;
  campaignId: string;
  kind: PerceptionKind;
  isReady: () => boolean;
  onEvent: (event: FoundryEvent) => void;
  analytics?: AnalyticsClient;
}): { unsubscribe: Unsubscribe; flush: () => void } {
  const queue: FoundryEvent[] = [];
  args.analytics?.track("perception.event_stream.wired", {
    campaignId: args.campaignId,
    kind: args.kind,
  });
  const unsubscribe = args.stream.subscribe((event) => {
    if (!args.isReady()) {
      queue.push(event);
      return;
    }
    args.onEvent(event);
  });
  return {
    unsubscribe,
    flush: () => {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next !== undefined) args.onEvent(next);
      }
    },
  };
}

export interface PerceptionBuffer {
  kind: PerceptionKind;
  noticed: boolean;
  events: FoundryEvent[];
}

/** Behaviors that depend on live perception call this; notice is once per session. */
export function takePerceptionEvents(
  state: PerceptionBuffer,
  onNotice?: (message: string) => void,
): FoundryEvent[] {
  if (state.kind === "null") {
    if (!state.noticed) {
      state.noticed = true;
      onNotice?.("perception not yet available");
    }
    return [];
  }
  return state.events;
}
