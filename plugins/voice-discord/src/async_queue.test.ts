// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { AsyncQueue } from "./async_queue.js";

async function collect<T>(q: AsyncQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of q) out.push(item);
  return out;
}

describe("AsyncQueue", () => {
  it("yields items pushed before iteration, then closes", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    expect(await collect(q)).toEqual([1, 2]);
  });

  it("delivers items pushed after the consumer is waiting", async () => {
    const q = new AsyncQueue<string>();
    const collected = collect(q);
    q.push("a");
    q.push("b");
    q.close();
    expect(await collected).toEqual(["a", "b"]);
  });

  it("ignores pushes after close", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.close();
    q.push(2);
    expect(await collect(q)).toEqual([1]);
  });
});
