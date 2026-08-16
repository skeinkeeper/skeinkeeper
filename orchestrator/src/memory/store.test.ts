// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore, cosineSimilarity, type MemoryRecord } from "./store.js";

function rec(
  id: string,
  campaignId: string,
  vector: number[],
  kind: MemoryRecord["kind"] = "episodic",
  audience?: MemoryRecord["metadata"]["audience"],
): MemoryRecord {
  return {
    id,
    kind,
    text: id,
    vector,
    metadata: {
      campaignId,
      createdAt: 1,
      embedModel: "fake",
      ...(audience !== undefined ? { audience } : {}),
    },
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

  it("filters by audience, treating a record with no audience as table (design doc 0026 §10)", async () => {
    const store = new InMemoryMemoryStore();
    await store.upsert([
      rec("shared-default", "c1", [1, 0], "episodic"), // no audience → table
      rec("shared-table", "c1", [1, 0], "episodic", "table"),
      rec("gm-secret", "c1", [1, 0], "episodic", "gm"),
      rec("dana-private", "c1", [1, 0], "episodic", "player:discord:1"),
      rec("eli-private", "c1", [1, 0], "episodic", "player:discord:2"),
    ]);

    // Dana's side-channel context: shared + her own; never gm, never Eli.
    const danaView = await store.query([1, 0], {
      campaignId: "c1",
      topK: 9,
      audiences: ["table", "player:discord:1"],
    });
    expect(danaView.map((r) => r.id).sort()).toEqual([
      "dana-private",
      "shared-default",
      "shared-table",
    ]);

    // The table loop: shared + gm; never any player-private.
    const tableView = await store.query([1, 0], {
      campaignId: "c1",
      topK: 9,
      audiences: ["table", "gm"],
    });
    expect(tableView.map((r) => r.id).sort()).toEqual([
      "gm-secret",
      "shared-default",
      "shared-table",
    ]);
  });

  it("deleteByAudience removes only that exact audience (player-scoped erasure, ADR-0017)", async () => {
    const store = new InMemoryMemoryStore();
    await store.upsert([
      rec("shared", "c1", [1, 0]),
      rec("dana-private", "c1", [1, 0], "episodic", "player:discord:1"),
      rec("eli-private", "c1", [1, 0], "episodic", "player:discord:2"),
    ]);
    expect(await store.deleteByAudience("player:discord:1")).toBe(1);
    const remaining = await store.query([1, 0], { campaignId: "c1", topK: 9 });
    expect(remaining.map((r) => r.id).sort()).toEqual(["eli-private", "shared"]);
  });
});

function cold(
  id: string,
  extras: Partial<MemoryRecord["metadata"]> & { vector?: number[]; text?: string },
): MemoryRecord {
  const { vector, text, ...meta } = extras;
  return {
    id,
    kind: "cold",
    text: text ?? id,
    vector: vector ?? [1, 0],
    metadata: {
      campaignId: "c1",
      createdAt: 1,
      embedModel: "fake",
      source: "world-journal",
      ...meta,
    },
  };
}

describe("byMetadata (TDD 0032)", () => {
  it("returns only records matching location across sources", async () => {
    const store = new InMemoryMemoryStore();
    await store.upsert([
      cold("j-phandalin", {
        source: "world-journal",
        location: "Phandalin",
        foundry_id: "j1",
        keywords: ["Town", "Phandalin"],
      }),
      cold("s-phandalin", {
        source: "world-scene",
        location: "Phandalin",
        foundry_id: "s1",
        vector: [0.9, 0.1],
      }),
      cold("j-wave", {
        source: "world-journal",
        location: "Wave Echo Cave",
        foundry_id: "j2",
      }),
    ]);
    const out = await store.byMetadata({ campaignId: "c1", location: "Phandalin" });
    expect(out.map((r) => r.id).sort()).toEqual(["j-phandalin", "s-phandalin"]);
  });

  it("ranks vector similarity within a location filter", async () => {
    const store = new InMemoryMemoryStore();
    await store.upsert([
      cold("near", { location: "Phandalin", vector: [1, 0], foundry_id: "a" }),
      cold("far", { location: "Phandalin", vector: [0, 1], foundry_id: "b" }),
      cold("closer-but-other-place", {
        location: "Neverwinter",
        vector: [0.99, 0.01],
        foundry_id: "c",
      }),
    ]);
    const ranked = await store.query([1, 0], {
      campaignId: "c1",
      topK: 5,
      metadata: { location: "Phandalin" },
    });
    expect(ranked.map((r) => r.id)).toEqual(["near", "far"]);
  });

  it("matches any overlapping keyword and excludes tombstones", async () => {
    const store = new InMemoryMemoryStore();
    await store.upsert([
      cold("alive", { keywords: ["Gundren", "Rockseeker"], foundry_id: "a" }),
      cold("dead", {
        keywords: ["Gundren"],
        foundry_id: "b",
        tombstoned: true,
      }),
      cold("other", { keywords: ["Sildar"], foundry_id: "c" }),
    ]);
    const out = await store.byMetadata({ campaignId: "c1", keywords: ["gundren"] });
    expect(out.map((r) => r.id)).toEqual(["alive"]);
    expect(await store.query([1, 0], { campaignId: "c1", topK: 9 })).toHaveLength(2);
  });
});
