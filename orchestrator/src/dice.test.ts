// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { rollFormula } from "./dice.js";

describe("rollFormula — parsing & bounds", () => {
  it("rolls a single die within bounds and applies a positive modifier", () => {
    for (let i = 0; i < 50; i++) {
      const r = rollFormula("1d20+3");
      expect(r.rolls).toHaveLength(1);
      expect(r.rolls[0]!).toBeGreaterThanOrEqual(1);
      expect(r.rolls[0]!).toBeLessThanOrEqual(20);
      expect(r.modifier).toBe(3);
      expect(r.total).toBe(r.rolls[0]! + 3);
    }
  });

  it("rolls multiple dice and sums them with the modifier", () => {
    for (let i = 0; i < 50; i++) {
      const r = rollFormula("2d6");
      expect(r.rolls).toHaveLength(2);
      for (const d of r.rolls) {
        expect(d).toBeGreaterThanOrEqual(1);
        expect(d).toBeLessThanOrEqual(6);
      }
      expect(r.total).toBe(r.rolls[0]! + r.rolls[1]!);
      expect(r.total).toBeGreaterThanOrEqual(2);
      expect(r.total).toBeLessThanOrEqual(12);
    }
  });

  it("applies a negative modifier", () => {
    const r = rollFormula("1d20-1", { rng: () => 10 });
    expect(r.modifier).toBe(-1);
    expect(r.total).toBe(9);
  });

  it("tolerates whitespace around the modifier", () => {
    const r = rollFormula("2d6 + 4", { rng: () => 3 });
    expect(r.total).toBe(3 + 3 + 4);
  });

  it("rejects malformed formulas and out-of-range dice", () => {
    expect(() => rollFormula("garbage")).toThrow(/Invalid dice formula/);
    expect(() => rollFormula("0d6")).toThrow(/count must be >= 1/);
    expect(() => rollFormula("1d1")).toThrow(/sides must be >= 2/);
  });
});

describe("rollFormula — advantage / disadvantage selection", () => {
  // Deterministic RNG: returns a queued sequence so we control both rolls.
  function seq(values: number[]): () => number {
    let i = 0;
    return () => values[i++ % values.length]!;
  }

  it("advantage keeps the higher of two rolls", () => {
    // First roll = 5, second roll = 18 → advantage should pick 18.
    const r = rollFormula("1d20", { advantage: true, rng: seq([5, 18]) });
    expect(r.advantage).toBe(true);
    expect(r.total).toBe(18);
  });

  it("disadvantage keeps the lower of two rolls", () => {
    // First roll = 5, second roll = 18 → disadvantage should pick 5.
    const r = rollFormula("1d20", { disadvantage: true, rng: seq([5, 18]) });
    expect(r.advantage).toBe(false);
    expect(r.total).toBe(5);
  });

  it("advantage and disadvantage cancel out (neither flag wins → single roll)", () => {
    const r = rollFormula("1d20", { advantage: true, disadvantage: true, rng: seq([7, 19]) });
    expect(r.advantage).toBe(false);
    // Only one roll is taken (the first), no second-roll comparison.
    expect(r.total).toBe(7);
  });
});
