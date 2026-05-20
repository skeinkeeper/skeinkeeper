// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../interfaces/embedding.js";
import { InMemoryMemoryStore } from "./store.js";
import { ingestColdEntries } from "./ingest.js";

const embed = new FakeEmbeddingProvider();

describe("ingestColdEntries", () => {
  it("embeds + stores entries as cold records, retrievable later", async () => {
    const store = new InMemoryMemoryStore();
    const n = await ingestColdEntries(embed, store, {
      campaignId: "c1",
      entries: [
        { id: "goblin", text: "Goblin: small evil humanoid, nimble and cowardly", deltas: { type: "npc" } },
        { id: "fireball", text: "Fireball: a bright streak that blossoms into flame", deltas: { type: "spell" } },
      ],
    });
    expect(n).toBe(2);
    const [q] = await embed.embed(["goblin humanoid"]);
    const out = await store.query(q!, { campaignId: "c1", topK: 1, kinds: ["cold"] });
    expect(out[0]!.id).toBe("cold-goblin");
    expect(out[0]!.kind).toBe("cold");
    expect(out[0]!.metadata.deltas).toEqual({ type: "npc" });
  });

  it("skips empty text", async () => {
    const store = new InMemoryMemoryStore();
    const n = await ingestColdEntries(embed, store, {
      campaignId: "c1",
      entries: [{ id: "blank", text: "   " }],
    });
    expect(n).toBe(0);
  });

  it("re-ingest updates in place (no duplicates)", async () => {
    const store = new InMemoryMemoryStore();
    await ingestColdEntries(embed, store, { campaignId: "c1", entries: [{ id: "x", text: "first" }] });
    await ingestColdEntries(embed, store, { campaignId: "c1", entries: [{ id: "x", text: "second version" }] });
    const [q] = await embed.embed(["second"]);
    const out = await store.query(q!, { campaignId: "c1", topK: 9, kinds: ["cold"] });
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("second version");
  });
});
