// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore, cosineSimilarity, type MemoryRecord } from "./store.js";

function rec(id: string, campaignId: string, vector: number[], kind: MemoryRecord["kind"] = "episodic"): MemoryRecord {
  return {
    id,
    kind,
    text: id,
    vector,
    metadata: { campaignId, createdAt: 1, embedModel: "fake" },
  };
}

describe("cosineSimilarity", () => {
  it("is 1 for identical, 0 for orthogonal", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it("handles zero vectors without NaN", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("InMemoryMemoryStore", () => {
  it("returns top-k by similarity, most similar first", async () => {
    const store = new InMemoryMemoryStore();
    await store.upsert([
      rec("near", "c1", [1, 0, 0]),
      rec("mid", "c1", [0.7, 0.7, 0]),
      rec("far", "c1", [0, 0, 1]),
    ]);
    const out = await store.query([1, 0, 0], { campaignId: "c1", topK: 2 });
    expect(out.map((r) => r.id)).toEqual(["near", "mid"]);
  });

  it("scopes results to the campaign", async () => {
    const store = new InMemoryMemoryStore();
    await store.upsert([rec("a", "c1", [1, 0]), rec("b", "c2", [1, 0])]);
    const out = await store.query([1, 0], { campaignId: "c2", topK: 5 });
    expect(out.map((r) => r.id)).toEqual(["b"]);
  });

  it("filters by kind when requested", async () => {
    const store = new InMemoryMemoryStore();
    await store.upsert([rec("e", "c1", [1, 0], "episodic"), rec("c", "c1", [1, 0], "cold")]);
    const out = await store.query([1, 0], { campaignId: "c1", topK: 5, kinds: ["cold"] });
    expect(out.map((r) => r.id)).toEqual(["c"]);
  });

  it("upsert replaces by id", async () => {
    const store = new InMemoryMemoryStore();
    await store.upsert([rec("x", "c1", [1, 0])]);
    await store.upsert([{ ...rec("x", "c1", [0, 1]), text: "updated" }]);
    const out = await store.query([0, 1], { campaignId: "c1", topK: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("updated");
  });

  it("deletes by campaign and by tenant", async () => {
    const store = new InMemoryMemoryStore();
    await store.upsert([rec("a", "c1", [1, 0]), rec("b", "c2", [1, 0]), rec("c", "c2", [0, 1])]);
    expect(await store.deleteByCampaign("c2")).toBe(2);
    expect(await store.query([1, 0], { campaignId: "c2", topK: 5 })).toHaveLength(0);
    expect(await store.deleteByTenant()).toBe(1);
  });
});
