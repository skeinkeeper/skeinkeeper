// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { afterEach, describe, expect, it } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { InMemoryMemoryStore } from "../memory/store.js";
import { MockFoundryClient } from "../foundry/mock.js";
import type { FoundryActor, FoundryScene } from "../foundry/client.js";
import { announceReadyAllowed } from "./resolve.js";
import { runExtendedIntake, runMinimumIntake } from "./runner.js";
import { runSessionStartIntake } from "./session_start.js";
import {
  IdentityPreflightBlockedError,
  assertIdentityAllowsStart,
  collectIdentityPreflightInput,
  executePreflightVerify,
  identityFindingsToIntake,
} from "./preflight-run.js";
import type { IntakeContext } from "./types.js";

const hero: FoundryActor = {
  id: "a1",
  name: "Hero",
  type: "character",
  system: "dnd5e",
  sheet: { details: { race: "Human", class: "Fighter" } },
};
const startScene: FoundryScene = {
  id: "s-start",
  name: "Session Start",
  active: true,
  tokens: [],
};

const openHandles: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const h of openHandles) h.close();
  openHandles.length = 0;
});

function setupDb(): TenantDb {
  const db = openDb({ path: ":memory:", runMigrations: true });
  openHandles.push(db);
  db.insert(schema.tenants).values({ id: "default", name: "T", createdAt: Date.now() }).run();
  const t = new TenantDb(db, "default");
  t.campaigns.create({
    id: "c1",
    name: "C",
    rulesetId: "dnd5e",
    behaviorSpecVersion: "v0.1",
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return t;
}

const ctx: IntakeContext = {
  campaignId: "c1",
  sessionId: "sess-1",
  sessionConfig: { intake: { resolvedFindings: {} } },
};

describe("runExtendedIntake identity pre-flight (TDD 0036)", () => {
  it("embeds a critical no-foundry-user finding and blocks announceReady", async () => {
    const tenantDb = setupDb();
    tenantDb.playerCharacterMap.record({
      campaignId: "c1",
      discordUserId: "d1",
      foundryActorId: "a1",
      displayName: "Alice",
      source: "player",
      confirmedAt: Date.now(),
    });
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [hero],
      partyActorIds: ["a1"],
      scenes: [startScene],
      activeSceneId: "s-start",
      users: [{ id: "u-gm", name: "GM", role: "GAMEMASTER", ownedActorIds: [] }],
    });
    const minimum = await runMinimumIntake(ctx, foundry, new InMemoryMemoryStore(), tenantDb);
    const extended = await runExtendedIntake(
      {
        ...ctx,
        expectedPlayers: [{ discordUserId: "d1", displayName: "Alice" }],
        dmFoundryUserId: "u-gm",
        operatorFoundryUserId: "u-gm",
      },
      foundry,
      new InMemoryMemoryStore(),
      minimum,
      tenantDb,
    );
    expect(extended.identityPreflight?.status).toBe("critical-gaps");
    expect(extended.findings.some((f) => f.code === "IDENTITY_NO_FOUNDRY_USER")).toBe(true);
    expect(extended.findings.find((f) => f.code === "IDENTITY_NO_FOUNDRY_USER")?.kind).toBe(
      "critical-gap",
    );
  });

  it("listUsers failure is warnings-only and does not block Start", async () => {
    const tenantDb = setupDb();
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [hero],
      partyActorIds: ["a1"],
      scenes: [startScene],
      activeSceneId: "s-start",
    });
    foundry.listUsers = async () => {
      throw new Error("bridge down");
    };
    const minimum = await runMinimumIntake(ctx, foundry, new InMemoryMemoryStore(), tenantDb);
    const extended = await runExtendedIntake(
      ctx,
      foundry,
      new InMemoryMemoryStore(),
      minimum,
      tenantDb,
    );
    expect(extended.identityPreflight?.status).toBe("warnings-only");
    expect(extended.findings.some((f) => f.code === "IDENTITY_BRIDGE_LISTUSERS_UNAVAILABLE")).toBe(
      true,
    );
    expect(
      extended.findings.find((f) => f.code === "IDENTITY_BRIDGE_LISTUSERS_UNAVAILABLE")?.kind,
    ).toBe("recommendation");
  });
});

describe("assertIdentityAllowsStart", () => {
  it("rejects with an actionable error referencing the finding", () => {
    const result = {
      status: "critical-gaps" as const,
      findings: [{ kind: "no-foundry-user" as const, discordUserId: "d1", displayName: "Alice" }],
    };
    expect(() => assertIdentityAllowsStart(result)).toThrow(IdentityPreflightBlockedError);
    try {
      assertIdentityAllowsStart(result);
    } catch (err) {
      expect(err).toBeInstanceOf(IdentityPreflightBlockedError);
      const blocked = err as IdentityPreflightBlockedError;
      expect(blocked.message).toMatch(/no-foundry-user|Foundry user/i);
      expect(blocked.message).toMatch(/Alice|d1/);
      expect(blocked.result.status).toBe("critical-gaps");
    }
  });

  it("does not throw on ok or warnings-only", () => {
    expect(() => assertIdentityAllowsStart({ status: "ok", findings: [] })).not.toThrow();
    expect(() =>
      assertIdentityAllowsStart({
        status: "warnings-only",
        findings: [{ kind: "bridge-listusers-unavailable" }],
      }),
    ).not.toThrow();
  });
});

describe("runSessionStartIntake + identity criticals", () => {
  it("blocks announceReady when the identity map is missing a Foundry user", async () => {
    const tenantDb = setupDb();
    tenantDb.playerCharacterMap.record({
      campaignId: "c1",
      discordUserId: "d1",
      foundryActorId: "a1",
      source: "player",
      confirmedAt: Date.now(),
    });
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [hero],
      partyActorIds: ["a1"],
      scenes: [startScene],
      activeSceneId: "s-start",
      modules: [{ id: "lmop", title: "Lost Mine of Phandelver", kind: "campaign", active: true }],
      users: [{ id: "u-gm", name: "GM", role: "GAMEMASTER", ownedActorIds: [] }],
    });
    const result = await runSessionStartIntake({
      ctx: {
        ...ctx,
        expectedPlayers: [{ discordUserId: "d1" }],
        dmFoundryUserId: "u-gm",
        operatorFoundryUserId: "u-gm",
      },
      foundry,
      memory: new InMemoryMemoryStore(),
      tenantDb,
    });
    expect(result.ready).toBe(false);
    expect(announceReadyAllowed(result.state)).toBe(false);
    expect(result.blockingFindings).toContain("IDENTITY_NO_FOUNDRY_USER");
    expect(result.report.findings.some((f) => f.code === "IDENTITY_NO_FOUNDRY_USER")).toBe(true);
    expect(result.extended).toBeUndefined();
  });
});

describe("collectIdentityPreflightInput", () => {
  it("reads the persistent map and listUsers", async () => {
    const tenantDb = setupDb();
    tenantDb.playerCharacterMap.record({
      campaignId: "c1",
      discordUserId: "d1",
      foundryUserId: "u1",
      foundryActorId: "a1",
      source: "player",
      confirmedAt: Date.now(),
    });
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      users: [{ id: "u1", name: "Alice", role: "PLAYER", ownedActorIds: ["a1"] }],
    });
    const input = await collectIdentityPreflightInput({
      campaignId: "c1",
      tenantDb,
      foundry,
      expectedPlayers: [{ discordUserId: "d1" }],
      dmFoundryUserId: "u-dm",
    });
    expect(input.listUsersAvailable).not.toBe(false);
    expect(input.identityMap[0]?.foundryUserId).toBe("u1");
    expect(identityFindingsToIntake({ status: "ok", findings: [] })).toEqual([]);
  });
});

describe("executePreflightVerify (TDD 0036 seq 8)", () => {
  it("reports table-wide findings inline", async () => {
    const tenantDb = setupDb();
    tenantDb.playerCharacterMap.record({
      campaignId: "c1",
      discordUserId: "d1",
      foundryActorId: "a1",
      displayName: "Alice",
      source: "player",
      confirmedAt: Date.now(),
    });
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      users: [{ id: "u-gm", name: "GM", role: "GAMEMASTER", ownedActorIds: [] }],
    });
    const sent: string[] = [];
    const result = await executePreflightVerify({
      ctx: {
        ...ctx,
        expectedPlayers: [{ discordUserId: "d1", displayName: "Alice" }],
        dmFoundryUserId: "u-gm",
        operatorFoundryUserId: "u-gm",
      },
      tenantDb,
      foundry,
      emit: async (text) => {
        sent.push(text);
      },
    });
    expect(result.status).toBe("critical-gaps");
    expect(sent[0]).toMatch(/Alice|Foundry user/i);
  });

  it("re-runs the per-player check", async () => {
    const tenantDb = setupDb();
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      users: [{ id: "u-gm", name: "GM", role: "GAMEMASTER", ownedActorIds: [] }],
    });
    const sent: string[] = [];
    const result = await executePreflightVerify({
      ctx: {
        ...ctx,
        dmFoundryUserId: "u-gm",
        operatorFoundryUserId: "u-gm",
      },
      tenantDb,
      foundry,
      player: "d1",
      emit: async (text) => {
        sent.push(text);
      },
    });
    expect(result.findings.some((f) => f.kind === "no-foundry-user")).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
