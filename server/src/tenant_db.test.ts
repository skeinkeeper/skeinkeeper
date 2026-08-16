// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { openDb } from "./db.js";
import { TenantDb } from "./tenant_db.js";
import { campaigns, tenants, voiceAssignments } from "./schema/index.js";

function setup(tenantId = "default") {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(tenants).values({ id: tenantId, name: "Test", createdAt: Date.now() }).run();
  return { db, t: new TenantDb(db, tenantId) };
}

function seedCampaign(t: TenantDb, id = "c1") {
  const now = Date.now();
  t.campaigns.create({
    id,
    name: "Test Campaign",
    rulesetId: "dnd5e",
    behaviorSpecVersion: "v0.1",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

describe("TenantDb — campaigns", () => {
  it("creates and lists campaigns scoped by tenant", () => {
    const { t } = setup();
    seedCampaign(t, "phandelver");
    const all = t.campaigns.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.tenantId).toBe("default");
    expect(t.campaigns.get("phandelver")?.name).toBe("Test Campaign");
  });

  it("does not see another tenant's data", () => {
    const { db } = setup("alpha");
    db.insert(tenants).values({ id: "beta", name: "Beta", createdAt: Date.now() }).run();
    const alpha = new TenantDb(db, "alpha");
    const beta = new TenantDb(db, "beta");
    alpha.campaigns.create({
      id: "shared-id",
      name: "Alpha's Campaign",
      rulesetId: "dnd5e",
      behaviorSpecVersion: "v0.1",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(alpha.campaigns.list()).toHaveLength(1);
    expect(beta.campaigns.list()).toHaveLength(0);
    expect(beta.campaigns.get("shared-id")).toBeUndefined();
  });
});

describe("TenantDb — quest flags upsert", () => {
  it("inserts and then updates a flag by key", () => {
    const { t } = setup();
    const now = Date.now();
    seedCampaign(t);
    t.questFlags.set({
      campaignId: "c1",
      key: "phandelver.cragmaw.cleared",
      value: "false",
      updatedAt: now,
    });
    t.questFlags.set({
      campaignId: "c1",
      key: "phandelver.cragmaw.cleared",
      value: "true",
      updatedAt: now + 1,
    });
    const all = t.questFlags.listByCampaign("c1");
    expect(all).toHaveLength(1);
    expect(all[0]?.value).toBe("true");
  });
});

describe("TenantDb — settings upsert/get/delete", () => {
  it("inserts, updates, reads, and deletes a setting by key", () => {
    const { t } = setup();
    const now = Date.now();
    seedCampaign(t);
    t.settings.set({
      campaignId: "c1",
      key: "operator.discord_user_id",
      value: "111",
      updatedAt: now,
    });
    expect(t.settings.get("c1", "operator.discord_user_id")?.value).toBe("111");
    t.settings.set({
      campaignId: "c1",
      key: "operator.discord_user_id",
      value: "222",
      updatedAt: now + 1,
    });
    expect(t.settings.get("c1", "operator.discord_user_id")?.value).toBe("222");
    expect(t.settings.listByCampaign("c1")).toHaveLength(1);
    t.settings.delete("c1", "operator.discord_user_id");
    expect(t.settings.get("c1", "operator.discord_user_id")).toBeUndefined();
  });

  it("cascades away when its campaign is deleted (erasure path)", () => {
    const { db, t } = setup();
    seedCampaign(t);
    t.settings.set({
      campaignId: "c1",
      key: "operator.discord_user_id",
      value: "111",
      updatedAt: Date.now(),
    });
    db.delete(campaigns)
      .where(and(eq(campaigns.tenantId, "default"), eq(campaigns.id, "c1")))
      .run();
    expect(t.settings.listByCampaign("c1")).toHaveLength(0);
  });
});

describe("TenantDb — consents", () => {
  it("returns undefined when no consent event exists", () => {
    const { t } = setup();
    expect(t.consents.currentState("discord:1", "voice_processing")).toBeUndefined();
    expect(t.consents.isGranted("discord:1", "voice_processing")).toBe(false);
  });

  it("reflects the most recent action as current state", () => {
    const { t } = setup();
    const now = Date.now();
    t.consents.record({
      subjectId: "discord:1",
      purpose: "voice_processing",
      action: "granted",
      consentTextVersion: "v1",
      timestamp: now,
    });
    expect(t.consents.isGranted("discord:1", "voice_processing")).toBe(true);

    t.consents.record({
      subjectId: "discord:1",
      purpose: "voice_processing",
      action: "withdrawn",
      consentTextVersion: "v1",
      timestamp: now + 1000,
    });
    expect(t.consents.currentState("discord:1", "voice_processing")).toBe("withdrawn");
    expect(t.consents.isGranted("discord:1", "voice_processing")).toBe(false);
  });

  it("scopes consent state by subject", () => {
    const { t } = setup();
    t.consents.record({
      subjectId: "discord:1",
      purpose: "voice_processing",
      action: "granted",
      consentTextVersion: "v1",
      timestamp: Date.now(),
    });
    expect(t.consents.isGranted("discord:1", "voice_processing")).toBe(true);
    expect(t.consents.isGranted("discord:2", "voice_processing")).toBe(false);
  });

  it("does not leak consent state across tenants", () => {
    const { db } = setup("alpha");
    db.insert(tenants).values({ id: "beta", name: "Beta", createdAt: Date.now() }).run();
    const alpha = new TenantDb(db, "alpha");
    const beta = new TenantDb(db, "beta");
    alpha.consents.record({
      subjectId: "shared",
      purpose: "voice_processing",
      action: "granted",
      consentTextVersion: "v1",
      timestamp: Date.now(),
    });
    expect(alpha.consents.isGranted("shared", "voice_processing")).toBe(true);
    expect(beta.consents.isGranted("shared", "voice_processing")).toBe(false);
  });
});

describe("TenantDb — player↔character map", () => {
  it("returns the most recent mapping for a player", () => {
    const { t } = setup();
    seedCampaign(t);
    const now = Date.now();
    t.playerCharacterMap.record({
      campaignId: "c1",
      discordUserId: "discord:1",
      foundryActorId: "actor-old",
      source: "player",
      confirmedAt: now,
    });
    t.playerCharacterMap.record({
      campaignId: "c1",
      discordUserId: "discord:1",
      foundryActorId: "actor-new",
      source: "operator",
      confirmedAt: now + 1000,
    });
    const current = t.playerCharacterMap.currentForPlayer("c1", "discord:1");
    expect(current?.foundryActorId).toBe("actor-new");
    expect(current?.source).toBe("operator");
  });

  it("returns undefined when a player has no mapping", () => {
    const { t } = setup();
    seedCampaign(t);
    expect(t.playerCharacterMap.currentForPlayer("c1", "discord:unknown")).toBeUndefined();
  });

  it("scopes mappings by campaign", () => {
    const { t } = setup();
    seedCampaign(t, "c1");
    seedCampaign(t, "c2");
    const now = Date.now();
    t.playerCharacterMap.record({
      campaignId: "c1",
      discordUserId: "discord:1",
      foundryActorId: "actor-a",
      source: "player",
      confirmedAt: now,
    });
    t.playerCharacterMap.record({
      campaignId: "c2",
      discordUserId: "discord:1",
      foundryActorId: "actor-b",
      source: "player",
      confirmedAt: now,
    });
    expect(t.playerCharacterMap.currentForPlayer("c1", "discord:1")?.foundryActorId).toBe(
      "actor-a",
    );
    expect(t.playerCharacterMap.listByCampaign("c1")).toHaveLength(1);
  });

  it("does not leak mappings across tenants", () => {
    const { db } = setup("alpha");
    db.insert(tenants).values({ id: "beta", name: "Beta", createdAt: Date.now() }).run();
    const alpha = new TenantDb(db, "alpha");
    const beta = new TenantDb(db, "beta");
    seedCampaign(alpha, "shared-campaign");
    alpha.playerCharacterMap.record({
      campaignId: "shared-campaign",
      discordUserId: "discord:1",
      foundryActorId: "actor-a",
      source: "player",
      confirmedAt: Date.now(),
    });
    expect(alpha.playerCharacterMap.currentForPlayer("shared-campaign", "discord:1")).toBeDefined();
    expect(
      beta.playerCharacterMap.currentForPlayer("shared-campaign", "discord:1"),
    ).toBeUndefined();
  });

  it("persists and returns foundryUserId on the 3-way map (TDD 0036)", () => {
    const { t } = setup();
    seedCampaign(t);
    t.playerCharacterMap.record({
      campaignId: "c1",
      discordUserId: "discord:1",
      foundryUserId: "foundry-user-1",
      foundryActorId: "actor-a",
      source: "player",
      confirmedAt: Date.now(),
    });
    const current = t.playerCharacterMap.currentForPlayer("c1", "discord:1");
    expect(current?.foundryUserId).toBe("foundry-user-1");
    expect(current?.foundryActorId).toBe("actor-a");
    expect(t.playerCharacterMap.currentForFoundryUser("c1", "foundry-user-1")?.discordUserId).toBe(
      "discord:1",
    );
  });

  it("treats a missing foundryUserId as null (pre-migration / unbound)", () => {
    const { t } = setup();
    seedCampaign(t);
    t.playerCharacterMap.record({
      campaignId: "c1",
      discordUserId: "discord:1",
      foundryActorId: "actor-a",
      source: "player",
      confirmedAt: Date.now(),
    });
    expect(t.playerCharacterMap.currentForPlayer("c1", "discord:1")?.foundryUserId ?? null).toBe(
      null,
    );
  });
});

describe("TenantDb — voice assignments", () => {
  it("upserts a subject's voice (most recent wins)", () => {
    const { t } = setup();
    seedCampaign(t);
    const now = Date.now();
    t.voiceAssignments.upsert({
      campaignId: "c1",
      subjectKind: "dm",
      subjectKey: "dm",
      providerVoiceId: "voice-a",
      personaId: "warm-storyteller",
      source: "operator",
      assignedAt: now,
    });
    t.voiceAssignments.upsert({
      campaignId: "c1",
      subjectKind: "dm",
      subjectKey: "dm",
      providerVoiceId: "voice-b",
      personaId: "measured-sage",
      source: "operator",
      assignedAt: now + 1000,
    });
    const dm = t.voiceAssignments.get("c1", "dm", "dm");
    expect(dm?.providerVoiceId).toBe("voice-b");
    expect(dm?.personaId).toBe("measured-sage");
    expect(t.voiceAssignments.listByCampaign("c1")).toHaveLength(1);
  });

  it("keeps DM and NPC assignments distinct", () => {
    const { t } = setup();
    seedCampaign(t);
    const now = Date.now();
    t.voiceAssignments.upsert({
      campaignId: "c1",
      subjectKind: "dm",
      subjectKey: "dm",
      providerVoiceId: "dm-voice",
      personaId: "warm-storyteller",
      source: "operator",
      assignedAt: now,
    });
    t.voiceAssignments.upsert({
      campaignId: "c1",
      subjectKind: "npc",
      subjectKey: "sildar",
      providerVoiceId: "npc-voice",
      source: "ai",
      assignedAt: now,
    });
    expect(t.voiceAssignments.listByCampaign("c1")).toHaveLength(2);
    const npc = t.voiceAssignments.get("c1", "npc", "sildar");
    expect(npc?.providerVoiceId).toBe("npc-voice");
    expect(npc?.personaId).toBeNull();
  });

  it("cascades on campaign deletion (the documented erasure path)", () => {
    const { db, t } = setup();
    seedCampaign(t);
    t.voiceAssignments.upsert({
      campaignId: "c1",
      subjectKind: "npc",
      subjectKey: "klarg",
      providerVoiceId: "v",
      source: "ai",
      assignedAt: Date.now(),
    });
    db.delete(campaigns)
      .where(and(eq(campaigns.tenantId, "default"), eq(campaigns.id, "c1")))
      .run();
    expect(db.select().from(voiceAssignments).all()).toHaveLength(0);
  });
});

describe("TenantDb — audit log append-only", () => {
  it("appends entries scoped to tenant and session", () => {
    const { t } = setup();
    const now = Date.now();
    t.auditLog.append({
      sessionId: "sess-1",
      actor: "tool:roll",
      eventType: "tool_called",
      payloadJson: JSON.stringify({ formula: "1d20+3", result: 17 }),
      timestamp: now,
    });
    t.auditLog.append({
      sessionId: "sess-1",
      actor: "tool:apply_damage",
      eventType: "tool_called",
      payloadJson: JSON.stringify({ target: "goblin-1", amount: 4 }),
      timestamp: now + 1,
    });
    const entries = t.auditLog.listForSession("sess-1");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.actor).toBe("tool:roll");
  });
});

describe("TenantDb — dialogue conversations + audience (design doc 0026)", () => {
  function seedSession(t: TenantDb): void {
    seedCampaign(t);
    t.sessions.create({
      id: "s1",
      campaignId: "c1",
      behaviorSpecVersion: "v0.1",
      startedAt: Date.now(),
    });
  }

  it("append defaults audience + conversationId to 'table'", () => {
    const { t } = setup();
    seedSession(t);
    t.dialogue.append({ sessionId: "s1", speaker: "discord:1", text: "hi", timestamp: 1 });
    const row = t.dialogue.listBySession("s1")[0];
    expect(row?.audience).toBe("table");
    expect(row?.conversationId).toBe("table");
  });

  it("listByConversation returns only that thread's turns; listBySession returns the whole transcript", () => {
    const { t } = setup();
    seedSession(t);
    t.dialogue.append({ sessionId: "s1", speaker: "discord:1", text: "table 1", timestamp: 1 });
    t.dialogue.append({
      sessionId: "s1",
      speaker: "narrator",
      text: "dm to dana",
      timestamp: 2,
      audience: "player:discord:1",
      conversationId: "player:discord:1",
    });
    t.dialogue.append({ sessionId: "s1", speaker: "narrator", text: "table 2", timestamp: 3 });

    expect(t.dialogue.listByConversation("s1", "table").map((r) => r.text)).toEqual([
      "table 1",
      "table 2",
    ]);
    const dana = t.dialogue.listByConversation("s1", "player:discord:1");
    expect(dana.map((r) => r.text)).toEqual(["dm to dana"]);
    expect(dana[0]?.audience).toBe("player:discord:1");

    // The full transcript (replay / export) still sees every conversation.
    expect(t.dialogue.listBySession("s1")).toHaveLength(3);
  });
});
