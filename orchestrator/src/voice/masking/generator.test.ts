// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { fakeLlmFromEvents } from "../../interfaces/index.js";
import { generateFillers, parseFillers } from "./generator.js";
import { MaskingPool } from "./pool.js";
import type { Filler } from "./filler.js";

describe("parseFillers", () => {
  it("parses the model's JSON object into valid fillers", () => {
    const raw = `Sure! {"fillers":[{"text":"Dust drifts down.","tags":["exploration"]},{"text":"A hush falls.","tags":["neutral","tension"]}]}`;
    expect(parseFillers(raw, 12)).toEqual([
      { text: "Dust drifts down.", tags: ["exploration"] },
      { text: "A hush falls.", tags: ["neutral", "tension"] },
    ]);
  });

  it("drops invalid tags and defaults to neutral when none survive", () => {
    const raw = `{"fillers":[{"text":"The wind shifts.","tags":["weather","bogus"]}]}`;
    expect(parseFillers(raw, 12)).toEqual([{ text: "The wind shifts.", tags: ["neutral"] }]);
  });

  it("drops empty / over-long / malformed entries and caps the count", () => {
    const raw = JSON.stringify({
      fillers: [
        { text: "ok one", tags: ["combat"] },
        { text: "   ", tags: ["combat"] }, // empty
        { text: "x".repeat(200), tags: ["combat"] }, // too long
        { notText: true }, // malformed
        { text: "ok two", tags: ["combat"] },
        { text: "ok three", tags: ["combat"] },
      ],
    });
    expect(parseFillers(raw, 2).map((f) => f.text)).toEqual(["ok one", "ok two"]);
  });

  it("returns [] for non-JSON or a missing fillers array", () => {
    expect(parseFillers("no json here", 5)).toEqual([]);
    expect(parseFillers('{"other":1}', 5)).toEqual([]);
  });
});

describe("generateFillers", () => {
  it("collects the model output and returns parsed fillers", async () => {
    const llm = fakeLlmFromEvents([
      {
        kind: "text_delta",
        text: '{"fillers":[{"text":"Torchlight gutters.","tags":["tension"]}]}',
      },
      { kind: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const out = await generateFillers(llm, { sceneTags: ["tension"], count: 4 });
    expect(out).toEqual([{ text: "Torchlight gutters.", tags: ["tension"] }]);
    // It asks the cheap orchestration tier (design doc 0028 §3 / §P2).
    expect(llm.receivedRequests[0]?.modelTier).toBe("orchestration");
  });

  it("returns [] (never throws) when the model errors", async () => {
    const llm = fakeLlmFromEvents([
      { kind: "error", error: { kind: "rate_limited", message: "slow down" } },
    ]);
    expect(await generateFillers(llm)).toEqual([]);
  });
});

describe("MaskingPool", () => {
  const some = (n: number): Filler[] =>
    Array.from({ length: n }, (_, i) => ({ text: `line ${i}`, tags: ["neutral"] }));

  it("needsRefill flips below the low-water mark; refill tops it up off-path", async () => {
    const pool = new MaskingPool({ lowWaterMark: 3 });
    expect(pool.needsRefill()).toBe(true); // empty
    expect(await pool.refill(async () => some(5))).toBe(5);
    expect(pool.size).toBe(5);
    expect(pool.needsRefill()).toBe(false);
  });

  it("does not run two refills concurrently", async () => {
    const pool = new MaskingPool({ lowWaterMark: 100 });
    let calls = 0;
    const slow = async (): Promise<Filler[]> => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return some(2);
    };
    const [a, b] = await Promise.all([pool.refill(slow), pool.refill(slow)]);
    expect(calls).toBe(1); // the second was a no-op while the first was in flight
    expect([a, b].sort()).toEqual([0, 2]);
  });

  it("select delegates to the selector", () => {
    const pool = new MaskingPool({ rng: () => 0 });
    pool.add([{ text: "blades ring", tags: ["combat"] }]);
    expect(pool.select(["combat"])?.text).toBe("blades ring");
    expect(new MaskingPool().select(["combat"])).toBeNull();
  });
});
