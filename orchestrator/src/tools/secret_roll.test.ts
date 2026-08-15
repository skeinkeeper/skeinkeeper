// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { MockFoundryClient } from "../foundry/mock.js";
import { ToolDispatcher } from "../registry.js";
import { SideChannelIdentityMap } from "../side_channel/identity_map.js";
import { createDefaultRegistry } from "./index.js";

function bootstrap() {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(schema.tenants).values({ id: "default", name: "Test", createdAt: Date.now() }).run();
  const tenantDb = new TenantDb(db, "default");
  const dispatcher = new ToolDispatcher({ registry: createDefaultRegistry() });
  const identity = new SideChannelIdentityMap();
  identity.bind("discord-p1", "foundry-user-p1");
  return { tenantDb, dispatcher, identity };
}

describe("roll tool — secret Foundry whisper (TDD 0035)", () => {
  it("sends secret player rolls via rollDice whisperTo", async () => {
    const { tenantDb, dispatcher, identity } = bootstrap();
    const foundry = new MockFoundryClient({ system: "dnd5e" });
    const result = await dispatcher.dispatch(
      {
        name: "roll",
        input: {
          formula: "1d20+3",
          secret: true,
          audience: { kind: "player", playerId: "discord-p1" },
        },
      },
      {
        tenantDb,
        sessionId: "s",
        turnId: "t",
        caller: "llm",
        foundry,
        resolveFoundryUserId: (id) => identity.foundryUserIdForDiscord(id),
      },
    );
    expect(result.ok).toBe(true);
    expect(foundry.rolls).toEqual([
      {
        formula: "1d20+3",
        mode: "whisperTo",
        whisperTo: ["foundry-user-p1"],
      },
    ]);
  });

  it("falls back to the local roller and emits error.captured when rollDice throws", async () => {
    const { tenantDb, dispatcher, identity } = bootstrap();
    const events: Array<{ name: string; props: Record<string, unknown> }> = [];
    const foundry = new MockFoundryClient({ system: "dnd5e" });
    foundry.rollDice = async () => {
      throw new Error("bridge down");
    };
    const result = await dispatcher.dispatch(
      {
        name: "roll",
        input: {
          formula: "1d20",
          secret: true,
          audience: { kind: "player", playerId: "discord-p1" },
        },
      },
      {
        tenantDb,
        sessionId: "s",
        turnId: "t",
        caller: "llm",
        foundry,
        resolveFoundryUserId: (id) => identity.foundryUserIdForDiscord(id),
        analytics: {
          track: (name, props) => events.push({ name, props: props as Record<string, unknown> }),
          flush: async () => undefined,
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.output as { total: number; secret: boolean; source?: string };
      expect(out.secret).toBe(true);
      expect(out.source).toBe("local");
      expect(out.total).toBeGreaterThanOrEqual(1);
    }
    expect(events.some((e) => e.name === "error.captured")).toBe(true);
  });
});
