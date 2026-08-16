// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { AnalyticsClient } from "@skeinkeeper/telemetry";
import type { IdentityPreflightFinding } from "../intake/preflight-identity.js";
import { Mutex } from "../util/mutex.js";

/**
 * Foundry-down session lifecycle (design doc 0039). Two states, owned by the
 * Coordinator: `active` and `paused-foundry-down`. Three fused detector signals
 * drive the pause transition (add-on `evt gone`, `surface.emit.failed` storms,
 * heartbeat failures); only an operator-issued resume — through the
 * SessionManager write path — transitions back.
 */

export type ISO8601 = string;

export type Unsubscribe = () => void;

export type FoundryDownCause = "addon-gone" | "emit-failure" | "heartbeat-failure";

export type SessionLifecycleState =
  | { kind: "active" }
  | {
      kind: "paused-foundry-down";
      since: ISO8601;
      cause: FoundryDownCause;
      lastError: string;
    };

export type ResumeResult =
  | { kind: "ok" }
  | { kind: "preflight-failed"; findings: ReadonlyArray<IdentityPreflightFinding> }
  | { kind: "already-active" };

/** Outcome of the resume-side pre-flight re-run (TDD 0036 §3a). */
export interface LifecyclePreflightOutcome {
  status: "ok" | "critical-gaps" | "warnings-only";
  findings: ReadonlyArray<IdentityPreflightFinding>;
  /** Count of critical-severity findings, for the resume-failed telemetry. */
  criticalCount: number;
}

export interface LifecycleController {
  current(): SessionLifecycleState;
  onTransition(
    handler: (next: SessionLifecycleState, prev: SessionLifecycleState) => void,
  ): Unsubscribe;
  // Called by detectors; internal.
  reportAddonGone(error: string): void;
  reportEmitFailure(surface: string, error: string): void;
  reportEmitSuccess(surface: string): void;
  reportHeartbeatFailure(error: string): void;
  reportHeartbeatSuccess(): void;
  /** Foundry-side surface adapters report a short-circuited emit while paused.
   *  Coalesced: one `surface.emit.skipped` event per surface per pause episode. */
  noteEmitSkipped(surface: string, audienceKind: string): void;
  // Called by SessionManager.resume() (TDD 0025 / 0040 write path).
  requestResume(): Promise<ResumeResult>;
}

/** The read-only slice surface adapters and the dispatcher depend on. */
export type LifecycleStateReader = Pick<LifecycleController, "current">;

/** The slice Foundry-side surface adapters depend on (read + skip note). */
export type FoundrySurfaceLifecycleGate = Pick<LifecycleController, "current" | "noteEmitSkipped">;

export interface LifecycleControllerOptions {
  /** Re-runs the pre-flight verifier (TDD 0036 §3a) on resume. Resume proceeds
   *  unless the outcome is `critical-gaps`. */
  preflight: () => Promise<LifecyclePreflightOutcome>;
  /** Durable audit-log sink for the `session.paused` / `session.resumed` rows. */
  audit?: (
    eventType: "session.paused" | "session.resumed",
    payload: Record<string, unknown>,
  ) => void;
  analytics?: AnalyticsClient;
  /** Current buffered-input count, reported in `session.resumed`. */
  bufferedInputs?: () => number;
  /** Consecutive Foundry-surface emit failures that trigger a pause. Default 3. */
  emitFailureThreshold?: number;
  /** Sliding window for the emit-failure threshold. Default 30 000 ms. */
  emitFailureWindowMs?: number;
  /** Consecutive heartbeat failures that trigger a pause. Default 2. */
  heartbeatFailureThreshold?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_EMIT_FAILURE_THRESHOLD = 3;
const DEFAULT_EMIT_FAILURE_WINDOW_MS = 30_000;
const DEFAULT_HEARTBEAT_FAILURE_THRESHOLD = 2;

class SessionLifecycleController implements LifecycleController {
  private state: SessionLifecycleState = { kind: "active" };
  private readonly handlers = new Set<
    (next: SessionLifecycleState, prev: SessionLifecycleState) => void
  >();
  /** Timestamps of consecutive emit failures (reset on any emit success). */
  private emitFailureTimes: number[] = [];
  private consecutiveHeartbeatFailures = 0;
  private pausedAtMs = 0;
  /** Episode key (the paused state's `since`) per surface, for skip coalescing. */
  private readonly skippedEpisodeBySurface = new Map<string, string>();
  private readonly resumeSerializer = new Mutex();
  private readonly now: () => number;

  constructor(private readonly opts: LifecycleControllerOptions) {
    this.now = opts.now ?? Date.now;
  }

  current(): SessionLifecycleState {
    return this.state;
  }

  onTransition(
    handler: (next: SessionLifecycleState, prev: SessionLifecycleState) => void,
  ): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  reportAddonGone(error: string): void {
    // Signal (a): one `gone` is enough (design doc 0039 §2a).
    this.pause("addon-gone", error, 1);
  }

  reportEmitFailure(_surface: string, error: string): void {
    if (this.state.kind !== "active") return; // absorbed while paused
    const now = this.now();
    const windowMs = this.opts.emitFailureWindowMs ?? DEFAULT_EMIT_FAILURE_WINDOW_MS;
    this.emitFailureTimes.push(now);
    this.emitFailureTimes = this.emitFailureTimes.filter((t) => now - t <= windowMs);
    const threshold = this.opts.emitFailureThreshold ?? DEFAULT_EMIT_FAILURE_THRESHOLD;
    if (this.emitFailureTimes.length >= threshold) {
      this.pause("emit-failure", error, this.emitFailureTimes.length);
    }
  }

  reportEmitSuccess(_surface: string): void {
    // A success breaks the "consecutive" run (design doc 0039 §2b).
    this.emitFailureTimes = [];
  }

  reportHeartbeatFailure(error: string): void {
    if (this.state.kind !== "active") return; // absorbed while paused
    this.consecutiveHeartbeatFailures += 1;
    this.opts.analytics?.track("foundry.heartbeat.failed", {
      consecutiveFailures: this.consecutiveHeartbeatFailures,
      reason: error,
    });
    const threshold = this.opts.heartbeatFailureThreshold ?? DEFAULT_HEARTBEAT_FAILURE_THRESHOLD;
    if (this.consecutiveHeartbeatFailures >= threshold) {
      this.pause("heartbeat-failure", error, this.consecutiveHeartbeatFailures);
    }
  }

  reportHeartbeatSuccess(): void {
    this.consecutiveHeartbeatFailures = 0;
  }

  noteEmitSkipped(surface: string, audienceKind: string): void {
    const state = this.state;
    if (state.kind !== "paused-foundry-down") return;
    if (this.skippedEpisodeBySurface.get(surface) === state.since) return;
    this.skippedEpisodeBySurface.set(surface, state.since);
    this.opts.analytics?.track("surface.emit.skipped", {
      surface,
      audienceKind,
      lifecycleState: state.kind,
    });
  }

  async requestResume(): Promise<ResumeResult> {
    // Serialized so near-simultaneous resumes can't race: the first wins, the
    // second observes `active` (design doc 0039 §"Failure modes").
    return this.resumeSerializer.runExclusive(async () => {
      if (this.state.kind === "active") return { kind: "already-active" };
      const pausedDurationMs = this.now() - this.pausedAtMs;
      const outcome = await this.opts.preflight();
      if (outcome.status === "critical-gaps") {
        this.opts.analytics?.track("session.resume_failed", {
          pausedDurationMs,
          preflightCriticalCount: outcome.criticalCount,
        });
        return { kind: "preflight-failed", findings: outcome.findings };
      }
      const bufferedInputs = this.opts.bufferedInputs?.() ?? 0;
      const prev = this.state;
      this.state = { kind: "active" };
      this.emitFailureTimes = [];
      this.consecutiveHeartbeatFailures = 0;
      this.opts.audit?.("session.resumed", { pausedDurationMs, bufferedInputs });
      this.opts.analytics?.track("session.resumed", {
        pausedDurationMs,
        bufferedInputs,
        preflightStatus: outcome.status,
      });
      this.fire(this.state, prev);
      return { kind: "ok" };
    });
  }

  /** One-shot per pause episode; subsequent failures while paused are absorbed. */
  private pause(cause: FoundryDownCause, lastError: string, consecutiveFailureCount: number): void {
    if (this.state.kind !== "active") return;
    const prev = this.state;
    this.pausedAtMs = this.now();
    this.state = {
      kind: "paused-foundry-down",
      since: new Date(this.pausedAtMs).toISOString(),
      cause,
      lastError,
    };
    this.opts.audit?.("session.paused", { cause, lastError });
    this.opts.analytics?.track("session.paused", { cause, consecutiveFailureCount });
    this.fire(this.state, prev);
  }

  private fire(next: SessionLifecycleState, prev: SessionLifecycleState): void {
    for (const handler of this.handlers) handler(next, prev);
  }
}

export function createLifecycleController(opts: LifecycleControllerOptions): LifecycleController {
  return new SessionLifecycleController(opts);
}
