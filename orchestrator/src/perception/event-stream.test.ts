// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it, vi } from "vitest";
import {
  MockFoundryEventStream,
  NullFoundryEventStream,
  liveAddonEventStream,
  parseFoundryEvent,
  takePerceptionEvents,
  wireFoundryEventStream,
  type FoundryEvent,
} from "./event-stream.js";

describe("parseFoundryEvent", () => {
  it("maps add-on evt frames to the closed FoundryEvent union", () => {
    expect(
      parseFoundryEvent({
        type: "evt",
        event: "scene",
        payload: { sceneId: "s1", activatedBy: "operator" },
      }),
    ).toEqual({ type: "scene-activated", sceneId: "s1", activatedBy: "operator" });
    expect(
      parseFoundryEvent({
        type: "evt",
        event: "token",
        payload: { tokenId: "t1", from: { x: 0, y: 0 }, to: { x: 1, y: 2 } },
      }),
    ).toEqual({
      type: "token-moved",
      tokenId: "t1",
      from: { x: 0, y: 0 },
      to: { x: 1, y: 2 },
    });
    expect(
      parseFoundryEvent({
        type: "evt",
        event: "combat",
        payload: { action: "started", combatId: "c1", sceneId: "s1" },
      }),
    ).toEqual({ type: "combat-started", combatId: "c1", sceneId: "s1" });
  });

  it("logs and ignores unknown event types", () => {
    const logs: string[] = [];
    expect(
      parseFoundryEvent({ type: "evt", event: "weather", payload: {} }, (m) => logs.push(m)),
    ).toBeUndefined();
    expect(logs.some((l) => /unknown/i.test(l))).toBe(true);
  });
});

describe("MockFoundryEventStream", () => {
  it("emits a scripted sequence in order", () => {
    const stream = new MockFoundryEventStream();
    const received: FoundryEvent[] = [];
    const unsub = stream.subscribe((e) => received.push(e));
    const seq: FoundryEvent[] = [
      { type: "combat-started", combatId: "c1", sceneId: "s1" },
      { type: "combat-turn", combatId: "c1", combatantId: "cb1" },
      { type: "combat-ended", combatId: "c1" },
    ];
    for (const ev of seq) stream.emit(ev);
    expect(received).toEqual(seq);
    unsub();
    stream.emit({ type: "combat-ended", combatId: "c2" });
    expect(received).toHaveLength(3);
  });
});

describe("NullFoundryEventStream", () => {
  it("subscribe is a no-op and never emits", () => {
    const stream = new NullFoundryEventStream();
    const received: FoundryEvent[] = [];
    const unsub = stream.subscribe((e) => received.push(e));
    unsub();
    expect(received).toEqual([]);
  });
});

describe("liveAddonEventStream", () => {
  it("is a typed seam over add-on evt frames", () => {
    const handlers: Array<(frame: unknown) => void> = [];
    const stream = liveAddonEventStream({
      onFrame: (handler) => {
        handlers.push(handler);
        return () => {
          const i = handlers.indexOf(handler);
          if (i >= 0) handlers.splice(i, 1);
        };
      },
    });
    const received: FoundryEvent[] = [];
    stream.subscribe((e) => received.push(e));
    handlers[0]?.({ type: "evt", event: "journal", payload: { journalId: "j1" } });
    handlers[0]?.({ type: "evt", event: "chat", payload: { text: "hi" } });
    expect(received).toEqual([{ type: "journal-accessed", journalId: "j1" }]);
  });
});

describe("wireFoundryEventStream", () => {
  it("queues events until the session-start barrier releases", () => {
    const stream = new MockFoundryEventStream();
    let ready = false;
    const received: FoundryEvent[] = [];
    const analytics = { track: vi.fn(), flush: vi.fn() };
    const wired = wireFoundryEventStream({
      stream,
      campaignId: "c1",
      kind: "mock",
      isReady: () => ready,
      onEvent: (e) => received.push(e),
      analytics,
    });
    stream.emit({ type: "scene-activated", sceneId: "s1" });
    expect(received).toEqual([]);
    ready = true;
    wired.flush();
    expect(received).toEqual([{ type: "scene-activated", sceneId: "s1" }]);
    expect(analytics.track).toHaveBeenCalledWith(
      "perception.event_stream.wired",
      expect.objectContaining({ campaignId: "c1", kind: "mock" }),
    );
  });
});

describe("takePerceptionEvents — null stream notice", () => {
  it("logs perception not yet available on first attempt only", () => {
    const notices: string[] = [];
    const state = { kind: "null" as const, noticed: false, events: [] as FoundryEvent[] };
    expect(takePerceptionEvents(state, (m) => notices.push(m))).toEqual([]);
    expect(takePerceptionEvents(state, (m) => notices.push(m))).toEqual([]);
    expect(notices).toEqual(["perception not yet available"]);
  });
});
