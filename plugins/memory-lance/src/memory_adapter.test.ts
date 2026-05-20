// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore, type MemoryRecord } from "@skeinkeeper/orchestrator";
import { MemoryAdapter } from "./memory_adapter.js";

function rec(id: string, campaignId: string): MemoryRecord {
  return {
    id,
    kind: "episodic",
    text: id,
    vector: [1, 0],
    metadata: { campaignId, createdAt: 1, embedModel: "fake" },
  };
}

async function seeded(): Promise<InMemoryMemoryStore> {
  const store = new InMemoryMemoryStore();
  await store.upsert([rec("a", "c1"), rec("b", "c1"), rec("c", "c2")]);
  return store;
}

describe("MemoryAdapter (ADR-0014 erasure scoping)", () => {
  it("campaign scope deletes that campaign's records", async () => {
    const store = await seeded();
    const adapter = new MemoryAdapter(() => store);
    expect(await adapter.delete({ kind: "campaign", tenantId: "t", campaignId: "c1" })).toBe(2);
    expect(await store.query([1, 0], { campaignId: "c1", topK: 9 })).toHaveLength(0);
    expect(await store.query([1, 0], { campaignId: "c2", topK: 9 })).toHaveLength(1);
  });

  it("tenant scope deletes everything in the tenant's store", async () => {
    const store = await seeded();
    const adapter = new MemoryAdapter(() => store);
    expect(await adapter.delete({ kind: "tenant", tenantId: "t" })).toBe(3);
  });

  it("player scope is a no-op — episodic memory is shared, not per-player erasable", async () => {
    const store = await seeded();
    const adapter = new MemoryAdapter(() => store);
    expect(await adapter.delete({ kind: "player", tenantId: "t", subjectId: "discord:1" })).toBe(0);
    // nothing removed
    expect(await store.query([1, 0], { campaignId: "c1", topK: 9 })).toHaveLength(2);
  });

  it("declares only campaign + tenant scopes", () => {
    const adapter = new MemoryAdapter(() => new InMemoryMemoryStore());
    expect([...adapter.supportedScopes]).toEqual(["campaign", "tenant"]);
  });
});
