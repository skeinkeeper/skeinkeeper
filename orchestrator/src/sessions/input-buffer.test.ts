// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { PausedInputBuffer } from "./input-buffer.js";

describe("PausedInputBuffer", () => {
  it("drains pushed items in FIFO order", () => {
    const buffer = new PausedInputBuffer<string>();
    buffer.push("a");
    buffer.push("b");
    buffer.push("c");
    expect(buffer.size).toBe(3);
    expect(buffer.drain()).toEqual(["a", "b", "c"]);
    expect(buffer.size).toBe(0);
  });

  it("drops the oldest items past the bound and counts them", () => {
    const buffer = new PausedInputBuffer<number>({ maxSize: 3 });
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    buffer.push(4);
    expect(buffer.droppedCount).toBe(1);
    expect(buffer.drain()).toEqual([2, 3, 4]);
  });

  it("defaults the bound to 100 events", () => {
    const buffer = new PausedInputBuffer<number>();
    for (let i = 0; i < 105; i++) buffer.push(i);
    expect(buffer.size).toBe(100);
    expect(buffer.droppedCount).toBe(5);
    expect(buffer.drain()[0]).toBe(5);
  });

  it("resets the dropped counter on drain (per pause episode)", () => {
    const buffer = new PausedInputBuffer<number>({ maxSize: 1 });
    buffer.push(1);
    buffer.push(2);
    expect(buffer.droppedCount).toBe(1);
    buffer.drain();
    expect(buffer.droppedCount).toBe(0);
  });
});
