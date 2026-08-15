// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Eval-implication fixtures from TDD 0031. Deterministic MockFoundryClient
 * scenarios — intake is a rubric, not an LLM judgment.
 */

import { describe, expect, it } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { InMemoryMemoryStore } from "../memory/store.js";
import { MockFoundryClient } from "../foundry/mock.js";
import type { FoundryActor, FoundryScene } from "../foundry/client.js";
import { applyIntakeResolution } from "./resolve.js";
import { DM_ONLY_MARKER } from "./summary.js";
import { formatIntakeReportForOperator } from "./report.js";
import { runExtendedIntake, runMinimumIntake } from "./runner.js";
import { runSessionStartIntake } from "./session_start.js";
import { loadIntakeConfig, saveIntakeConfig } from "./persist.js";
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
  name: "Session Start — Triboar Trail",
  active: true,
  tokens: [],
};
const introScene: FoundryScene = {
  id: "s-intro",
  name: "Intro: Goblin Ambush",
  active: false,
  tokens: [],
};

function setupDb(): TenantDb {
  const db = openDb({ path: ":memory:", runMigrations: true });
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

const baseCtx: IntakeContext = {
  campaignId: "c1",
  sessionId: "sess-1",
  sessionConfig: { intake: { resolvedFindings: {} } },
};

describe("TDD 0031 eval scenarios", () => {
  it("1. clean session, no findings — announceReady fires immediately", async () => {
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [hero],
      partyActorIds: ["a1"],
      scenes: [startScene],
      activeSceneId: "s-start",
      modules: [{ id: "lmop", title: "Lost Mine of Phandelver", kind: "campaign", active: true }],
      users: [{ id: "u1", name: "GM", ownedActorIds: ["a1"] }],
    });
    const result = await runSessionStartIntake({
      ctx: baseCtx,
      foundry,
      memory: new InMemoryMemoryStore(),
      tenantDb: setupDb(),
    });
    expect(result.ready).toBe(true);
    expect(result.minimum.criticalFindings).toEqual([]);
    const extended = await result.extended!;
    expect(extended.findings).toEqual([]);
  });

  it("2. multiple modules ambiguity — report renders the choice; resolve writes SessionConfig.intake", async () => {
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
    const tenantDb = setupDb();
    const minimum = await runMinimumIntake(baseCtx, foundry, new InMemoryMemoryStore(), tenantDb);
    const extended = await runExtendedIntake(
      baseCtx,
      foundry,
      new InMemoryMemoryStore(),
      minimum,
      tenantDb,
    );
    const finding = extended.findings.find((f) => f.code === "MULTIPLE_CAMPAIGN_MODULES");
    expect(finding).toBeDefined();
    finding!.id = 42;
    const payload = formatIntakeReportForOperator([finding!]);
    expect(payload.text).toContain("I need a decision");
    expect(payload.text).toContain("/skeinkeeper intake resolve 42");
    const state = (await import("./resolve.js")).createIntakeResolutionState([finding!]);
    await applyIntakeResolution(state, 42, "lmop");
    expect(state.intake.chosenCampaignModuleId).toBe("lmop");
    saveIntakeConfig(tenantDb, "c1", state.intake);
    expect(loadIntakeConfig(tenantDb, "c1").chosenCampaignModuleId).toBe("lmop");
  });

  it("3. missing-race critical with proceed-anyway", async () => {
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
    const minimum = await runMinimumIntake(baseCtx, foundry, new InMemoryMemoryStore(), tenantDb);
    const f = minimum.criticalFindings.find((x) => x.code === "MISSING_RACE_CONTENT");
    expect(f?.resolution?.applyOnResolve).toBe("proceed-anyway");
  });

  it("4. ambiguous starting scene carries the DM-only marker", async () => {
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [hero],
      partyActorIds: ["a1"],
      scenes: [startScene, introScene],
      activeSceneId: "s-start",
      modules: [{ id: "lmop", title: "Lost Mine of Phandelver", kind: "campaign", active: true }],
      users: [{ id: "u1", name: "GM", ownedActorIds: ["a1"] }],
    });
    const tenantDb = setupDb();
    const minimum = await runMinimumIntake(baseCtx, foundry, new InMemoryMemoryStore(), tenantDb);
    const extended = await runExtendedIntake(
      baseCtx,
      foundry,
      new InMemoryMemoryStore(),
      minimum,
      tenantDb,
    );
    const f = extended.findings.find((x) => x.code === "AMBIG_STARTING_SCENE");
    expect(f?.dmOnly).toBe(true);
    const payload = formatIntakeReportForOperator([f!]);
    expect(payload.text).toContain(DM_ONLY_MARKER);
  });

  it("5. re-Start honors prior chosen module/pack/scene", async () => {
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [hero],
      partyActorIds: ["a1"],
      scenes: [startScene, introScene],
      activeSceneId: "s-start",
      modules: [
        { id: "lmop", title: "Lost Mine of Phandelver", kind: "campaign", active: true },
        { id: "ravenloft", title: "Ravenloft", kind: "campaign", active: true },
      ],
      users: [{ id: "u1", name: "GM", ownedActorIds: ["a1"] }],
      creatures: [
        { id: "g1", name: "Goblin", packId: "dnd5e.monsters" },
        { id: "g2", name: "Goblin", packId: "lmop.monsters" },
      ],
    });
    const honored: IntakeContext = {
      ...baseCtx,
      sessionConfig: {
        intake: {
          resolvedFindings: {
            MULTIPLE_CAMPAIGN_MODULES: "lmop",
            AMBIG_STARTING_SCENE: "s-start",
            AMBIG_SOURCE_PACK_FOR_CREATURE: "dnd5e.monsters",
          },
          chosenCampaignModuleId: "lmop",
          chosenStartingSceneId: "s-start",
          primarySourcePackByCreatureKey: { Goblin: "dnd5e.monsters" },
        },
      },
    };
    const tenantDb = setupDb();
    const result = await runSessionStartIntake({
      ctx: honored,
      foundry,
      memory: new InMemoryMemoryStore(),
      tenantDb,
    });
    expect(result.ready).toBe(true);
    const extended = await result.extended!;
    expect(extended.findings.map((f) => f.code)).toEqual([]);
  });

  it("6. concurrency: onboarding can start before extended intake finishes", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [hero],
      partyActorIds: ["a1"],
      scenes: [startScene],
      activeSceneId: "s-start",
      modules: [{ id: "lmop", title: "Lost Mine of Phandelver", kind: "campaign", active: true }],
      users: [{ id: "u1", name: "GM", ownedActorIds: ["a1"] }],
    });
    const orig = foundry.listCompendiumPacks.bind(foundry);
    foundry.listCompendiumPacks = async () => {
      await held;
      return orig();
    };
    const order: string[] = [];
    const result = await runSessionStartIntake({
      ctx: baseCtx,
      foundry,
      memory: new InMemoryMemoryStore(),
      tenantDb: setupDb(),
    });
    expect(result.ready).toBe(true);
    order.push("onboarding");
    const done = result.extended!.then(() => {
      order.push("extended-report");
    });
    release();
    await done;
    expect(order).toEqual(["onboarding", "extended-report"]);
  });
});
