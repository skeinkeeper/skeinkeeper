// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it, vi } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { MockFoundryClient } from "../foundry/mock.js";
import { ToolDispatcher } from "../registry.js";
import { SideChannelIdentityMap } from "../side_channel/identity_map.js";
import { FakeOutboundSurface, SurfaceRouter } from "../surfaces/index.js";
import { createDefaultRegistry } from "./index.js";

function bootstrap() {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(schema.tenants).values({ id: "default", name: "Test", createdAt: Date.now() }).run();
  db.insert(schema.campaigns)
    .values({
      id: "c1",
      tenantId: "default",
      name: "Test",
      rulesetId: "dnd5e",
      behaviorSpecVersion: "v0.1",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  const tenantDb = new TenantDb(db, "default");
  return { tenantDb, dispatcher: new ToolDispatcher({ registry: createDefaultRegistry() }) };
}

describe("record_player_character — Foundry user binding (TDD 0036)", () => {
  it("writes foundryUserId from listUsers ownership at record-time", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const identity = new SideChannelIdentityMap();
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      users: [{ id: "u-alice", name: "Alice", ownedActorIds: ["actor-alice"] }],
    });
    const r = await dispatcher.dispatch(
      {
        name: "record_player_character",
        input: {
          campaignId: "c1",
          discordUserId: "discord:alice",
          foundryActorId: "actor-alice",
          displayName: "Alice",
        },
      },
      {
        tenantDb,
        sessionId: "s",
        turnId: "t",
        caller: "llm",
        foundry,
        identity,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.output as { foundryUserId: string | null }).foundryUserId).toBe("u-alice");
    }
    const current = tenantDb.playerCharacterMap.currentForPlayer("c1", "discord:alice");
    expect(current?.foundryUserId).toBe("u-alice");
    expect(identity.foundryUserIdForDiscord("discord:alice")).toBe("u-alice");
    expect(identity.discordIdForFoundryUser("u-alice")).toBe("discord:alice");
  });

  it("records foundryUserId null and emits a warning escalation when no owner exists", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      users: [{ id: "u-other", name: "Other", ownedActorIds: ["actor-other"] }],
    });
    const gm = new FakeOutboundSurface("foundry-gm", ["gm"]);
    const router = new SurfaceRouter();
    router.register(gm);
    const r = await dispatcher.dispatch(
      {
        name: "record_player_character",
        input: {
          campaignId: "c1",
          discordUserId: "discord:alice",
          foundryActorId: "actor-alice",
          displayName: "Alice",
        },
      },
      {
        tenantDb,
        sessionId: "s",
        turnId: "t",
        caller: "llm",
        foundry,
        surfaces: router,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.output as { foundryUserId: string | null }).foundryUserId).toBeNull();
    }
    expect(tenantDb.playerCharacterMap.currentForPlayer("c1", "discord:alice")?.foundryUserId).toBe(
      null,
    );
    expect(gm.emits).toHaveLength(1);
    expect(gm.emits[0]?.audience).toEqual({ kind: "gm" });
    expect(gm.emits[0]?.meta).toEqual({ escalation: true, severity: "warning" });
    expect(gm.emits[0]?.text).toMatch(/no Foundry user owns/i);
    expect(gm.emits[0]?.text).toMatch(/preflight verify/i);
  });

  it("emits identity.player-character.recorded with hasFoundryUser", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const track = vi.fn();
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      users: [{ id: "u-alice", name: "Alice", ownedActorIds: ["actor-alice"] }],
    });
    await dispatcher.dispatch(
      {
        name: "record_player_character",
        input: {
          campaignId: "c1",
          discordUserId: "discord:alice",
          foundryActorId: "actor-alice",
        },
      },
      {
        tenantDb,
        sessionId: "s",
        turnId: "t",
        caller: "llm",
        foundry,
        analytics: { track, flush: async () => undefined },
      },
    );
    expect(track).toHaveBeenCalledWith(
      "identity.player-character.recorded",
      expect.objectContaining({ source: "player", hasFoundryUser: true }),
    );
  });
});
