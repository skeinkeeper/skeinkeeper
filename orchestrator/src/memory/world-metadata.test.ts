// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { extractKeys } from "./world-metadata.js";
import type {
  WorldCreatureEntry,
  WorldItemEntry,
  WorldJournalEntry,
  WorldSceneEntry,
} from "../autosetup/world-types.js";

const phandalinJournal: WorldJournalEntry = {
  id: "j1",
  name: "Phandalin Overview",
  text: "Sildar Hallwinter stays at the Stonehill Inn. The Redbrands trouble the town.",
  folder: "Locations",
};

const questJournal: WorldJournalEntry = {
  id: "j2",
  name: "Find Gundren",
  text: "The Rockseeker brothers went missing near Cragmaw Hideout.",
  folder: "Quests",
  pages: [{ name: "Objective", flags: { quest: true } }],
};

const scene: WorldSceneEntry = {
  id: "s1",
  name: "Goblin Ambush",
  folder: "Locations",
  active: false,
  tags: ["road", "start"],
};

describe("extractKeys — journal", () => {
  it("uses a scene-folder as location and extracts proper-noun keywords", () => {
    const keys = extractKeys({
      kind: "journal",
      entry: phandalinJournal,
      sceneFolders: new Set(["Locations", "Caves"]),
      quests: ["Find Gundren"],
    });
    expect(keys.location).toBe("Locations");
    expect(keys.keywords).toEqual(
      expect.arrayContaining(["Phandalin", "Overview", "Sildar", "Hallwinter", "Stonehill", "Inn"]),
    );
    expect(keys.quest).toBeUndefined();
  });

  it("falls back to the first proper noun in the title when the folder is not a location", () => {
    const keys = extractKeys({
      kind: "journal",
      entry: { id: "j3", name: "The Wave Echo Cave Notes", text: "old mine", folder: "Handouts" },
      sceneFolders: new Set(["Locations"]),
    });
    expect(keys.location).toBe("Wave Echo Cave Notes");
  });

  it("sets quest from a quest-flagged page or a matching in-progress quest title", () => {
    const flagged = extractKeys({
      kind: "journal",
      entry: questJournal,
      sceneFolders: new Set(),
      quests: ["Find Gundren"],
    });
    expect(flagged.quest).toBe("Find Gundren");
    const titled = extractKeys({
      kind: "journal",
      entry: { id: "j4", name: "Find Gundren — briefing", text: "" },
      sceneFolders: new Set(),
      quests: ["Find Gundren"],
    });
    expect(titled.quest).toBe("Find Gundren");
  });
});

describe("extractKeys — scene", () => {
  it("uses the scene name as location and inherits quest from a same-folder journal", () => {
    const journalKeys = extractKeys({
      kind: "journal",
      entry: { ...questJournal, folder: "Locations" },
      sceneFolders: new Set(["Locations"]),
      quests: ["Find Gundren"],
    });
    const keys = extractKeys({
      kind: "scene",
      entry: scene,
      journalByFolder: new Map([["Locations", journalKeys]]),
    });
    expect(keys.location).toBe("Goblin Ambush");
    expect(keys.quest).toBe("Find Gundren");
    expect(keys.keywords).toEqual(
      expect.arrayContaining(["Goblin", "Ambush", "Locations", "road"]),
    );
  });
});

describe("extractKeys — creature", () => {
  it("inherits location from a naming journal folder and copies quest", () => {
    const creature: WorldCreatureEntry = {
      id: "c1",
      name: "King Grol",
      type: "npc",
      tags: ["bugbear"],
      text: "King Grol",
      folder: "Cragmaw",
    };
    const keys = extractKeys({
      kind: "creature",
      entry: creature,
      journalCrossRef: { location: "Cragmaw Hideout", quest: "Find Gundren", keywords: [] },
    });
    expect(keys.location).toBe("Cragmaw Hideout");
    expect(keys.quest).toBe("Find Gundren");
    expect(keys.keywords).toEqual(expect.arrayContaining(["King", "Grol", "npc", "bugbear"]));
  });
});

describe("extractKeys — item", () => {
  it("inherits owner keys and keywords the item name + type", () => {
    const item: WorldItemEntry = {
      id: "i1",
      name: "Light Hammer",
      type: "weapon",
      actorId: "a1",
      text: "Light Hammer",
    };
    const keys = extractKeys({
      kind: "item",
      entry: item,
      ownerKeys: { location: "Phandalin", quest: "Find Gundren", keywords: [] },
    });
    expect(keys.location).toBe("Phandalin");
    expect(keys.quest).toBe("Find Gundren");
    expect(keys.keywords).toEqual(expect.arrayContaining(["Light", "Hammer", "weapon"]));
  });
});
