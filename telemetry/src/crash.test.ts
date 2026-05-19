// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.mock is hoisted above local consts, so the mock fns referenced in the
// factory have to be hoisted together via vi.hoisted().
const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
  withScope: vi.fn().mockImplementation((cb: (scope: unknown) => void) => {
    cb({ setUser: vi.fn(), setTag: vi.fn() });
  }),
}));

vi.mock("@sentry/node", () => ({
  init: mocks.init,
  captureException: mocks.captureException,
  flush: mocks.flush,
  withScope: mocks.withScope,
}));

import { createCrash } from "./crash.js";

describe("createCrash", () => {
  beforeEach(() => {
    mocks.init.mockClear();
    mocks.captureException.mockClear();
    mocks.flush.mockClear();
    mocks.withScope.mockClear();
  });

  it("returns a no-op client when disabled and never initializes Sentry", async () => {
    const client = createCrash({
      enabled: false,
      installationId: "inst-1",
      sentryDsn: "https://example/0",
    });
    client.captureError(new Error("nope"));
    await client.flush();
    expect(mocks.init).not.toHaveBeenCalled();
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();
  });

  it("returns a no-op client when no DSN is configured", async () => {
    const client = createCrash({ enabled: true, installationId: "inst-2" });
    client.captureError(new Error("nope"));
    expect(mocks.init).not.toHaveBeenCalled();
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("initializes Sentry and captures exactly one error when enabled", async () => {
    const client = createCrash({
      enabled: true,
      installationId: "inst-3",
      sentryDsn: "https://example/0",
    });
    client.captureError(new Error("boom"), { module: "orchestrator" });
    expect(mocks.init).toHaveBeenCalledTimes(1);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(mocks.withScope).toHaveBeenCalledTimes(1);
    await client.flush();
    expect(mocks.flush).toHaveBeenCalledTimes(1);
  });
});
