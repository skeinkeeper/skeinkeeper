// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { FakeMcpToolCaller } from "./mcp_tool_caller.js";
import {
  readWorldActorItems,
  readWorldCreatures,
  readWorldJournals,
  readWorldScenes,
} from "./world-content.js";

describe("readWorldJournals", () => {
  it("parses list-journals + search-journals into typed entries", async () => {
    const caller = new FakeMcpToolCaller({
      "list-journals": {
        journals: [
          {
            id: "j1",
            name: "Phandalin",
            content: "A frontier town on the Triboar Trail.",
            folder: "Locations",
            _modifiedAt: "2026-05-01T00:00:00.000Z",
            pages: [{ name: "Overview", text: "Stonehill Inn sits on the square." }],
          },
          { type: "skip-me" },
        ],
      },
      "search-journals": {
        results: [
          {
            _id: "j2",
            name: "Find Gundren",
            text: "The Rockseeker brothers vanished.",
            folder: "Quests",
          },
        ],
      },
    });
    const entries = await readWorldJournals(caller, { query: "Gundren" });
    expect(entries.map((e) => e.id).sort()).toEqual(["j1", "j2"]);
    const town = entries.find((e) => e.id === "j1")!;
    expect(town.name).toBe("Phandalin");
    expect(town.text).toContain("frontier town");
    expect(town.folder).toBe("Locations");
    expect(town.modifiedAt).toBe("2026-05-01T00:00:00.000Z");
    expect(town.pages?.[0]?.name).toBe("Overview");
  });

  it("de-dupes the same journal across list and search", async () => {
    const caller = new FakeMcpToolCaller({
      "list-journals": { journals: [{ id: "j1", name: "Phandalin", text: "town" }] },
      "search-journals": { results: [{ id: "j1", name: "Phandalin", text: "town (search)" }] },
    });
    const entries = await readWorldJournals(caller, { query: "Phan" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toContain("town");
  });
});

describe("readWorldScenes", () => {
  it("parses list-scenes including folder and active state", async () => {
    const caller = new FakeMcpToolCaller({
      "list-scenes": {
        scenes: [
          {
            id: "s1",
            name: "Goblin Ambush",
            folder: "Triboar Trail",
            active: true,
            flags: { "is-starter": true },
            tags: ["start"],
          },
          { _id: "s2", name: "Wave Echo Cave", active: false },
          { name: "no-id" },
        ],
      },
    });
    const scenes = await readWorldScenes(caller);
    expect(scenes).toHaveLength(2);
    expect(scenes[0]).toMatchObject({
      id: "s1",
      name: "Goblin Ambush",
      folder: "Triboar Trail",
      active: true,
    });
    expect(scenes[0]!.tags).toContain("start");
    expect(scenes[1]!.id).toBe("s2");
    expect(scenes[1]!.active).toBe(false);
  });
});

describe("readWorldCreatures", () => {
  it("parses list-creatures-by-criteria into typed entries", async () => {
    const caller = new FakeMcpToolCaller({
      "list-creatures-by-criteria": {
        creatures: [
          {
            id: "gob-1",
            name: "Goblin",
            type: "npc",
            folder: "Cragmaw",
            tags: ["humanoid"],
            description: "Small, black-hearted.",
          },
          { name: "no-id" },
        ],
      },
    });
    const creatures = await readWorldCreatures(caller, { type: "npc" });
    expect(creatures).toHaveLength(1);
    expect(creatures[0]).toMatchObject({
      id: "gob-1",
      name: "Goblin",
      type: "npc",
      folder: "Cragmaw",
    });
    expect(creatures[0]!.text).toContain("Goblin");
    expect(caller.calls[0]?.args).toMatchObject({ type: "npc" });
  });
});

describe("readWorldActorItems", () => {
  it("parses get-character-entity items for each actor", async () => {
    const caller = new FakeMcpToolCaller({
      "get-character-entity": (args) => {
        if (args["id"] === "a1") {
          return {
            character: {
              id: "a1",
              name: "Hero",
              items: [
                { _id: "i1", name: "Longsword", type: "weapon", system: { description: "steel" } },
                { name: "no-id" },
              ],
            },
          };
        }
        return { actor: { id: "a2", items: [{ id: "i2", name: "Potion", type: "consumable" }] } };
      },
    });
    const items = await readWorldActorItems(caller, ["a1", "a2"]);
    expect(items.map((i) => i.id).sort()).toEqual(["i1", "i2"]);
    expect(items.find((i) => i.id === "i1")).toMatchObject({
      name: "Longsword",
      type: "weapon",
      actorId: "a1",
    });
    expect(items.find((i) => i.id === "i2")?.actorId).toBe("a2");
  });

  it("skips actors the bridge cannot resolve", async () => {
    const caller = new FakeMcpToolCaller({
      "get-character-entity": () => {
        throw new Error("missing");
      },
    });
    await expect(readWorldActorItems(caller, ["gone"])).resolves.toEqual([]);
  });
});
