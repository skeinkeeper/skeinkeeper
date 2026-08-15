// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { InMemoryMemoryStore } from "../memory/store.js";
import { MockFoundryClient } from "../foundry/mock.js";
import type { FoundryActor, FoundryScene } from "../foundry/client.js";
import { announceReadyAllowed } from "./resolve.js";
import { FakeEmbeddingProvider } from "../interfaces/embedding.js";
import type { WorldContentReader } from "../autosetup/world-types.js";
import { runSessionStartIntake } from "./session_start.js";
import type { IntakeContext } from "./types.js";

const hero: FoundryActor = {
  id: "a1",
  name: "Hero",
  type: "character",
  system: "dnd5e",
  sheet: { details: { race: "Human", class: "Fighter" } },
};
const startScene: FoundryScene = {
  id: "s-start",
  name: "Session Start",
  active: true,
  tokens: [],
};

const openHandles: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const h of openHandles) h.close();
  openHandles.length = 0;
});

function setupDb(): TenantDb {
  const db = openDb({ path: ":memory:", runMigrations: true });
  openHandles.push(db);
  db.insert(schema.tenants).values({ id: "default", name: "T", createdAt: Date.now() }).run();
  const t = new TenantDb(db, "default");
  t.campaigns.create({
    id: "c1",
    name: "C",
    rulesetId: "dnd5e",
    behaviorSpecVersion: "v0.1",
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return t;
}

const ctx: IntakeContext = {
  campaignId: "c1",
  sessionId: "sess-1",
  sessionConfig: { intake: { resolvedFindings: {} } },
};

describe("runSessionStartIntake", () => {
  it("allows announceReady immediately on a clean world", async () => {
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [hero],
      partyActorIds: ["a1"],
      scenes: [startScene],
      activeSceneId: "s-start",
      modules: [{ id: "lmop", title: "Lost Mine of Phandelver", kind: "campaign", active: true }],
      users: [{ id: "u1", name: "GM", ownedActorIds: ["a1"] }],
    });
    const started: string[] = [];
    const result = await runSessionStartIntake({
      ctx,
      foundry,
      memory: new InMemoryMemoryStore(),
      tenantDb: setupDb(),
      onTelemetry: (name) => started.push(name),
    });
    expect(result.ready).toBe(true);
    expect(announceReadyAllowed(result.state)).toBe(true);
    expect(result.minimum.criticalFindings).toEqual([]);
    expect(started).toContain("intake.minimum.started");
    expect(started).toContain("intake.minimum.completed");
    expect(result.extended).toBeDefined();
    await result.extended;
  });

  it("blocks announceReady on unresolved critical findings", async () => {
    const foundry = new MockFoundryClient({ system: "dnd5e" });
    const result = await runSessionStartIntake({
      ctx,
      foundry,
      memory: new InMemoryMemoryStore(),
      tenantDb: setupDb(),
    });
    expect(result.ready).toBe(false);
    expect(result.blockingFindings).toContain("NO_PARTY_ACTORS");
    expect(result.extended).toBeUndefined();
  });

  it("does not wait on extended intake before returning ready", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [hero],
      partyActorIds: ["a1"],
      scenes: [startScene],
      activeSceneId: "s-start",
      modules: [{ id: "lmop", title: "Lost Mine of Phandelver", kind: "campaign", active: true }],
      users: [{ id: "u1", name: "GM", ownedActorIds: ["a1"] }],
    });
    const orig = foundry.listCompendiumPacks.bind(foundry);
    foundry.listCompendiumPacks = async () => {
      await held;
      return orig();
    };
    const order: string[] = [];
    const result = await runSessionStartIntake({
      ctx,
      foundry,
      memory: new InMemoryMemoryStore(),
      tenantDb: setupDb(),
    });
    expect(result.ready).toBe(true);
    order.push("ready");
    expect(result.extended).toBeDefined();
    const ext = result.extended!.then(() => {
      order.push("extended");
    });
    order.push("onboarding-started");
    release();
    await ext;
    expect(order).toEqual(["ready", "onboarding-started", "extended"]);
  });

  it("passes listPartyActors ids into the world-item reader", async () => {
    const seen: string[][] = [];
    const world: WorldContentReader = {
      readJournals: async () => [],
      readScenes: async () => [],
      readCreatures: async () => [],
      readActorItems: async (ids) => {
        seen.push([...ids]);
        return [];
      },
    };
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [hero],
      partyActorIds: ["a1"],
      scenes: [startScene],
      activeSceneId: "s-start",
      modules: [{ id: "lmop", title: "Lost Mine of Phandelver", kind: "campaign", active: true }],
      users: [{ id: "u1", name: "GM", ownedActorIds: ["a1"] }],
    });
    const result = await runSessionStartIntake({
      ctx,
      foundry,
      memory: new InMemoryMemoryStore(),
      tenantDb: setupDb(),
      embed: new FakeEmbeddingProvider(),
      worldContent: world,
    });
    await result.extended;
    await vi.waitFor(() => {
      expect(seen[0]).toEqual(["a1"]);
    });
  });
});
