// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { afterEach, describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../interfaces/embedding.js";
import { InMemoryMemoryStore } from "../memory/store.js";
import { refreshIndex, resetIndexRefreshMutexForTests } from "./index-refresh.js";
import type {
  WorldContentReader,
  WorldCreatureEntry,
  WorldItemEntry,
  WorldJournalEntry,
  WorldSceneEntry,
} from "./world-types.js";

const embed = new FakeEmbeddingProvider();

afterEach(() => {
  resetIndexRefreshMutexForTests();
});

function journals(entries: WorldJournalEntry[]): WorldContentReader {
  return reader({ journals: entries });
}

function reader(seed: {
  journals?: WorldJournalEntry[];
  scenes?: WorldSceneEntry[];
  creatures?: WorldCreatureEntry[];
  items?: WorldItemEntry[];
  fail?: Partial<Record<"journals" | "scenes" | "creatures" | "items", Error>>;
}): WorldContentReader {
  return {
    readJournals: async () => {
      if (seed.fail?.journals) throw seed.fail.journals;
      return seed.journals ?? [];
    },
    readScenes: async () => {
      if (seed.fail?.scenes) throw seed.fail.scenes;
      return seed.scenes ?? [];
    },
    readCreatures: async () => {
      if (seed.fail?.creatures) throw seed.fail.creatures;
      return seed.creatures ?? [];
    },
    readActorItems: async () => {
      if (seed.fail?.items) throw seed.fail.items;
      return seed.items ?? [];
    },
  };
}

describe("refreshIndex", () => {
  it("first run ingests current journals; second run reports add/update/delete", async () => {
    const store = new InMemoryMemoryStore();
    const first = await refreshIndex(
      journals([
        { id: "j-keep", name: "Keep", text: "unchanged", modifiedAt: "2026-01-01" },
        { id: "j-old", name: "Old", text: "will change", modifiedAt: "2026-01-01" },
        { id: "j-gone", name: "Gone", text: "delete me", modifiedAt: "2026-01-01" },
      ]),
      store,
      embed,
      { campaignId: "c1" },
    );
    expect(first.perSource["world-journal"]).toEqual({ added: 3, updated: 0, deleted: 0 });

    const second = await refreshIndex(
      journals([
        { id: "j-keep", name: "Keep", text: "unchanged", modifiedAt: "2026-01-01" },
        { id: "j-old", name: "Old", text: "changed body", modifiedAt: "2026-02-01" },
        { id: "j-new-a", name: "New A", text: "fresh", modifiedAt: "2026-02-01" },
        { id: "j-new-b", name: "New B", text: "also fresh", modifiedAt: "2026-02-01" },
      ]),
      store,
      embed,
      { campaignId: "c1" },
    );
    expect(second.perSource["world-journal"]).toEqual({ added: 2, updated: 1, deleted: 1 });

    const all = await store.byMetadata({
      campaignId: "c1",
      source: "world-journal",
      includeTombstones: true,
    });
    const byFoundry = Object.fromEntries(all.map((r) => [r.metadata.foundry_id, r]));
    expect(byFoundry["j-gone"]?.metadata.tombstoned).toBe(true);
    expect(byFoundry["j-old"]?.text).toContain("changed body");
    expect(byFoundry["j-new-a"]).toBeDefined();
    expect(await store.byMetadata({ campaignId: "c1", source: "world-journal" })).toHaveLength(4);
  });

  it("isolates a failing source so the others complete", async () => {
    const store = new InMemoryMemoryStore();
    const report = await refreshIndex(
      reader({
        journals: [{ id: "j1", name: "Phandalin", text: "town" }],
        scenes: [{ id: "s1", name: "Start", active: false }],
        items: [{ id: "i1", name: "Sword", actorId: "a1", text: "Sword" }],
        fail: { creatures: new Error("parse exploded") },
      }),
      store,
      embed,
      { campaignId: "c1" },
    );
    expect(report.errors).toEqual([{ source: "world-creature", error: "parse exploded" }]);
    expect(report.perSource["world-journal"]?.added).toBe(1);
    expect(report.perSource["world-scene"]?.added).toBe(1);
    expect(report.perSource["world-actor-item"]?.added).toBe(1);
    expect(report.perSource["world-creature"]).toEqual({ added: 0, updated: 0, deleted: 0 });
  });

  it("awaits an in-flight run for the same campaign instead of writing twice", async () => {
    const store = new InMemoryMemoryStore();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const slow = reader({
      journals: [{ id: "j1", name: "Phandalin", text: "town" }],
    });
    const gated: WorldContentReader = {
      readJournals: async () => {
        reads += 1;
        await held;
        return slow.readJournals();
      },
      readScenes: () => slow.readScenes(),
      readCreatures: () => slow.readCreatures(),
      readActorItems: (ids) => slow.readActorItems(ids),
    };
    const a = refreshIndex(gated, store, embed, { campaignId: "c1" });
    const b = refreshIndex(gated, store, embed, { campaignId: "c1" });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    expect(reads).toBe(1);
    expect(ra.perSource["world-journal"]?.added).toBe(1);
  });
});
