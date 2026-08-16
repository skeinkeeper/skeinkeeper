// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { afterEach, describe, expect, it } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { InMemoryMemoryStore } from "../memory/store.js";
import { MockFoundryClient } from "../foundry/mock.js";
import type { FoundryActor, FoundryScene } from "../foundry/client.js";
import { runExtendedIntake, runMinimumIntake } from "./runner.js";
import type { IntakeContext } from "./types.js";

const hero: FoundryActor = {
  id: "a1",
  name: "Hero",
  type: "character",
  system: "dnd5e",
  sheet: { details: { race: "Human", class: "Fighter" } },
};
const fairy: FoundryActor = {
  id: "a-fairy",
  name: "Pip",
  type: "character",
  system: "dnd5e",
  sheet: { details: { race: "Fairy", class: "Bard" } },
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
  db.insert(schema.campaigns)
    .values({
      id: "c1",
      tenantId: "default",
      name: "C",
      rulesetId: "dnd5e",
      behaviorSpecVersion: "v0.1",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  return new TenantDb(db, "default");
}

const ctx: IntakeContext = {
  campaignId: "c1",
  sessionId: "sess-1",
  sessionConfig: { intake: { resolvedFindings: {} } },
};

describe("runMinimumIntake", () => {
  it("returns the system and party with no criticals on a clean world", async () => {
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      systemName: "D&D 5e",
      actors: [hero],
      partyActorIds: ["a1"],
    });
    const result = await runMinimumIntake(ctx, foundry, new InMemoryMemoryStore(), setupDb());
    expect(result.system).toEqual({ id: "dnd5e", name: "D&D 5e" });
    expect(result.partyActorCandidates).toHaveLength(1);
    expect(result.criticalFindings).toEqual([]);
  });

  it("emits FOUNDRY_NOT_CONNECTED when the world is down", async () => {
    const foundry = new MockFoundryClient({ system: "", connected: false });
    const result = await runMinimumIntake(ctx, foundry, new InMemoryMemoryStore(), setupDb());
    expect(result.criticalFindings.map((f) => f.code)).toEqual(["FOUNDRY_NOT_CONNECTED"]);
  });

  it("emits MISSING_RACE_CONTENT for a mapped Fairy without Witchlight", async () => {
    const tenantDb = setupDb();
    tenantDb.playerCharacterMap.record({
      campaignId: "c1",
      discordUserId: "discord-1",
      foundryActorId: "a-fairy",
      source: "player",
      confirmedAt: Date.now(),
    });
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [fairy],
      partyActorIds: ["a-fairy"],
      modules: [{ id: "lmop", title: "Lost Mine of Phandelver", kind: "campaign", active: true }],
    });
    const result = await runMinimumIntake(ctx, foundry, new InMemoryMemoryStore(), setupDb());
    // mapping was written to a different TenantDb — re-run against the mapped one
    const mapped = await runMinimumIntake(ctx, foundry, new InMemoryMemoryStore(), tenantDb);
    expect(mapped.criticalFindings.map((f) => f.code)).toContain("MISSING_RACE_CONTENT");
    expect(result.criticalFindings.map((f) => f.code)).not.toContain("MISSING_RACE_CONTENT");
  });
});

describe("runExtendedIntake", () => {
  it("summarizes modules, scenes, packs, and warm state", async () => {
    const tenantDb = setupDb();
    tenantDb.questFlags.set({ campaignId: "c1", key: "k", value: "v", updatedAt: Date.now() });
    tenantDb.playerCharacterMap.record({
      campaignId: "c1",
      discordUserId: "discord-1",
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
      modules: [
        { id: "lmop", title: "Lost Mine of Phandelver", kind: "campaign", active: true },
        { id: "ravenloft", title: "Ravenloft", kind: "campaign", active: true },
      ],
      packs: [{ id: "dnd5e.monsters", label: "Monsters" }],
      users: [{ id: "u1", name: "GM", ownedActorIds: ["a1"] }],
      creatures: [
        { id: "g1", name: "Goblin", packId: "dnd5e.monsters" },
        { id: "g2", name: "Goblin", packId: "lmop.monsters" },
      ],
    });
    const minimum = await runMinimumIntake(ctx, foundry, new InMemoryMemoryStore(), tenantDb);
    const extended = await runExtendedIntake(
      ctx,
      foundry,
      new InMemoryMemoryStore(),
      minimum,
      tenantDb,
    );
    expect(extended.loadedModules.filter((m) => m.kind === "campaign")).toHaveLength(2);
    expect(extended.existingScenes[0]?.isStarter).toBe(true);
    expect(extended.currentOwnershipMap["a1"]).toBe("u1");
    expect(extended.warmStateSummary.mappedPlayerCount).toBe(1);
    expect(extended.warmStateSummary.questFlagCount).toBe(1);
    expect(extended.findings.map((f) => f.code)).toContain("MULTIPLE_CAMPAIGN_MODULES");
    expect(extended.findings.map((f) => f.code)).toContain("AMBIG_SOURCE_PACK_FOR_CREATURE");
  });

  it("honors a prior chosen campaign module", async () => {
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [hero],
      partyActorIds: ["a1"],
      scenes: [startScene],
      activeSceneId: "s-start",
      modules: [
        { id: "lmop", title: "Lost Mine of Phandelver", kind: "campaign", active: true },
        { id: "ravenloft", title: "Ravenloft", kind: "campaign", active: true },
      ],
      users: [{ id: "u1", name: "GM", ownedActorIds: ["a1"] }],
    });
    const honored: IntakeContext = {
      ...ctx,
      sessionConfig: { intake: { resolvedFindings: {}, chosenCampaignModuleId: "lmop" } },
    };
    const minimum = await runMinimumIntake(honored, foundry, new InMemoryMemoryStore(), setupDb());
    const extended = await runExtendedIntake(
      honored,
      foundry,
      new InMemoryMemoryStore(),
      minimum,
      setupDb(),
    );
    expect(extended.findings.map((f) => f.code)).not.toContain("MULTIPLE_CAMPAIGN_MODULES");
  });
});
