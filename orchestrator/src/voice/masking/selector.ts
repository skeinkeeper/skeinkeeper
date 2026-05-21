// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { NEUTRAL_TAG, fillerId, fillerStem, type Filler } from "./filler.js";

/**
 * The anti-repeat filler selector (design doc 0028 §P2) — the heart of the
 * "don't become a meme" design. Pure + injectable RNG, fully unit-testable.
 *
 * Defenses, layered:
 *  1. **Tag match, fail-safe to neutral.** Prefer fillers matching the current
 *     scene tags; if none, fall back to `neutral` lines (never a wrong-context
 *     line); if none, anything.
 *  2. **Shuffle bag.** Draw without replacement — a line isn't repeated until
 *     the matching set is exhausted, then the bag resets.
 *  3. **Recency window.** Never pick a line used within the last N selections.
 *  4. **Stem histogram.** Among the freshest candidates, prefer the one whose
 *     opening *gesture* (stem) was used least in the recent window — so variety
 *     isn't just line-level. Naturally decays (it's a ring, not a cumulative
 *     count).
 *
 * Selection is the instant, on-critical-path half; generation (filling the
 * pool) is the slow, off-path half (see `generator.ts`).
 */
export interface FillerSelectorOptions {
  /** How many recent selections to avoid repeating. Default 12. */
  recencyWindow?: number;
  /** Injectable RNG (tie-breaks) for deterministic tests. Default Math.random. */
  rng?: () => number;
}

export class FillerSelector {
  private readonly pool = new Map<string, Filler>();
  private readonly usedThisCycle = new Set<string>();
  private readonly recentIds: string[] = [];
  private readonly recentStems: string[] = [];
  private readonly recencyWindow: number;
  private readonly rng: () => number;

  constructor(opts: FillerSelectorOptions = {}) {
    this.recencyWindow = opts.recencyWindow ?? 12;
    this.rng = opts.rng ?? Math.random;
  }

  get size(): number {
    return this.pool.size;
  }

  /** Add fillers to the pool (deduped by normalized text). */
  add(fillers: ReadonlyArray<Filler>): void {
    for (const f of fillers) {
      const text = f.text.trim();
      if (text.length === 0) continue;
      this.pool.set(fillerId(text), { text, tags: [...f.tags] });
    }
  }

  /**
   * Pick a filler for the current scene tags, or null if the pool is empty.
   * Applies the tag ladder → shuffle bag → recency → stem-histogram defenses.
   */
  select(contextTags: ReadonlyArray<string>): Filler | null {
    if (this.pool.size === 0) return null;

    const all = [...this.pool.entries()]; // [id, filler]
    const tagSet = new Set(contextTags);
    const tagged = all.filter(([, f]) => f.tags.some((t) => tagSet.has(t)));
    const neutral = all.filter(([, f]) => f.tags.includes(NEUTRAL_TAG));
    // Fail-safe ladder: scene match → neutral → anything.
    const candidates = tagged.length > 0 ? tagged : neutral.length > 0 ? neutral : all;

    // Shuffle bag + recency: prefer not-recent and not-yet-drawn-this-cycle.
    let fresh = candidates.filter(([id]) => !this.usedThisCycle.has(id) && !this.isRecent(id));
    if (fresh.length === 0) {
      this.usedThisCycle.clear(); // bag exhausted → new cycle
      fresh = candidates.filter(([id]) => !this.isRecent(id));
      if (fresh.length === 0) fresh = candidates; // tiny pool: recency can't be honored
    }

    // Stem histogram: prefer the least-recently-used opening gesture.
    let best = Infinity;
    for (const [, f] of fresh) best = Math.min(best, this.stemCost(f));
    const leastRepetitive = fresh.filter(([, f]) => this.stemCost(f) === best);

    const chosen = leastRepetitive[Math.floor(this.rng() * leastRepetitive.length)]!;
    this.record(chosen[0], chosen[1]);
    return chosen[1];
  }

  private isRecent(id: string): boolean {
    return this.recentIds.includes(id);
  }

  private stemCost(f: Filler): number {
    const stem = fillerStem(f.text);
    return this.recentStems.filter((s) => s === stem).length;
  }

  private record(id: string, f: Filler): void {
    this.usedThisCycle.add(id);
    this.recentIds.push(id);
    if (this.recentIds.length > this.recencyWindow) this.recentIds.shift();
    this.recentStems.push(fillerStem(f.text));
    if (this.recentStems.length > this.recencyWindow) this.recentStems.shift();
  }
}
