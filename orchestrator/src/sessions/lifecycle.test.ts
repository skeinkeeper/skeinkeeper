// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it, vi } from "vitest";
import type { AnalyticsClient } from "@skeinkeeper/telemetry";
import type { IdentityPreflightFinding } from "../intake/preflight-identity.js";
import {
  createLifecycleController,
  type LifecyclePreflightOutcome,
  type SessionLifecycleState,
} from "./lifecycle.js";

class RecordingAnalytics implements AnalyticsClient {
  readonly events: Array<{ name: string; props: Record<string, unknown> }> = [];
  track(name: string, props: unknown): void {
    this.events.push({ name, props: props as Record<string, unknown> });
  }
  async flush(): Promise<void> {
    // nothing buffered
  }
}

function named(analytics: RecordingAnalytics, name: string) {
  return analytics.events.filter((e) => e.name === name);
}

function setup(preflightOutcome?: LifecyclePreflightOutcome) {
  const analytics = new RecordingAnalytics();
  const audits: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  let nowMs = 1_000_000;
  const preflight = vi.fn(
    async (): Promise<LifecyclePreflightOutcome> =>
      preflightOutcome ?? { status: "ok", findings: [], criticalCount: 0 },
  );
  const transitions: Array<{ next: SessionLifecycleState; prev: SessionLifecycleState }> = [];
  const controller = createLifecycleController({
    preflight,
    analytics,
    audit: (eventType, payload) => audits.push({ eventType, payload }),
    bufferedInputs: () => 5,
    now: () => nowMs,
  });
  controller.onTransition((next, prev) => transitions.push({ next, prev }));
  return {
    controller,
    analytics,
    audits,
    preflight,
    transitions,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("SessionLifecycleState machine", () => {
  it("starts active", () => {
    const { controller } = setup();
    expect(controller.current()).toEqual({ kind: "active" });
  });

  it("transitions on the third consecutive emit failure within the window", () => {
    const { controller, transitions } = setup();
    controller.reportEmitFailure("foundry-public", "timeout");
    controller.reportEmitFailure("foundry-gm", "timeout");
    expect(controller.current().kind).toBe("active");
    controller.reportEmitFailure("foundry-whisper", "timeout");
    const state = controller.current();
    expect(state.kind).toBe("paused-foundry-down");
    if (state.kind === "paused-foundry-down") {
      expect(state.cause).toBe("emit-failure");
      expect(state.lastError).toBe("timeout");
    }
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.prev.kind).toBe("active");
  });

  it("an emit success resets the consecutive-failure count", () => {
    const { controller } = setup();
    controller.reportEmitFailure("foundry-public", "timeout");
    controller.reportEmitFailure("foundry-public", "timeout");
    controller.reportEmitSuccess("foundry-public");
    controller.reportEmitFailure("foundry-public", "timeout");
    controller.reportEmitFailure("foundry-public", "timeout");
    expect(controller.current().kind).toBe("active");
    controller.reportEmitFailure("foundry-public", "timeout");
    expect(controller.current().kind).toBe("paused-foundry-down");
  });

  it("emit failures outside the 30s window do not count toward the threshold", () => {
    const { controller, advance } = setup();
    controller.reportEmitFailure("foundry-public", "timeout");
    advance(31_000);
    controller.reportEmitFailure("foundry-public", "timeout");
    controller.reportEmitFailure("foundry-public", "timeout");
    expect(controller.current().kind).toBe("active");
    controller.reportEmitFailure("foundry-public", "timeout");
    expect(controller.current().kind).toBe("paused-foundry-down");
  });

  it("transitions on the second consecutive heartbeat failure", () => {
    const { controller } = setup();
    controller.reportHeartbeatFailure("connect refused");
    expect(controller.current().kind).toBe("active");
    controller.reportHeartbeatFailure("connect refused");
    const state = controller.current();
    expect(state.kind).toBe("paused-foundry-down");
    if (state.kind === "paused-foundry-down") expect(state.cause).toBe("heartbeat-failure");
  });

  it("a heartbeat success resets the consecutive-failure count", () => {
    const { controller } = setup();
    controller.reportHeartbeatFailure("x");
    controller.reportHeartbeatSuccess();
    controller.reportHeartbeatFailure("x");
    expect(controller.current().kind).toBe("active");
  });

  it("emits foundry.heartbeat.failed telemetry with the run length while active", () => {
    const { controller, analytics } = setup();
    controller.reportHeartbeatFailure("boom");
    expect(named(analytics, "foundry.heartbeat.failed")).toEqual([
      { name: "foundry.heartbeat.failed", props: { consecutiveFailures: 1, reason: "boom" } },
    ]);
  });

  it("a single addon-gone report pauses immediately", () => {
    const { controller } = setup();
    controller.reportAddonGone("socket closed");
    const state = controller.current();
    expect(state.kind).toBe("paused-foundry-down");
    if (state.kind === "paused-foundry-down") {
      expect(state.cause).toBe("addon-gone");
      expect(state.lastError).toBe("socket closed");
    }
  });

  it("absorbs further failure reports while paused (one-shot per episode)", () => {
    const { controller, transitions, analytics } = setup();
    controller.reportAddonGone("socket closed");
    controller.reportEmitFailure("foundry-public", "later");
    controller.reportEmitFailure("foundry-public", "later");
    controller.reportEmitFailure("foundry-public", "later");
    controller.reportHeartbeatFailure("later");
    controller.reportHeartbeatFailure("later");
    controller.reportAddonGone("again");
    expect(transitions).toHaveLength(1);
    expect(named(analytics, "session.paused")).toHaveLength(1);
    expect(named(analytics, "foundry.heartbeat.failed")).toHaveLength(0);
    const state = controller.current();
    if (state.kind === "paused-foundry-down") expect(state.lastError).toBe("socket closed");
  });

  it("records session.paused in the audit log and telemetry with the cause", () => {
    const { controller, audits, analytics } = setup();
    controller.reportEmitFailure("foundry-public", "timeout");
    controller.reportEmitFailure("foundry-public", "timeout");
    controller.reportEmitFailure("foundry-public", "timeout");
    expect(audits).toEqual([
      {
        eventType: "session.paused",
        payload: { cause: "emit-failure", lastError: "timeout" },
      },
    ]);
    expect(named(analytics, "session.paused")).toEqual([
      { name: "session.paused", props: { cause: "emit-failure", consecutiveFailureCount: 3 } },
    ]);
  });
});

describe("requestResume", () => {
  it("returns already-active when the session is active", async () => {
    const { controller, preflight } = setup();
    await expect(controller.requestResume()).resolves.toEqual({ kind: "already-active" });
    expect(preflight).not.toHaveBeenCalled();
  });

  it("re-runs the pre-flight verifier and transitions to active on ok", async () => {
    const { controller, preflight, transitions, audits, analytics, advance } = setup();
    controller.reportAddonGone("socket closed");
    advance(150);
    const result = await controller.requestResume();
    expect(result).toEqual({ kind: "ok" });
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(controller.current()).toEqual({ kind: "active" });
    expect(transitions).toHaveLength(2);
    const resumed = audits.find((a) => a.eventType === "session.resumed");
    expect(resumed?.payload["pausedDurationMs"]).toBe(150);
    expect(resumed?.payload["bufferedInputs"]).toBe(5);
    expect(named(analytics, "session.resumed")).toEqual([
      {
        name: "session.resumed",
        props: { pausedDurationMs: 150, bufferedInputs: 5, preflightStatus: "ok" },
      },
    ]);
  });

  it("stays paused and returns the findings on critical-gaps", async () => {
    const findings: IdentityPreflightFinding[] = [{ kind: "bridge-listusers-unavailable" }];
    const { controller, analytics, advance } = setup({
      status: "critical-gaps",
      findings,
      criticalCount: 1,
    });
    controller.reportAddonGone("socket closed");
    advance(200);
    const result = await controller.requestResume();
    expect(result).toEqual({ kind: "preflight-failed", findings });
    expect(controller.current().kind).toBe("paused-foundry-down");
    expect(named(analytics, "session.resume_failed")).toEqual([
      {
        name: "session.resume_failed",
        props: { pausedDurationMs: 200, preflightCriticalCount: 1 },
      },
    ]);
  });

  it("resumes on warnings-only pre-flight findings", async () => {
    const { controller } = setup({
      status: "warnings-only",
      findings: [{ kind: "extra-foundry-users-not-mapped", foundryUserIds: ["fake-u1"] }],
      criticalCount: 0,
    });
    controller.reportAddonGone("socket closed");
    await expect(controller.requestResume()).resolves.toEqual({ kind: "ok" });
    expect(controller.current().kind).toBe("active");
  });

  it("serializes near-simultaneous resumes: first wins, second sees already-active", async () => {
    const { controller } = setup();
    controller.reportAddonGone("socket closed");
    const [first, second] = await Promise.all([
      controller.requestResume(),
      controller.requestResume(),
    ]);
    expect(first).toEqual({ kind: "ok" });
    expect(second).toEqual({ kind: "already-active" });
  });

  it("a new pause episode after a resume transitions again", async () => {
    const { controller, transitions } = setup();
    controller.reportAddonGone("first");
    await controller.requestResume();
    controller.reportEmitFailure("foundry-public", "e");
    controller.reportEmitFailure("foundry-public", "e");
    controller.reportEmitFailure("foundry-public", "e");
    expect(controller.current().kind).toBe("paused-foundry-down");
    expect(transitions).toHaveLength(3);
  });
});

describe("noteEmitSkipped coalescing", () => {
  it("fires surface.emit.skipped once per surface per pause episode", async () => {
    const { controller, analytics, advance } = setup();
    controller.reportAddonGone("gone");
    controller.noteEmitSkipped("foundry-public", "table");
    controller.noteEmitSkipped("foundry-public", "table");
    controller.noteEmitSkipped("foundry-gm", "gm");
    expect(named(analytics, "surface.emit.skipped")).toEqual([
      {
        name: "surface.emit.skipped",
        props: {
          surface: "foundry-public",
          audienceKind: "table",
          lifecycleState: "paused-foundry-down",
        },
      },
      {
        name: "surface.emit.skipped",
        props: { surface: "foundry-gm", audienceKind: "gm", lifecycleState: "paused-foundry-down" },
      },
    ]);
    await controller.requestResume();
    advance(1);
    controller.reportAddonGone("gone again");
    controller.noteEmitSkipped("foundry-public", "table");
    expect(named(analytics, "surface.emit.skipped")).toHaveLength(3);
  });

  it("is a no-op while active", () => {
    const { controller, analytics } = setup();
    controller.noteEmitSkipped("foundry-public", "table");
    expect(named(analytics, "surface.emit.skipped")).toHaveLength(0);
  });
});
