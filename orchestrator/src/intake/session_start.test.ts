// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { InMemoryMemoryStore } from "../memory/store.js";
import { MockFoundryClient } from "../foundry/mock.js";
import type { FoundryActor, FoundryScene } from "../foundry/client.js";
import { announceReadyAllowed } from "./resolve.js";
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

function setupDb(): TenantDb {
  const db = openDb({ path: ":memory:", runMigrations: true });
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
});
