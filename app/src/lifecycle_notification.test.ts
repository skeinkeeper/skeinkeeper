// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import type { SessionLifecycleState } from "@skeinkeeper/orchestrator";
import { formatPauseDm, shouldSendPauseDm } from "./lifecycle_notification.js";

const PAUSED: SessionLifecycleState = {
  kind: "paused-foundry-down",
  since: "2026-01-01T00:00:00.000Z",
  cause: "addon-gone",
  lastError: "socket closed",
};

describe("shouldSendPauseDm", () => {
  it("sends when the operator is known and DM-consented, once per episode", () => {
    const first = shouldSendPauseDm({
      state: PAUSED,
      operatorUserId: "fake-op",
      dmConsented: true,
      lastNotifiedEpisode: null,
    });
    expect(first).toEqual({ send: true, episode: "2026-01-01T00:00:00.000Z" });
    const repeat = shouldSendPauseDm({
      state: PAUSED,
      operatorUserId: "fake-op",
      dmConsented: true,
      lastNotifiedEpisode: "2026-01-01T00:00:00.000Z",
    });
    expect(repeat).toEqual({ send: false });
  });

  it("does not send without operator DM consent", () => {
    expect(
      shouldSendPauseDm({
        state: PAUSED,
        operatorUserId: "fake-op",
        dmConsented: false,
        lastNotifiedEpisode: null,
      }),
    ).toEqual({ send: false });
  });

  it("does not send when no operator is designated", () => {
    expect(
      shouldSendPauseDm({
        state: PAUSED,
        operatorUserId: undefined,
        dmConsented: true,
        lastNotifiedEpisode: null,
      }),
    ).toEqual({ send: false });
  });

  it("does not send while active", () => {
    expect(
      shouldSendPauseDm({
        state: { kind: "active" },
        operatorUserId: "fake-op",
        dmConsented: true,
        lastNotifiedEpisode: null,
      }),
    ).toEqual({ send: false });
  });

  it("sends again for a new pause episode", () => {
    const secondEpisode: SessionLifecycleState = {
      ...PAUSED,
      since: "2026-01-01T01:00:00.000Z",
    };
    expect(
      shouldSendPauseDm({
        state: secondEpisode,
        operatorUserId: "fake-op",
        dmConsented: true,
        lastNotifiedEpisode: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({ send: true, episode: "2026-01-01T01:00:00.000Z" });
  });
});

describe("formatPauseDm", () => {
  it("carries the cause but no player content", () => {
    const text = formatPauseDm(PAUSED);
    expect(text).toContain("paused");
    expect(text.toLowerCase()).toContain("foundry");
    expect(text).toContain("addon-gone");
  });
});
