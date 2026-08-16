// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Bounded queue for inputs captured while the session is paused
 * (design doc 0039 §3 step 2). Max 100 events by default; older events are
 * dropped and counted so the drop shows up in the resume telemetry.
 */

export interface PausedInputBufferOptions {
  /** Maximum buffered events; older events are dropped past this. Default 100. */
  maxSize?: number;
}

const DEFAULT_MAX_SIZE = 100;

export class PausedInputBuffer<T> {
  private items: T[] = [];
  private dropped = 0;
  private readonly maxSize: number;

  constructor(opts: PausedInputBufferOptions = {}) {
    this.maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;
  }

  push(item: T): void {
    this.items.push(item);
    while (this.items.length > this.maxSize) {
      this.items.shift();
      this.dropped += 1;
    }
  }

  get size(): number {
    return this.items.length;
  }

  /** Events dropped past the bound since the last drain (one pause episode). */
  get droppedCount(): number {
    return this.dropped;
  }

  /** Take and clear all buffered items (called on resume), in arrival order. */
  drain(): T[] {
    const out = this.items;
    this.items = [];
    this.dropped = 0;
    return out;
  }
}
