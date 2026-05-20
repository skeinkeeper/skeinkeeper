// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../interfaces/embedding.js";
import type { DialogueTurn } from "../hot_context.js";
import { InMemoryMemoryStore, type MemoryRecord } from "./store.js";
import { buildMemoryQuery, retrieveMemory } from "./retrieval.js";

const embed = new FakeEmbeddingProvider();

async function storeWith(...texts: Array<[string, string]>): Promise<InMemoryMemoryStore> {
  const store = new InMemoryMemoryStore();
  const records: MemoryRecord[] = [];
  for (const [id, text] of texts) {
    const [vector] = await embed.embed([text]);
    records.push({
      id,
      kind: "episodic",
      text,
      vector: vector!,
      metadata: { campaignId: "c1", createdAt: 1, embedModel: embed.name },
    });
  }
  await store.upsert(records);
  return store;
}

describe("buildMemoryQuery", () => {
  it("joins the last N dialogue turns", () => {
    const dialogue: DialogueTurn[] = [
      { speaker: "a", text: "one", timestamp: 1 },
      { speaker: "b", text: "two", timestamp: 2 },
      { speaker: "c", text: "three", timestamp: 3 },
    ];
    expect(buildMemoryQuery(dialogue, { window: 2 })).toBe("two three");
  });
});

describe("retrieveMemory", () => {
  it("ranks the topically-overlapping record first", async () => {
    const store = await storeWith(
      ["goblins", "the party fought goblins at cragmaw hideout"],
      ["tavern", "a quiet evening drinking ale at the inn"],
    );
    const out = await retrieveMemory(embed, store, {
      query: "what happened with the goblins",
      campaignId: "c1",
      topK: 1,
    });
    expect(out[0]!.id).toBe("goblins");
  });

  it("returns nothing for an empty query without calling the store", async () => {
    const store = await storeWith(["x", "anything"]);
    const out = await retrieveMemory(embed, store, { query: "   ", campaignId: "c1" });
    expect(out).toHaveLength(0);
  });
});
