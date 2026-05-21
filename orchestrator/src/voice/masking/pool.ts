// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { FillerSelector, type FillerSelectorOptions } from "./selector.js";
import type { Filler } from "./filler.js";

/**
 * The masking pool (design doc 0028 §P2): a `FillerSelector` plus background
 * top-up. `select` is instant (on the response path); `refill` is the slow,
 * off-path half — call it during lulls / while a real turn generates, guarded
 * so two refills don't overlap. Keeps the two halves (instant select vs. slow
 * generate) cleanly separated.
 */
export interface MaskingPoolOptions extends FillerSelectorOptions {
  /** Refill when the pool falls below this many fillers. Default 8. */
  lowWaterMark?: number;
}

export class MaskingPool {
  private readonly selector: FillerSelector;
  private readonly lowWaterMark: number;
  private refilling = false;

  constructor(opts: MaskingPoolOptions = {}) {
    this.selector = new FillerSelector(opts);
    this.lowWaterMark = opts.lowWaterMark ?? 8;
  }

  get size(): number {
    return this.selector.size;
  }

  add(fillers: ReadonlyArray<Filler>): void {
    this.selector.add(fillers);
  }

  /** Instant pick for the current scene tags (on the response path). */
  select(contextTags: ReadonlyArray<string>): Filler | null {
    return this.selector.select(contextTags);
  }

  /** Whether the pool has run low and should be topped up off-path. */
  needsRefill(): boolean {
    return this.selector.size < this.lowWaterMark;
  }

  /**
   * Top up off-path. No-op if a refill is already in flight (so repeated lull
   * triggers don't fan out concurrent generations). Best-effort: a failed
   * generate just leaves the pool as-is. Returns how many were added.
   */
  async refill(generate: () => Promise<ReadonlyArray<Filler>>): Promise<number> {
    if (this.refilling) return 0;
    this.refilling = true;
    try {
      const fillers = await generate();
      this.add(fillers);
      return fillers.length;
    } catch {
      return 0;
    } finally {
      this.refilling = false;
    }
  }
}
