// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { MockFoundryClient } from "./mock.js";
import type { FoundryActor, FoundryScene } from "./client.js";

const aragorn: FoundryActor = {
  id: "ch-aragorn",
  name: "Aragorn",
  type: "character",
  system: "dnd5e",
  sheet: { attributes: { hp: { value: 22, max: 30 } } },
};
const sildar: FoundryActor = {
  id: "npc-sildar",
  name: "Sildar",
  type: "npc",
  system: "dnd5e",
  sheet: { attributes: { hp: { value: 12, max: 12 } } },
};
const tavern: FoundryScene = {
  id: "scene-tavern",
  name: "Stonehill Inn",
  active: true,
  tokens: [
    { actorId: aragorn.id, name: aragorn.name },
    { actorId: sildar.id, name: sildar.name },
  ],
};

describe("MockFoundryClient", () => {
  it("returns party actors by configured IDs", async () => {
    const f = new MockFoundryClient({
      system: "dnd5e",
      actors: [aragorn, sildar],
      partyActorIds: ["ch-aragorn"],
    });
    const party = await f.listPartyActors();
    expect(party).toHaveLength(1);
    expect(party[0]?.id).toBe("ch-aragorn");
  });

  it("returns scene actors via token lookups", async () => {
    const f = new MockFoundryClient({
      system: "dnd5e",
      actors: [aragorn, sildar],
      scenes: [tavern],
      activeSceneId: "scene-tavern",
    });
    const scene = await f.getActiveScene();
    expect(scene?.name).toBe("Stonehill Inn");
    const onScene = await f.listSceneActors("scene-tavern");
    expect(onScene.map((a) => a.id).sort()).toEqual(["ch-aragorn", "npc-sildar"]);
  });

  it("records actor updates", async () => {
    const f = new MockFoundryClient({ system: "dnd5e", actors: [aragorn] });
    await f.applyActorUpdate("ch-aragorn", { system: { attributes: { hp: { value: 18 } } } });
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0]?.actorId).toBe("ch-aragorn");
  });

  it("records dice rolls and returns the configured result", async () => {
    const f = new MockFoundryClient({ system: "dnd5e" });
    f.rollResultFor = (formula) => ({ total: 17, rolls: [14], formula });
    const result = await f.rollDice("1d20+3", { speaker: "Aragorn" });
    expect(result.total).toBe(17);
    expect(f.rolls).toHaveLength(1);
    expect(f.rolls[0]?.speaker).toBe("Aragorn");
  });

  it("returns null for missing actors and inactive scenes", async () => {
    const f = new MockFoundryClient({ system: "dnd5e" });
    expect(await f.getActor("missing")).toBeNull();
    expect(await f.getActiveScene()).toBeNull();
    expect(await f.listSceneActors("missing")).toEqual([]);
  });
});
