// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, playerAudience, playerConversation, TenantDb, schema } from "@skeinkeeper/server";
import type { BehaviorSpec } from "../behavior.js";
import { MockFoundryClient } from "../foundry/mock.js";
import { fakeLlmFromEvents } from "../interfaces/fake_llm_provider.js";
import { ToolDispatcher, ToolRegistry } from "../registry.js";
import { startSession, type Session } from "../session.js";
import { FakeInboundSurface, SurfaceRouter } from "../surfaces/index.js";
import { SideChannelCoordinator, SideChannelIdentityMap } from "./coordinator.js";

const SPEC: BehaviorSpec = {
  content: "You are the AI DM.",
  version: "v0.1",
  path: "/test/spec.md",
};

const DONE_USAGE = { inputTokens: 10, outputTokens: 5 };

function setup(): {
  session: Session;
  tenantDb: TenantDb;
  foundry: MockFoundryClient;
  identity: SideChannelIdentityMap;
} {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(schema.tenants).values({ id: "default", name: "Test", createdAt: Date.now() }).run();
  db.insert(schema.campaigns)
    .values({
      id: "c1",
      tenantId: "default",
      name: "Test Campaign",
      rulesetId: "dnd5e",
      behaviorSpecVersion: "v0.1",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  const tenantDb = new TenantDb(db, "default");
  const foundry = new MockFoundryClient({ system: "dnd5e" });
  const identity = new SideChannelIdentityMap();
  identity.bind("discord-p1", "foundry-user-p1");
  const session = startSession({
    sessionId: "sess-1",
    campaignId: "c1",
    behaviorSpec: SPEC,
    llm: fakeLlmFromEvents([
      { kind: "text_delta", text: "Got it — stay quiet." },
      { kind: "done", stopReason: "end_turn", usage: DONE_USAGE },
    ]),
    dispatcher: new ToolDispatcher({ registry: new ToolRegistry() }),
    foundry,
    tenantDb,
  });
  return { session, tenantDb, foundry, identity };
}

async function waitUntil(pred: () => boolean, ms = 500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("SideChannelCoordinator inbound (TDD 0035)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches a mapped Foundry whisper to the player conversation", async () => {
    const { session, tenantDb, identity } = setup();
    const router = new SurfaceRouter();
    const coordinator = new SideChannelCoordinator({ session, router, identity });

    const result = await coordinator.handleEvent({
      kind: "chat.whisper.player-to-dm",
      surface: "foundry-whisper",
      foundryUserId: "foundry-user-p1",
      text: "psst",
    });

    expect(result).toEqual({ dispatched: true, playerId: "discord-p1" });
    const hasher = tenantDb.piiCrypto;
    const rows = tenantDb.dialogue.listByConversation(
      "sess-1",
      playerConversation(hasher, "discord-p1"),
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.speaker).toBe("discord-p1");
    expect(rows[0]?.text).toBe("psst");
    expect(rows[0]?.audience).toBe(playerAudience(hasher, "discord-p1"));
    expect(rows[0]?.conversationId).toBe(playerConversation(hasher, "discord-p1"));
    expect(rows.some((r) => r.audience === "table")).toBe(false);
  });

  it("logs and does not dispatch an unmapped Foundry user", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { session, tenantDb } = setup();
    const router = new SurfaceRouter();
    const coordinator = new SideChannelCoordinator({
      session,
      router,
      identity: new SideChannelIdentityMap(),
    });

    const result = await coordinator.handleEvent({
      kind: "chat.whisper.player-to-dm",
      surface: "foundry-whisper",
      foundryUserId: "foundry-user-unknown",
      text: "psst",
    });

    expect(result.dispatched).toBe(false);
    if (!result.dispatched) expect(result.reason).toBe("unmapped");
    expect(tenantDb.dialogue.listBySession("sess-1")).toHaveLength(0);
    expect(warn.mock.calls.some((c) => String(c[0]).toLowerCase().includes("unmapped"))).toBe(true);
  });

  it("does not dispatch Discord consent or public chat as a side-channel", async () => {
    const { session, tenantDb, identity } = setup();
    const coordinator = new SideChannelCoordinator({
      session,
      router: new SurfaceRouter(),
      identity,
    });

    expect(
      await coordinator.handleEvent({
        kind: "consent.response",
        surface: "discord-consent",
        discordId: "discord-p1",
        decision: "accept",
      }),
    ).toMatchObject({ dispatched: false });
    expect(
      await coordinator.handleEvent({
        kind: "chat.public",
        surface: "foundry-public",
        foundryUserId: "foundry-user-p1",
        text: "I look around.",
      }),
    ).toMatchObject({ dispatched: false });
    expect(tenantDb.dialogue.listBySession("sess-1")).toHaveLength(0);
  });

  it("pumps router.events() chat.whisper.player-to-dm into dispatch", async () => {
    const { session, tenantDb, identity } = setup();
    const router = new SurfaceRouter();
    const inbound = new FakeInboundSurface("foundry-whisper");
    router.register(inbound);
    const coordinator = new SideChannelCoordinator({ session, router, identity });
    const running = coordinator.start();

    inbound.push({
      kind: "chat.whisper.player-to-dm",
      surface: "foundry-whisper",
      foundryUserId: "foundry-user-p1",
      text: "psst",
    });

    await waitUntil(() => tenantDb.dialogue.listBySession("sess-1").length > 0);
    coordinator.stop();
    inbound.close();
    await running;

    const hasher = tenantDb.piiCrypto;
    const rows = tenantDb.dialogue.listByConversation(
      "sess-1",
      playerConversation(hasher, "discord-p1"),
    );
    expect(rows[0]?.text).toBe("psst");
    expect(rows[0]?.audience).toBe(playerAudience(hasher, "discord-p1"));
  });
});
