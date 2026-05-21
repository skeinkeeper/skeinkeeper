// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * A minimal FIFO async mutex — the single serialized writer behind design doc
 * 0026 §3. When the Coordinator runs the table loop alongside N concurrent 1:1
 * side-channels, every shared world-state mutation is funnelled through one
 * `Mutex` per campaign so two contexts never race the world. Reasoning stays
 * parallel; only the commit is serialized.
 *
 * FIFO by construction: each acquire chains onto the tail of a promise chain,
 * so callers are admitted in arrival order (no priority — side-channels are
 * read-mostly and write contention is rare).
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;

  /** Run `fn` with exclusive access; resolves/rejects with its result. The lock
   *  is released even if `fn` throws. */
  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(() => fn());
    // Keep the chain alive regardless of fn's outcome; swallow here so one
    // failed critical section can't reject every queued waiter.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.depth += 1;
    void this.tail.then(() => {
      this.depth -= 1;
    });
    return run;
  }

  /** Number of critical sections queued or running (for tests/telemetry). */
  get queueDepth(): number {
    return this.depth;
  }
}
