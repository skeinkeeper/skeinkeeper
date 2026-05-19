// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it, vi, beforeEach } from "vitest";

const captureMock = vi.fn();
const shutdownMock = vi.fn().mockResolvedValue(undefined);

vi.mock("posthog-node", () => ({
  PostHog: vi.fn().mockImplementation(() => ({
    capture: captureMock,
    shutdown: shutdownMock,
  })),
}));

import { createAnalytics } from "./analytics.js";

describe("createAnalytics", () => {
  beforeEach(() => {
    captureMock.mockClear();
    shutdownMock.mockClear();
  });

  it("returns a no-op client when disabled and never touches PostHog", async () => {
    const client = createAnalytics({
      enabled: false,
      installationId: "inst-1",
      posthogKey: "phk_test",
    });
    client.track("app.started", { version: "0.0.0", nodeVersion: "v22" });
    await client.flush();
    expect(captureMock).not.toHaveBeenCalled();
    expect(shutdownMock).not.toHaveBeenCalled();
  });

  it("returns a no-op client when no PostHog key is configured", async () => {
    const client = createAnalytics({ enabled: true, installationId: "inst-2" });
    client.track("app.started", { version: "0.0.0", nodeVersion: "v22" });
    await client.flush();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("emits exactly one capture when enabled and a key is set", async () => {
    const client = createAnalytics({
      enabled: true,
      installationId: "inst-3",
      posthogKey: "phk_test",
    });
    client.track("session.started", {
      campaignIdHash: "abc123",
      rulesetId: "dnd5e",
    });
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith({
      distinctId: "inst-3",
      event: "session.started",
      properties: { campaignIdHash: "abc123", rulesetId: "dnd5e" },
    });
    await client.flush();
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });
});
