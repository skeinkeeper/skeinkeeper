// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { MockFoundryClient } from "../foundry/mock.js";
import type { FoundryActor } from "../foundry/client.js";
import type { ExtendedIntakeResult } from "../intake/types.js";
import { preloadExpectedContent } from "./preload.js";

const hero: FoundryActor = {
  id: "a1",
  name: "Hero",
  type: "character",
  system: "dnd5e",
  sheet: { details: { race: "Goblin", class: "Fighter", background: "Soldier" } },
};

const emptyIntake: ExtendedIntakeResult = {
  loadedModules: [],
  compendiumPacks: [],
  existingScenes: [],
  currentOwnershipMap: {},
  warmStateSummary: {
    priorSessionCount: 0,
    questFlagCount: 0,
    consentedPlayerCount: 0,
    mappedPlayerCount: 0,
  },
  findings: [],
};

function foundryWithHits(): MockFoundryClient {
  return new MockFoundryClient({
    system: "dnd5e",
    actors: [hero],
    partyActorIds: ["a1"],
    scenes: [{ id: "s1", name: "Start", active: true, tokens: [] }],
    activeSceneId: "s1",
    compendiumHits: [
      { id: "goblin", name: "Goblin", packId: "dnd5e.monsters", type: "npc" },
      { id: "fighter", name: "Fighter", packId: "dnd5e.classes", type: "class" },
      { id: "soldier", name: "Soldier", packId: "dnd5e.backgrounds", type: "background" },
    ],
  });
}

describe("preloadExpectedContent", () => {
  it("imports missing compendium actors without placing tokens", async () => {
    const foundry = foundryWithHits();
    const report = await preloadExpectedContent(foundry, emptyIntake, { campaignId: "c1" });
    expect(report.created).toBeGreaterThan(0);
    expect(foundry.createdFromCompendium.length).toBe(report.created);
    expect((await foundry.getActiveScene())?.tokens).toEqual([]);
    const world = await foundry.listWorldActors();
    expect(world.some((a) => a.flags?.["core"] !== undefined || a.name === "Goblin")).toBe(true);
  });

  it("is idempotent — a second run creates zero actors", async () => {
    const foundry = foundryWithHits();
    const first = await preloadExpectedContent(foundry, emptyIntake, { campaignId: "c1" });
    const created = foundry.createdFromCompendium.length;
    expect(first.created).toBe(created);
    const second = await preloadExpectedContent(foundry, emptyIntake, { campaignId: "c1" });
    expect(second.created).toBe(0);
    expect(foundry.createdFromCompendium.length).toBe(created);
  });

  it("continues when one create fails", async () => {
    const foundry = foundryWithHits();
    foundry.createActorFromCompendium = async (args) => {
      if (args.itemId === "goblin") throw new Error("bridge down");
      return MockFoundryClient.prototype.createActorFromCompendium.call(foundry, args);
    };
    const report = await preloadExpectedContent(foundry, emptyIntake, { campaignId: "c1" });
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.created + report.deferred).toBeGreaterThan(0);
  });
});
