// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { pickDmFoundryUserId, pickOperatorFoundryUserId } from "./foundry_identity.js";

describe("pickOperatorFoundryUserId", () => {
  it("prefers the dedicated operator Foundry user over the 3-way player map", () => {
    expect(
      pickOperatorFoundryUserId({
        dedicatedOperatorFoundryUserId: "u-gm",
        mappedOperatorFoundryUserId: "u-player",
      }),
    ).toBe("u-gm");
  });

  it("does not fall back to the player-map Foundry user", () => {
    expect(
      pickOperatorFoundryUserId({
        mappedOperatorFoundryUserId: "u-player",
      }),
    ).toBeUndefined();
  });
});

describe("pickDmFoundryUserId", () => {
  it("uses the campaign DM setting, then the dedicated operator user", () => {
    expect(
      pickDmFoundryUserId({
        campaignDmFoundryUserId: "u-dm",
        dedicatedOperatorFoundryUserId: "u-gm",
      }),
    ).toBe("u-dm");
    expect(
      pickDmFoundryUserId({
        dedicatedOperatorFoundryUserId: "u-gm",
      }),
    ).toBe("u-gm");
  });

  it("does not use the operator's player-map Foundry user as the DM", () => {
    expect(
      pickDmFoundryUserId({
        mappedOperatorFoundryUserId: "u-player",
      }),
    ).toBeUndefined();
  });
});
