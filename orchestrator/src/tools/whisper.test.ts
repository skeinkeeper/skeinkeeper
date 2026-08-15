// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { ToolDispatcher } from "../registry.js";
import { FakeOutboundSurface, SurfaceRouter } from "../surfaces/index.js";
import { createDefaultRegistry } from "./index.js";

function bootstrap() {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(schema.tenants).values({ id: "default", name: "Test", createdAt: Date.now() }).run();
  const tenantDb = new TenantDb(db, "default");
  const dispatcher = new ToolDispatcher({ registry: createDefaultRegistry() });
  return { tenantDb, dispatcher };
}

describe("whisper tool — Foundry surface emit (TDD 0035)", () => {
  it("emits { kind: player, playerId } through the router", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const player = new FakeOutboundSurface("foundry-whisper", ["player"]);
    const table = new FakeOutboundSurface("foundry-public", ["table"]);
    const router = new SurfaceRouter();
    router.register(player);
    router.register(table);

    const result = await dispatcher.dispatch(
      { name: "whisper", input: { playerId: "discord-p1", text: "the chest is trapped" } },
      { tenantDb, sessionId: "s", turnId: "t", caller: "llm", surfaces: router },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toEqual({ delivered: true });
    expect(table.emits).toHaveLength(0);
    expect(player.emits).toEqual([
      { audience: { kind: "player", playerId: "discord-p1" }, text: "the chest is trapped" },
    ]);
  });

  it("reports undelivered when no router or whisperPlayer is wired", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const result = await dispatcher.dispatch(
      { name: "whisper", input: { playerId: "discord-p1", text: "psst" } },
      { tenantDb, sessionId: "s", turnId: "t", caller: "llm" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toEqual({ delivered: false });
  });
});
