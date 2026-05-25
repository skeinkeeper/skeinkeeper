// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore, type MemoryRecord } from "@skeinkeeper/orchestrator";
import { createPiiCrypto, playerAudience } from "@skeinkeeper/server";
import { MemoryAdapter } from "./memory_adapter.js";

const SALT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const crypto = createPiiCrypto({ keySource: { getPassphrase: () => undefined }, salt: SALT });

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

  it("player scope erases that player's private side-channel memory by hashed + legacy tokens (ADR-0017, TDD 0030); shared persists (ADR-0014)", async () => {
    const store = new InMemoryMemoryStore();
    await store.upsert([
      rec("shared-1", "c1"), // table (default)
      rec("shared-2", "c1", "table"),
      rec("dana-hashed", "c1", playerAudience(crypto, "discord:1")), // post-0030 token
      rec("dana-legacy", "c1", "player:discord:1"), // pre-0030 raw token
      rec("eli-secret", "c1", playerAudience(crypto, "discord:2")),
    ]);
    const adapter = new MemoryAdapter(() => store, crypto);

    // Both of Dana's private records go (hashed + legacy); shared + Eli's stay.
    expect(await adapter.delete({ kind: "player", tenantId: "t", subjectId: "discord:1" })).toBe(2);
    const remaining = await store.query([1, 0], { campaignId: "c1", topK: 9 });
    expect(remaining.map((r) => r.id).sort()).toEqual(["eli-secret", "shared-1", "shared-2"]);
  });

  it("declares player + campaign + tenant scopes", () => {
    const adapter = new MemoryAdapter(() => new InMemoryMemoryStore());
    expect([...adapter.supportedScopes]).toEqual(["player", "campaign", "tenant"]);
  });
});
