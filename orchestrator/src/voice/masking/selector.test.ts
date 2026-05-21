// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { fillerStem } from "./filler.js";
import { FillerSelector } from "./selector.js";

/** Deterministic RNG: always pick the first of the tie-broken candidates. */
const pickFirst = () => 0;

describe("fillerStem", () => {
  it("takes the first content word, skipping leading stopwords", () => {
    expect(fillerStem("The DM strokes his beard.")).toBe("dm");
    expect(fillerStem("You hear the floor settle.")).toBe("hear");
    expect(fillerStem("Dust drifts in the torchlight.")).toBe("dust");
  });
});

describe("FillerSelector", () => {
  it("returns null on an empty pool", () => {
    expect(new FillerSelector().select(["combat"])).toBeNull();
  });

  it("never repeats a line until the matching set is exhausted (shuffle bag)", () => {
    const s = new FillerSelector({ recencyWindow: 0, rng: pickFirst });
    s.add([
      { text: "alpha one", tags: ["combat"] },
      { text: "bravo two", tags: ["combat"] },
      { text: "charlie three", tags: ["combat"] },
    ]);
    const first3 = [s.select(["combat"]), s.select(["combat"]), s.select(["combat"])].map(
      (f) => f?.text,
    );
    expect(new Set(first3).size).toBe(3); // all distinct before any repeat
    // 4th draw resets the bag and returns a valid line again.
    expect(first3).toContain(s.select(["combat"])?.text);
  });

  it("falls back to neutral lines when no scene tag matches (never wrong-context)", () => {
    const s = new FillerSelector({ rng: pickFirst });
    s.add([
      { text: "swords clash nearby", tags: ["combat"] },
      { text: "a calm settles", tags: ["neutral"] },
    ]);
    // No combat line is tagged "social", so it must pick the neutral one.
    expect(s.select(["social"])?.text).toBe("a calm settles");
  });

  it("prefers a scene-tag match over neutral", () => {
    const s = new FillerSelector({ rng: pickFirst });
    s.add([
      { text: "a calm settles", tags: ["neutral"] },
      { text: "blades ring out", tags: ["combat"] },
    ]);
    expect(s.select(["combat"])?.text).toBe("blades ring out");
  });

  it("down-weights a recently-used opening stem (variety beyond line level)", () => {
    const s = new FillerSelector({ recencyWindow: 8, rng: pickFirst });
    s.add([
      { text: "strokes his beard", tags: ["social"] },
      { text: "strokes his chin", tags: ["social"] },
      { text: "ponders the map", tags: ["social"] },
    ]);
    const a = s.select(["social"])?.text; // "strokes his beard" (rng=first)
    expect(a).toBe("strokes his beard");
    // Next pick must avoid the "strokes" stem → "ponders the map".
    expect(s.select(["social"])?.text).toBe("ponders the map");
  });

  it("avoids repeating within the recency window across calls", () => {
    const s = new FillerSelector({ recencyWindow: 2, rng: pickFirst });
    s.add([
      { text: "one", tags: ["neutral"] },
      { text: "two", tags: ["neutral"] },
      { text: "three", tags: ["neutral"] },
    ]);
    const seq = [
      s.select(["neutral"])?.text,
      s.select(["neutral"])?.text,
      s.select(["neutral"])?.text,
    ];
    // With a window of 2, no line repeats within any 2 consecutive picks.
    expect(seq[0]).not.toBe(seq[1]);
    expect(seq[1]).not.toBe(seq[2]);
  });

  it("dedupes by normalized text on add", () => {
    const s = new FillerSelector();
    s.add([
      { text: "Same Line.", tags: ["neutral"] },
      { text: "  same line. ", tags: ["combat"] },
    ]);
    expect(s.size).toBe(1);
  });
});
