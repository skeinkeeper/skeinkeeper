// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { Mutex } from "./mutex.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("Mutex (the single serialized writer, design doc 0026 §3)", () => {
  it("runs critical sections one at a time, FIFO, even when they overlap in time", async () => {
    const m = new Mutex();
    const events: string[] = [];

    // Three sections started "concurrently"; the first sleeps longest. If they
    // were not serialized, the order would interleave by sleep time.
    const a = m.runExclusive(async () => {
      events.push("a:start");
      await tick(30);
      events.push("a:end");
    });
    const b = m.runExclusive(async () => {
      events.push("b:start");
      await tick(5);
      events.push("b:end");
    });
    const c = m.runExclusive(async () => {
      events.push("c:start");
      events.push("c:end");
    });

    await Promise.all([a, b, c]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("returns each section's value to its own caller", async () => {
    const m = new Mutex();
    const [x, y] = await Promise.all([
      m.runExclusive(async () => {
        await tick(10);
        return 1;
      }),
      m.runExclusive(() => 2),
    ]);
    expect([x, y]).toEqual([1, 2]);
  });

  it("a thrown section rejects only its caller; the queue keeps draining", async () => {
    const m = new Mutex();
    const order: string[] = [];

    const failing = m.runExclusive(async () => {
      order.push("boom");
      throw new Error("boom");
    });
    const after = m.runExclusive(() => {
      order.push("after");
      return "ok";
    });

    await expect(failing).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ok");
    expect(order).toEqual(["boom", "after"]);
  });
});
