// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { FoundryClient } from "../foundry/client.js";
import type { LifecycleController } from "./lifecycle.js";

/**
 * Periodic Foundry heartbeat (design doc 0039 §2c). Calls
 * `FoundryClient.listUsers()` on an interval and reports the outcome to the
 * lifecycle controller, which applies the consecutive-failure threshold. The
 * safety net for silent failures during a quiet session — `evt gone` and emit
 * failures are the load-bearing signals.
 */

export const FOUNDRY_HEARTBEAT_INTERVAL_MS = 30_000;

export interface FoundryHeartbeat {
  stop(): void;
  /** One heartbeat probe now (also what the interval runs). Exposed for tests. */
  tick(): Promise<void>;
}

export function startFoundryHeartbeat(args: {
  client: Pick<FoundryClient, "listUsers">;
  /** Default 30 000 ms. */
  intervalMs?: number;
  lifecycle: Pick<LifecycleController, "reportHeartbeatFailure" | "reportHeartbeatSuccess">;
}): FoundryHeartbeat {
  const tick = async (): Promise<void> => {
    try {
      await args.client.listUsers();
      args.lifecycle.reportHeartbeatSuccess();
    } catch (err) {
      args.lifecycle.reportHeartbeatFailure(err instanceof Error ? err.message : String(err));
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, args.intervalMs ?? FOUNDRY_HEARTBEAT_INTERVAL_MS);
  // Don't hold the process open for the heartbeat alone.
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    tick,
  };
}
