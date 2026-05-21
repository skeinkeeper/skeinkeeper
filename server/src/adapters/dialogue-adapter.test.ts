// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { openDb, type Db } from "../db.js";
import { TenantDb } from "../tenant_db.js";
import { campaigns, dialogue, sessions, tenants } from "../schema/index.js";
import { DialogueAdapter } from "./dialogue-adapter.js";

function setup(): { db: Db } {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(tenants).values({ id: "default", name: "T", createdAt: Date.now() }).run();
  db.insert(campaigns)
    .values({
      id: "c1",
      tenantId: "default",
      name: "C",
      rulesetId: "dnd5e",
      behaviorSpecVersion: "v0.1",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(sessions)
    .values({
      id: "s1",
      tenantId: "default",
      campaignId: "c1",
      behaviorSpecVersion: "v0.1",
      startedAt: Date.now(),
    })
    .run();
  return { db };
}

function seedDialogue(db: Db): void {
  const t = new TenantDb(db, "default");
  const base = Date.now();
  t.dialogue.append({
    sessionId: "s1",
    speaker: "discord:alice",
    text: "Alice line 1",
    timestamp: base,
  });
  t.dialogue.append({
    sessionId: "s1",
    speaker: "narrator",
    text: "Narration",
    timestamp: base + 1,
  });
  t.dialogue.append({
    sessionId: "s1",
    speaker: "discord:bob",
    text: "Bob line",
    timestamp: base + 2,
  });
  t.dialogue.append({
    sessionId: "s1",
    speaker: "discord:alice",
    text: "Alice line 2",
    timestamp: base + 3,
  });
}

describe("DialogueAdapter — delete", () => {
  it("player scope deletes only that speaker's lines", async () => {
    const { db } = setup();
    seedDialogue(db);
    const adapter = new DialogueAdapter(db);
    const deleted = await adapter.delete({
      kind: "player",
      tenantId: "default",
      subjectId: "discord:alice",
    });
    expect(deleted).toBe(2);
    const remaining = db.select().from(dialogue).all();
    expect(remaining.map((r) => r.speaker).sort()).toEqual(["discord:bob", "narrator"]);
  });

  it("player scope also deletes the DM's private side-channel replies to that player (ADR-0017)", async () => {
    const { db } = setup();
    const t = new TenantDb(db, "default");
    const base = Date.now();
    // Alice's own line at the table.
    t.dialogue.append({
      sessionId: "s1",
      speaker: "discord:alice",
      text: "table line",
      timestamp: base,
    });
    // The DM's PRIVATE reply addressed to Alice — spoken by "narrator" but
    // audience player:discord:alice. Must be erased on Alice's request.
    t.dialogue.append({
      sessionId: "s1",
      speaker: "narrator",
      text: "psst, the chest is trapped",
      timestamp: base + 1,
      audience: "player:discord:alice",
      conversationId: "player:discord:alice",
    });
    // A shared narration (audience defaults to table) — must persist.
    t.dialogue.append({
      sessionId: "s1",
      speaker: "narrator",
      text: "shared narration",
      timestamp: base + 2,
    });
    // Bob's private reply — another player's content, must persist.
    t.dialogue.append({
      sessionId: "s1",
      speaker: "narrator",
      text: "for bob only",
      timestamp: base + 3,
      audience: "player:discord:bob",
      conversationId: "player:discord:bob",
    });

    const adapter = new DialogueAdapter(db);
    const deleted = await adapter.delete({
      kind: "player",
      tenantId: "default",
      subjectId: "discord:alice",
    });
    expect(deleted).toBe(2); // Alice's table line + the DM's private-to-Alice reply
    const remaining = db.select().from(dialogue).all();
    expect(remaining.map((r) => r.text).sort()).toEqual(["for bob only", "shared narration"]);
  });

  it("tenant scope deletes all dialogue for the tenant", async () => {
    const { db } = setup();
    seedDialogue(db);
    const adapter = new DialogueAdapter(db);
    const deleted = await adapter.delete({ kind: "tenant", tenantId: "default" });
    expect(deleted).toBe(4);
    expect(db.select().from(dialogue).all()).toHaveLength(0);
  });

  it("campaign scope is a no-op for this adapter (handled by FK cascade)", async () => {
    const { db } = setup();
    seedDialogue(db);
    const adapter = new DialogueAdapter(db);
    const deleted = await adapter.delete({
      kind: "campaign",
      tenantId: "default",
      campaignId: "c1",
    });
    expect(deleted).toBe(0);
  });

  it("deleting the campaign cascades to dialogue via FK", async () => {
    const { db } = setup();
    seedDialogue(db);
    db.delete(campaigns)
      .where(and(eq(campaigns.tenantId, "default"), eq(campaigns.id, "c1")))
      .run();
    expect(db.select().from(dialogue).all()).toHaveLength(0);
  });
});

describe("DialogueAdapter — export", () => {
  it("player scope returns only that speaker's lines", async () => {
    const { db } = setup();
    seedDialogue(db);
    const adapter = new DialogueAdapter(db);
    const payload = await adapter.export({
      kind: "player",
      tenantId: "default",
      subjectId: "discord:alice",
    });
    expect(payload.data).toHaveLength(2);
    expect((payload.summary ?? []).join(" ")).toContain("2 dialogue line");
  });
});
