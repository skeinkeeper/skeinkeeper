// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { MockFoundryClient } from "../foundry/mock.js";
import type { FoundryActor, FoundryScene } from "../foundry/client.js";
import {
  isStarterSceneName,
  readModuleSummaries,
  readOwnershipMap,
  readPackSummaries,
  readPartyActorSummaries,
  readSceneSummaries,
  readWorldInfo,
  searchCompendiumHits,
  searchCreaturesByName,
  searchJournalHits,
} from "./foundry_reads.js";

const hero: FoundryActor = {
  id: "ch-hero",
  name: "Hero",
  type: "character",
  system: "dnd5e",
  sheet: { details: { race: "Human", class: "Fighter" } },
};

const startScene: FoundryScene = {
  id: "scene-start",
  name: "Session Start — Triboar Trail",
  active: true,
  tokens: [{ actorId: hero.id, name: hero.name }],
};

describe("isStarterSceneName", () => {
  it("matches start / intro conventions", () => {
    expect(isStarterSceneName("Session Start")).toBe(true);
    expect(isStarterSceneName("Intro: Phandalin")).toBe(true);
    expect(isStarterSceneName("Cragmaw Hideout")).toBe(false);
  });
});

describe("Foundry read adapters", () => {
  it("reads world info, party summaries, scenes, modules, packs", async () => {
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      systemName: "D&D 5e",
      actors: [hero],
      partyActorIds: [hero.id],
      scenes: [startScene],
      activeSceneId: startScene.id,
      modules: [
        { id: "lmop", title: "Lost Mine of Phandelver", kind: "campaign", active: true },
        { id: "dnd5e", title: "D&D 5e", kind: "system", active: true },
      ],
      packs: [{ id: "dnd5e.monsters", label: "Monsters", type: "Actor" }],
      users: [{ id: "u-gm", name: "GM", ownedActorIds: [hero.id] }],
      creatures: [{ id: "gob-1", name: "Goblin", packId: "dnd5e.monsters" }],
      compendiumHits: [{ id: "race-human", name: "Human", packId: "dnd5e.races", type: "race" }],
      journalHits: [{ id: "j-1", name: "Gundren" }],
    });

    const world = await readWorldInfo(foundry);
    expect(world.connected).toBe(true);
    expect(world.system).toEqual({ id: "dnd5e", name: "D&D 5e" });

    const party = await readPartyActorSummaries(foundry);
    expect(party).toEqual([
      { id: "ch-hero", name: "Hero", type: "character", race: "Human", class: "Fighter" },
    ]);

    const scenes = await readSceneSummaries(foundry);
    expect(scenes[0]).toMatchObject({ id: "scene-start", isStarter: true, active: true });

    const modules = await readModuleSummaries(foundry);
    expect(modules.map((m) => m.kind)).toEqual(["campaign", "system"]);

    const packs = await readPackSummaries(foundry);
    expect(packs[0]?.id).toBe("dnd5e.monsters");

    const ownership = await readOwnershipMap(foundry);
    expect(ownership["ch-hero"]).toBe("u-gm");

    expect((await searchCreaturesByName(foundry, "Goblin"))[0]?.packId).toBe("dnd5e.monsters");
    expect((await searchCompendiumHits(foundry, "Human"))[0]?.name).toBe("Human");
    expect((await searchJournalHits(foundry, "Gundren"))[0]?.name).toBe("Gundren");
  });

  it("reports disconnected worlds without throwing", async () => {
    const foundry = new MockFoundryClient({ system: "", connected: false });
    const world = await readWorldInfo(foundry);
    expect(world.connected).toBe(false);
    expect(world.system).toBeNull();
  });
});
