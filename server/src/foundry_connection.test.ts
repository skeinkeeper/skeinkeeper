// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { checkFoundryAddonConnected } from "./foundry_connection.js";

describe("checkFoundryAddonConnected (TDD 0038 out-of-session probe)", () => {
  it("returns false when no probe is available (standalone CLI, no session)", async () => {
    expect(await checkFoundryAddonConnected({})).toBe(false);
  });

  it("returns the injected probe result", async () => {
    expect(await checkFoundryAddonConnected({ probe: async () => true })).toBe(true);
    expect(await checkFoundryAddonConnected({ probe: () => false })).toBe(false);
  });

  it("returns false when the probe throws", async () => {
    expect(
      await checkFoundryAddonConnected({
        probe: async () => {
          throw new Error("timeout");
        },
      }),
    ).toBe(false);
  });

  it("falls back to getWorldInfo.connected when no explicit probe is given", async () => {
    expect(
      await checkFoundryAddonConnected({
        getWorldInfo: async () => ({ connected: true }),
      }),
    ).toBe(true);
    expect(
      await checkFoundryAddonConnected({
        getWorldInfo: async () => {
          throw new Error("disconnected");
        },
      }),
    ).toBe(false);
  });
});
