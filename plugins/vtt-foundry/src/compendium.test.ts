// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { FakeMcpToolCaller } from "./mcp_tool_caller.js";
import { readCompendiumEntries } from "./compendium.js";

function searchResult(items: unknown[], gameSystem = "dnd5e"): unknown {
  return { gameSystem, results: items, totalFound: items.length };
}

describe("readCompendiumEntries", () => {
  it("parses search results into typed entries with embeddable text", async () => {
    const caller = new FakeMcpToolCaller({
      "search-compendium": searchResult([
        {
          id: "goblin",
          name: "Goblin",
          type: "npc",
          pack: { id: "dnd5e.monsters", label: "Monsters (SRD)" },
          summary: "Small humanoid, CR 1/4",
          description: "A small, black-hearted humanoid that lurks in caves.",
        },
      ]),
    });
    const entries = await readCompendiumEntries(caller, { queries: ["goblin"] });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "goblin",
      name: "Goblin",
      type: "npc",
      packId: "dnd5e.monsters",
      packLabel: "Monsters (SRD)",
      system: "dnd5e",
    });
    expect(entries[0]!.text).toContain("Goblin");
    expect(entries[0]!.text).toContain("CR 1/4");
    expect(entries[0]!.text).toContain("lurks in caves");
  });

  it("de-dupes the same item across queries and skips <2-char queries", async () => {
    let calls = 0;
    const caller = new FakeMcpToolCaller({
      "search-compendium": () => {
        calls += 1;
        return searchResult([{ id: "x", name: "Fireball", type: "spell", pack: { id: "p", label: "Spells" } }]);
      },
    });
    const entries = await readCompendiumEntries(caller, { queries: ["fire", "a", "flame"] });
    expect(calls).toBe(2); // "a" skipped (< 2 chars)
    expect(entries).toHaveLength(1); // deduped by id
    expect(entries[0]!.name).toBe("Fireball");
  });

  it("drops malformed items (missing id/name)", async () => {
    const caller = new FakeMcpToolCaller({
      "search-compendium": searchResult([{ type: "spell" }, { id: "ok", name: "Light", type: "spell", pack: {} }]),
    });
    const entries = await readCompendiumEntries(caller, { queries: ["spell"] });
    expect(entries.map((e) => e.id)).toEqual(["ok"]);
  });
});
