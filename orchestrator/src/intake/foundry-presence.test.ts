// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { applyFoundryPresenceTick, FOUNDRY_PRESENCE_INTERVAL_MS } from "./foundry-presence.js";

describe("Foundry presence polling (TDD 0036)", () => {
  it("emits presence.foundry.dropped when a previously-active user goes inactive", () => {
    const first = applyFoundryPresenceTick(new Map(), [
      { id: "u1", isActive: true },
      { id: "u-dm", isActive: true },
    ]);
    expect(first.transitions).toEqual([]);
    const second = applyFoundryPresenceTick(first.next, [
      { id: "u1", isActive: false },
      { id: "u-dm", isActive: true },
    ]);
    expect(second.transitions).toEqual([{ kind: "dropped", foundryUserId: "u1" }]);
  });

  it("emits presence.foundry.restored when an inactive user comes back", () => {
    const dropped = applyFoundryPresenceTick(new Map([["u1", true]]), [{ id: "u1", isActive: false }]);
    const restored = applyFoundryPresenceTick(dropped.next, [{ id: "u1", isActive: true }]);
    expect(restored.transitions).toEqual([{ kind: "restored", foundryUserId: "u1" }]);
  });

  it("restricts transitions to mapped Foundry users when a filter is given", () => {
    const first = applyFoundryPresenceTick(
      new Map(),
      [
        { id: "u1", isActive: true },
        { id: "u-extra", isActive: true },
      ],
      new Set(["u1"]),
    );
    const second = applyFoundryPresenceTick(
      first.next,
      [
        { id: "u1", isActive: false },
        { id: "u-extra", isActive: false },
      ],
      new Set(["u1"]),
    );
    expect(second.transitions).toEqual([{ kind: "dropped", foundryUserId: "u1" }]);
  });

  it("defaults the poll cadence to 60s", () => {
    expect(FOUNDRY_PRESENCE_INTERVAL_MS).toBe(60_000);
  });
});
