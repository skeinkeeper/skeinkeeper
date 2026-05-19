// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { randomInt } from "node:crypto";

export interface RollResult {
  total: number;
  dice: number[];
  formula: string;
  modifier: number;
  advantage: boolean;
}

/**
 * Minimal dice formula parser: NdM[+|-K] where N >= 1, M >= 2, K >= 0.
 * Examples: "1d20", "2d6+3", "1d20-1", "1d4".
 *
 * Phase 3.2 replaces this with Foundry MCP's roll engine so dice are
 * visible in the Foundry chat log. Until then, server-side Node crypto.
 */
export function rollFormula(formula: string, opts: { advantage?: boolean; disadvantage?: boolean } = {}): RollResult {
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

  const roll = () => {
    const dice: number[] = [];
    for (let i = 0; i < n; i++) dice.push(randomInt(1, sides + 1));
    return dice;
  };

  let dice = roll();
  if (adv || dis) {
    const other = roll();
    const sum1 = dice.reduce((a, b) => a + b, 0);
    const sum2 = other.reduce((a, b) => a + b, 0);
    dice = adv ? (sum1 >= sum2 ? dice : other) : sum1 <= sum2 ? dice : other;
  }
  const total = dice.reduce((a, b) => a + b, modifier);
  return { total, dice, formula, modifier, advantage: adv };
}
