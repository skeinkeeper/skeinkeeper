// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { randomInt } from "node:crypto";

export interface RollResult {
  total: number;
  /** Individual die faces rolled. Named `rolls` to match `FoundryClient`'s
   *  RollResult so the two roll vocabularies agree (the `roll` tool returns
   *  this shape regardless of which roller produced it). */
  rolls: number[];
  formula: string;
  modifier: number;
  advantage: boolean;
}

export interface RollOptions {
  advantage?: boolean;
  disadvantage?: boolean;
  /** Inclusive-min, inclusive-max RNG. Defaults to crypto. Injectable so the
   *  advantage/disadvantage selection is deterministically testable. */
  rng?: (min: number, max: number) => number;
}

/**
 * Minimal dice formula parser: NdM[+|-K] where N >= 1, M >= 2, K >= 0.
 * Examples: "1d20", "2d6+3", "1d20-1", "1d4".
 *
 * Interim local roller (Node crypto). The `roll` tool prefers the active VTT's
 * roller when available (so dice show in Foundry's chat log) and falls back to
 * this when the bridge can't roll server-side (design doc 0014 mutation gap).
 */
export function rollFormula(formula: string, opts: RollOptions = {}): RollResult {
  const match = formula.trim().match(/^(\d+)d(\d+)\s*([+-]\s*\d+)?$/i);
  if (!match) throw new Error(`Invalid dice formula: ${formula}`);
  const n = Number.parseInt(match[1]!, 10);
  const sides = Number.parseInt(match[2]!, 10);
  const modText = (match[3] ?? "").replace(/\s+/g, "");
  const modifier = modText ? Number.parseInt(modText, 10) : 0;
  if (n < 1) throw new Error("dice count must be >= 1");
  if (sides < 2) throw new Error("dice sides must be >= 2");

  const adv = opts.advantage === true && opts.disadvantage !== true;
  const dis = opts.disadvantage === true && opts.advantage !== true;
  const rng = opts.rng ?? ((min, max) => randomInt(min, max + 1));

  const roll = () => {
    const rolls: number[] = [];
    for (let i = 0; i < n; i++) rolls.push(rng(1, sides));
    return rolls;
  };

  let rolls = roll();
  if (adv || dis) {
    const other = roll();
    const sum1 = rolls.reduce((a, b) => a + b, 0);
    const sum2 = other.reduce((a, b) => a + b, 0);
    rolls = adv ? (sum1 >= sum2 ? rolls : other) : sum1 <= sum2 ? rolls : other;
  }
  const total = rolls.reduce((a, b) => a + b, modifier);
  return { total, rolls, formula, modifier, advantage: adv };
}
