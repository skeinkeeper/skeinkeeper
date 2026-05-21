// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore, type MemoryRecord } from "@skeinkeeper/orchestrator";
import { MemoryAdapter } from "./memory_adapter.js";

function rec(
  id: string,
  campaignId: string,
  audience?: MemoryRecord["metadata"]["audience"],
): MemoryRecord {
  return {
    id,
    kind: "episodic",
    text: id,
    vector: [1, 0],
    metadata: {
      campaignId,
      createdAt: 1,
      embedModel: "fake",
      ...(audience !== undefined ? { audience } : {}),
    },
  };
}

async function seeded(): Promise<InMemoryMemoryStore> {
  const store = new InMemoryMemoryStore();
  await store.upsert([rec("a", "c1"), rec("b", "c1"), rec("c", "c2")]);
  return store;
}

describe("MemoryAdapter (ADR-0014 / ADR-0017 erasure scoping)", () => {
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

  it("player scope erases only that player's private side-channel memory (ADR-0017); shared persists (ADR-0014)", async () => {
    const store = new InMemoryMemoryStore();
    await store.upsert([
      rec("shared-1", "c1"), // table (default)
      rec("shared-2", "c1", "table"),
      rec("dana-secret", "c1", "player:discord:1"),
      rec("eli-secret", "c1", "player:discord:2"),
    ]);
    const adapter = new MemoryAdapter(() => store);

    // Only Dana's private record goes; shared + other players' private stay.
    expect(await adapter.delete({ kind: "player", tenantId: "t", subjectId: "discord:1" })).toBe(1);
    const remaining = await store.query([1, 0], { campaignId: "c1", topK: 9 });
    expect(remaining.map((r) => r.id).sort()).toEqual(["eli-secret", "shared-1", "shared-2"]);
  });

  it("declares player + campaign + tenant scopes", () => {
    const adapter = new MemoryAdapter(() => new InMemoryMemoryStore());
    expect([...adapter.supportedScopes]).toEqual(["player", "campaign", "tenant"]);
  });
});
