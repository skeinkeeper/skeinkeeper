// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { verifyIdentityPreflight, type IdentityPreflightInput } from "./preflight-identity.js";

const okUser = {
  id: "u1",
  name: "Alice",
  role: "PLAYER" as const,
  ownedActorIds: ["a1"],
};
const gmUser = {
  id: "u-dm",
  name: "DM",
  role: "GAMEMASTER" as const,
  ownedActorIds: [] as string[],
};

function base(overrides: Partial<IdentityPreflightInput> = {}): IdentityPreflightInput {
  return {
    campaignId: "c1",
    expectedPlayers: [{ discordUserId: "d1", displayName: "Alice" }],
    foundryUsers: [okUser, gmUser],
    identityMap: [{ discordUserId: "d1", foundryUserId: "u1", foundryActorId: "a1" }],
    dmFoundryUserId: "u-dm",
    operatorFoundryUserId: "u-dm",
    ...overrides,
  };
}

describe("verifyIdentityPreflight", () => {
  it("no-foundry-user is critical when the map has no Foundry user", () => {
    const result = verifyIdentityPreflight(
      base({
        identityMap: [{ discordUserId: "d1", foundryUserId: undefined, foundryActorId: "a1" }],
      }),
    );
    expect(result.status).toBe("critical-gaps");
    expect(result.findings).toContainEqual({
      kind: "no-foundry-user",
      discordUserId: "d1",
      displayName: "Alice",
    });
  });

  it("no-foundry-user is critical when the expected player has no map row", () => {
    const result = verifyIdentityPreflight(base({ identityMap: [] }));
    expect(result.status).toBe("critical-gaps");
    expect(result.findings).toContainEqual({
      kind: "no-foundry-user",
      discordUserId: "d1",
      displayName: "Alice",
    });
  });

  it("foundry-user-not-owning-actor is critical when ownedActorIds miss the mapped actor", () => {
    const result = verifyIdentityPreflight(
      base({
        foundryUsers: [{ ...okUser, ownedActorIds: ["a2"] }, gmUser],
      }),
    );
    expect(result.status).toBe("critical-gaps");
    expect(result.findings).toEqual([
      {
        kind: "foundry-user-not-owning-actor",
        discordUserId: "d1",
        foundryUserId: "u1",
        foundryActorId: "a1",
      },
    ]);
  });

  it("foundry-user-not-owning-actor is critical when the mapped Foundry user is gone", () => {
    const result = verifyIdentityPreflight(base({ foundryUsers: [gmUser] }));
    expect(result.status).toBe("critical-gaps");
    expect(result.findings[0]?.kind).toBe("foundry-user-not-owning-actor");
  });

  it("no-dm-foundry-user-designated is critical when the DM user is unset", () => {
    const result = verifyIdentityPreflight(base({ dmFoundryUserId: undefined }));
    expect(result.status).toBe("critical-gaps");
    expect(result.findings).toContainEqual({ kind: "no-dm-foundry-user-designated" });
  });

  it("dm-foundry-user-is-operator-player-user is critical when the operator is also a player", () => {
    const result = verifyIdentityPreflight(
      base({
        expectedPlayers: [{ discordUserId: "d1" }, { discordUserId: "d-op", displayName: "Op" }],
        foundryUsers: [okUser, { id: "u-op", name: "Op", role: "PLAYER", ownedActorIds: ["a-op"] }],
        identityMap: [
          { discordUserId: "d1", foundryUserId: "u1", foundryActorId: "a1" },
          { discordUserId: "d-op", foundryUserId: "u-op", foundryActorId: "a-op" },
        ],
        dmFoundryUserId: "u-op",
        operatorFoundryUserId: "u-op",
      }),
    );
    expect(result.status).toBe("critical-gaps");
    expect(result.findings).toContainEqual({
      kind: "dm-foundry-user-is-operator-player-user",
      foundryUserId: "u-op",
    });
  });

  it("dm-foundry-user-is-operator-player-user is not critical for a pure-host operator", () => {
    const result = verifyIdentityPreflight(
      base({
        dmFoundryUserId: "u-op",
        operatorFoundryUserId: "u-op",
        foundryUsers: [okUser, { ...gmUser, id: "u-op" }],
      }),
    );
    expect(result.findings.some((f) => f.kind === "dm-foundry-user-is-operator-player-user")).toBe(
      false,
    );
    expect(result.status).not.toBe("critical-gaps");
  });

  it("operator-foundry-user-not-gm-role is a warning", () => {
    const result = verifyIdentityPreflight(
      base({
        operatorFoundryUserId: "u1",
      }),
    );
    expect(result.findings).toContainEqual({
      kind: "operator-foundry-user-not-gm-role",
      foundryUserId: "u1",
    });
    expect(result.status).toBe("warnings-only");
  });

  it("extra-foundry-users-not-mapped is info only", () => {
    const result = verifyIdentityPreflight(
      base({
        foundryUsers: [
          okUser,
          gmUser,
          { id: "u-extra", name: "NPC", role: "PLAYER", ownedActorIds: [] },
        ],
      }),
    );
    expect(result.findings).toContainEqual({
      kind: "extra-foundry-users-not-mapped",
      foundryUserIds: ["u-extra"],
    });
    expect(result.status).toBe("warnings-only");
  });

  it("ok baseline: mapped players, ownership, distinct DM, operator GM-role", () => {
    const result = verifyIdentityPreflight(base());
    expect(result).toEqual({ status: "ok", findings: [] });
  });

  it("bridge-listusers-unavailable is warnings-only and does not block", () => {
    const result = verifyIdentityPreflight(base({ listUsersAvailable: false, foundryUsers: [] }));
    expect(result.status).toBe("warnings-only");
    expect(result.findings).toEqual([{ kind: "bridge-listusers-unavailable" }]);
  });
});
