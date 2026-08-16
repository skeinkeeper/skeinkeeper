// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import type { FoundryClient, FoundrySearchHit } from "@skeinkeeper/orchestrator";
import { readCompendiumEntries } from "./compendium.js";

/** Minimal fake FoundryClient exposing only searchCompendium (scripted). */
function fakeFoundry(
  respond: (query: string) => ReadonlyArray<FoundrySearchHit>,
  onCall?: () => void,
): FoundryClient {
  const client = {
    async searchCompendium(query: string) {
      onCall?.();
      return respond(query);
    },
  };
  return client as unknown as FoundryClient;
}

describe("readCompendiumEntries", () => {
  it("maps search hits into typed entries with embeddable text", async () => {
    const foundry = fakeFoundry(() => [
      { id: "goblin", name: "Goblin", type: "npc", packId: "dnd5e.monsters" },
    ]);
    const entries = await readCompendiumEntries(foundry, { queries: ["goblin"] });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "goblin",
      name: "Goblin",
      type: "npc",
      packId: "dnd5e.monsters",
    });
    expect(entries[0]!.text).toContain("Goblin");
    expect(entries[0]!.text).toContain("(npc)");
  });

  it("de-dupes the same item across queries and skips <2-char queries", async () => {
    let calls = 0;
    const foundry = fakeFoundry(
      () => [{ id: "x", name: "Fireball", type: "spell", packId: "p" }],
      () => {
        calls += 1;
      },
    );
    const entries = await readCompendiumEntries(foundry, { queries: ["fire", "a", "flame"] });
    expect(calls).toBe(2); // "a" skipped (< 2 chars)
    expect(entries).toHaveLength(1); // deduped by id
    expect(entries[0]!.name).toBe("Fireball");
  });

  it("drops malformed hits (missing id/name)", async () => {
    const foundry = fakeFoundry(() => [
      { id: "", name: "", type: "spell", packId: "p" },
      { id: "ok", name: "Light", type: "spell", packId: "p" },
    ]);
    const entries = await readCompendiumEntries(foundry, { queries: ["spell"] });
    expect(entries.map((e) => e.id)).toEqual(["ok"]);
  });
});
