// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { FakeInboundSurface, FakeOutboundSurface } from "./fake.js";
import { NoHandlingSurfaceError, SurfaceRouter } from "./router.js";
import type { SurfaceInputEvent } from "./events.js";

function recordingAnalytics(): {
  analytics: { track: (n: string, p: unknown) => void; flush: () => Promise<void> };
  events: Array<{ name: string; props: Record<string, unknown> }>;
} {
  const events: Array<{ name: string; props: Record<string, unknown> }> = [];
  return {
    analytics: {
      track: (name, props) => events.push({ name, props: props as Record<string, unknown> }),
      flush: async () => {},
    },
    events,
  };
}

describe("SurfaceRouter fan-out", () => {
  it("routes each audience only to surfaces that handle it", async () => {
    const table = new FakeOutboundSurface("table-surface", ["table"]);
    const player = new FakeOutboundSurface("player-surface", ["player"]);
    const router = new SurfaceRouter();
    router.register(table);
    router.register(player);

    const tableReport = await router.emit({ audience: { kind: "table" }, text: "hi", audio: null });
    const playerReport = await router.emit({
      audience: { kind: "player", playerId: "p1" },
      text: "psst",
    });

    expect(table.emits).toHaveLength(1);
    expect(table.emits[0]?.text).toBe("hi");
    expect(player.emits).toHaveLength(1);
    expect(player.emits[0]?.text).toBe("psst");
    expect(tableReport.perSurface).toEqual([{ surface: "table-surface", status: "ok" }]);
    expect(tableReport.totalSurfaces).toBe(1);
    expect(playerReport.perSurface.map((p) => p.surface)).toEqual(["player-surface"]);
  });

  it("hard-errors when no registered surface handles the audience", async () => {
    const { analytics, events } = recordingAnalytics();
    const router = new SurfaceRouter({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake analytics
      analytics: analytics as any,
    });
    router.register(new FakeOutboundSurface("gm-only", ["gm"]));

    await expect(router.emit({ audience: { kind: "table" }, text: "..." })).rejects.toBeInstanceOf(
      NoHandlingSurfaceError,
    );
    await expect(router.emit({ audience: { kind: "table" }, text: "..." })).rejects.toThrow(
      /no surface for audience kind=table/,
    );

    expect(events.filter((e) => e.name === "surface.emit")).toHaveLength(0);
    const failed = events.filter((e) => e.name === "surface.emit.failed");
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0]?.props.reason).toBe("no-handling-surface");
    expect((failed[0]?.props.audience as { kind: string }).kind).toBe("table");
  });

  it("isolates per-surface emit failure and does not throw", async () => {
    const { analytics, events } = recordingAnalytics();
    const ok = new FakeOutboundSurface("ok-surface", ["table"]);
    const bad = new FakeOutboundSurface("bad-surface", ["table"]);
    bad.failWith = new Error("bridge timeout");
    const router = new SurfaceRouter({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake analytics
      analytics: analytics as any,
    });
    router.register(ok);
    router.register(bad);

    const report = await router.emit({ audience: { kind: "table" }, text: "x" });
    expect(report.totalSurfaces).toBe(2);
    expect(report.perSurface).toEqual(
      expect.arrayContaining([
        { surface: "ok-surface", status: "ok" },
        { surface: "bad-surface", status: "failed", error: "bridge timeout" },
      ]),
    );
    expect(ok.emits).toHaveLength(1);
    expect(events.some((e) => e.name === "surface.emit" && e.props.surface === "ok-surface")).toBe(
      true,
    );
    expect(
      events.some(
        (e) =>
          e.name === "surface.emit.failed" &&
          e.props.surface === "bad-surface" &&
          e.props.reason === "bridge timeout",
      ),
    ).toBe(true);
  });

  it("times out a slow surface without aborting the others", async () => {
    const { analytics, events } = recordingAnalytics();
    const slow = new FakeOutboundSurface("slow", ["table"]);
    slow.delayMs = 50;
    const fast = new FakeOutboundSurface("fast", ["table"]);
    const router = new SurfaceRouter({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake analytics
      analytics: analytics as any,
      emitTimeoutMs: 5,
    });
    router.register(slow);
    router.register(fast);

    const report = await router.emit({ audience: { kind: "table" }, text: "x" });
    expect(report.perSurface.find((p) => p.surface === "slow")?.status).toBe("failed");
    expect(report.perSurface.find((p) => p.surface === "slow")?.error).toBe("timeout");
    expect(report.perSurface.find((p) => p.surface === "fast")?.status).toBe("ok");
    expect(
      events.some((e) => e.name === "surface.emit.failed" && e.props.reason === "timeout"),
    ).toBe(true);
  });

  it("hashes player ids in emit telemetry and never includes the raw id", async () => {
    const { analytics, events } = recordingAnalytics();
    const player = new FakeOutboundSurface("whisper", ["player"]);
    const router = new SurfaceRouter({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake analytics
      analytics: analytics as any,
      hashPlayerId: (id) => `hash-${id.length}`,
    });
    router.register(player);
    await router.emit({ audience: { kind: "player", playerId: "discord-raw" }, text: "psst" });
    const ev = events.find((e) => e.name === "surface.emit");
    expect(ev?.props.audience).toEqual({ kind: "player", player: "hash-11" });
    expect(JSON.stringify(ev?.props)).not.toContain("discord-raw");
  });
});

describe("SurfaceRouter inbound multiplex", () => {
  it("yields events from every registered inbound surface", async () => {
    const { analytics, events } = recordingAnalytics();
    const a = new FakeInboundSurface("foundry-public");
    const b = new FakeInboundSurface("foundry-whisper");
    const router = new SurfaceRouter({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake analytics
      analytics: analytics as any,
    });
    router.register(a);
    router.register(b);

    const collected: SurfaceInputEvent[] = [];
    const consume = (async () => {
      for await (const ev of router.events()) collected.push(ev);
    })();

    a.push({
      kind: "chat.public",
      surface: "foundry-public",
      foundryUserId: "u1",
      text: "I look around.",
    });
    b.push({
      kind: "chat.whisper.player-to-dm",
      surface: "foundry-whisper",
      foundryUserId: "u2",
      text: "psst",
    });
    a.close();
    b.close();
    await consume;

    expect(collected.map((e) => e.kind).sort()).toEqual([
      "chat.public",
      "chat.whisper.player-to-dm",
    ]);
    expect(events.filter((e) => e.name === "surface.input")).toHaveLength(2);
    expect(events.map((e) => e.props.kind).sort()).toEqual([
      "chat.public",
      "chat.whisper.player-to-dm",
    ]);
  });
});
