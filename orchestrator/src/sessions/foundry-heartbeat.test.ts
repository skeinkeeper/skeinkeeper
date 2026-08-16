// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { startFoundryHeartbeat } from "./foundry-heartbeat.js";

function makeLifecycleRecorder() {
  return {
    failures: [] as string[],
    successes: 0,
    reportHeartbeatFailure(error: string): void {
      this.failures.push(error);
    },
    reportHeartbeatSuccess(): void {
      this.successes += 1;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startFoundryHeartbeat", () => {
  it("reports a heartbeat success when listUsers resolves", async () => {
    const lifecycle = makeLifecycleRecorder();
    const heartbeat = startFoundryHeartbeat({
      client: { listUsers: async () => [] },
      lifecycle,
    });
    await heartbeat.tick();
    expect(lifecycle.successes).toBe(1);
    expect(lifecycle.failures).toEqual([]);
    heartbeat.stop();
  });

  it("reports a heartbeat failure with the error message when listUsers rejects", async () => {
    const lifecycle = makeLifecycleRecorder();
    const heartbeat = startFoundryHeartbeat({
      client: {
        listUsers: async () => {
          throw new Error("fake-connection-refused");
        },
      },
      lifecycle,
    });
    await heartbeat.tick();
    expect(lifecycle.failures).toEqual(["fake-connection-refused"]);
    heartbeat.stop();
  });

  it("runs on the interval and stops on stop()", async () => {
    vi.useFakeTimers();
    const lifecycle = makeLifecycleRecorder();
    let calls = 0;
    const heartbeat = startFoundryHeartbeat({
      client: {
        listUsers: async () => {
          calls += 1;
          return [];
        },
      },
      intervalMs: 30_000,
      lifecycle,
    });
    expect(calls).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toBe(2);
    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(calls).toBe(2);
  });
});
