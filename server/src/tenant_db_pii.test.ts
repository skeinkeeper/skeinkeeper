// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb, type Db } from "./db.js";
import { TenantDb } from "./tenant_db.js";
import { createPiiCrypto, type PiiCrypto } from "./column_crypto.js";
import type { KeySource } from "./secret_store.js";
import {
  auditLog,
  campaigns,
  consents,
  dialogue,
  playerCharacterMap,
  sessions,
  settings,
  tenants,
} from "./schema/index.js";

const SALT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const src = (pass?: string): KeySource => ({ getPassphrase: () => pass });
const enabled = (): PiiCrypto => createPiiCrypto({ keySource: src("pw"), salt: SALT });
const disabled = (): PiiCrypto => createPiiCrypto({ keySource: src(undefined), salt: SALT });

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

describe("TenantDb PII — consents (TDD 0030)", () => {
  it("encrypts subject_id and sets the hash companion on write", () => {
    const { db } = setup();
    const c = enabled();
    new TenantDb(db, "default", c).consents.record({
      subjectId: "discord:42",
      purpose: "voice_processing",
      action: "granted",
      consentTextVersion: "v1",
      timestamp: 1,
    });
    const raw = db.select().from(consents).get();
    expect(raw?.subjectId.startsWith("gcm:")).toBe(true);
    expect(raw?.subjectId).not.toContain("discord:42");
    expect(raw?.subjectIdHash).toBe(c.hash("discord:42"));
  });

  it("sets the hash companion even when encryption is disabled (alpha default)", () => {
    const { db } = setup();
    const c = disabled();
    new TenantDb(db, "default", c).consents.record({
      subjectId: "discord:42",
      purpose: "voice_processing",
      action: "granted",
      consentTextVersion: "v1",
      timestamp: 1,
    });
    const raw = db.select().from(consents).get();
    expect(raw?.subjectId).toBe("discord:42"); // plaintext at rest
    expect(raw?.subjectIdHash).toBe(c.hash("discord:42"));
  });

  it("finds an encrypted consent row by its hash (currentState/isGranted)", () => {
    const { db } = setup();
    const c = enabled();
    db.insert(consents)
      .values({
        tenantId: "default",
        subjectId: c.enc("discord:42"),
        subjectIdHash: c.hash("discord:42"),
        purpose: "voice_processing",
        consentTextVersion: "v1",
        action: "granted",
        timestamp: 1,
      })
      .run();
    expect(
      new TenantDb(db, "default", c).consents.isGranted("discord:42", "voice_processing"),
    ).toBe(true);
  });
});

describe("TenantDb PII — player_character_map (TDD 0030)", () => {
  it("encrypts discord_user_id + display_name and sets the hash on write", () => {
    const { db } = setup();
    const c = enabled();
    new TenantDb(db, "default", c).playerCharacterMap.record({
      campaignId: "c1",
      discordUserId: "discord:42",
      displayName: "Alice",
      foundryActorId: "actor-1",
      source: "player",
      confirmedAt: 1,
    });
    const raw = db.select().from(playerCharacterMap).get();
    expect(raw?.discordUserId.startsWith("gcm:")).toBe(true);
    expect(raw?.displayName?.startsWith("gcm:")).toBe(true);
    expect(raw?.discordUserIdHash).toBe(c.hash("discord:42"));
  });

  it("finds and decrypts an encrypted mapping by hash (currentForPlayer)", () => {
    const { db } = setup();
    const c = enabled();
    db.insert(playerCharacterMap)
      .values({
        tenantId: "default",
        campaignId: "c1",
        discordUserId: c.enc("discord:42"),
        discordUserIdHash: c.hash("discord:42"),
        displayName: c.enc("Alice"),
        foundryActorId: "actor-1",
        source: "player",
        confirmedAt: 1,
      })
      .run();
    const row = new TenantDb(db, "default", c).playerCharacterMap.currentForPlayer(
      "c1",
      "discord:42",
    );
    expect(row?.discordUserId).toBe("discord:42");
    expect(row?.displayName).toBe("Alice");
    expect(row?.foundryActorId).toBe("actor-1");
  });

  it("decrypts mappings on listByCampaign", () => {
    const { db } = setup();
    const c = enabled();
    db.insert(playerCharacterMap)
      .values({
        tenantId: "default",
        campaignId: "c1",
        discordUserId: c.enc("discord:42"),
        discordUserIdHash: c.hash("discord:42"),
        displayName: c.enc("Alice"),
        foundryActorId: "actor-1",
        source: "player",
        confirmedAt: 1,
      })
      .run();
    const rows = new TenantDb(db, "default", c).playerCharacterMap.listByCampaign("c1");
    expect(rows.map((r) => r.discordUserId)).toEqual(["discord:42"]);
    expect(rows.map((r) => r.displayName)).toEqual(["Alice"]);
  });
});

describe("TenantDb PII — dialogue (TDD 0030)", () => {
  it("encrypts speaker/text/display_name and sets speaker_hash on append", () => {
    const { db } = setup();
    const c = enabled();
    new TenantDb(db, "default", c).dialogue.append({
      sessionId: "s1",
      speaker: "discord:42",
      displayName: "Alice",
      text: "hello there",
      timestamp: 1,
    });
    const raw = db.select().from(dialogue).get();
    expect(raw?.speaker.startsWith("gcm:")).toBe(true);
    expect(raw?.text.startsWith("gcm:")).toBe(true);
    expect(raw?.displayName?.startsWith("gcm:")).toBe(true);
    expect(raw?.speakerHash).toBe(c.hash("discord:42"));
  });

  it("decrypts speaker/text/display_name on listBySession and listByConversation", () => {
    const { db } = setup();
    const c = enabled();
    db.insert(dialogue)
      .values({
        tenantId: "default",
        sessionId: "s1",
        speaker: c.enc("discord:42"),
        speakerHash: c.hash("discord:42"),
        displayName: c.enc("Alice"),
        text: c.enc("hello there"),
        timestamp: 1,
        audience: "table",
        conversationId: "table",
      })
      .run();
    const t = new TenantDb(db, "default", c);
    const bySession = t.dialogue.listBySession("s1");
    expect(bySession[0]?.speaker).toBe("discord:42");
    expect(bySession[0]?.text).toBe("hello there");
    expect(bySession[0]?.displayName).toBe("Alice");
    const byConversation = t.dialogue.listByConversation("s1", "table");
    expect(byConversation[0]?.text).toBe("hello there");
  });
});

describe("TenantDb PII — settings + audit_log data columns (TDD 0030)", () => {
  it("encrypts settings.value on write and decrypts on read", () => {
    const { db } = setup();
    const c = enabled();
    const t = new TenantDb(db, "default", c);
    t.settings.set({
      campaignId: "c1",
      key: "operator.discord_user_id",
      value: "discord:operator",
      updatedAt: 1,
    });
    expect(db.select().from(settings).get()?.value.startsWith("gcm:")).toBe(true);
    expect(t.settings.get("c1", "operator.discord_user_id")?.value).toBe("discord:operator");
    expect(t.settings.listByCampaign("c1").map((s) => s.value)).toEqual(["discord:operator"]);
  });

  it("encrypts audit_log.payload_json on append and decrypts on read", () => {
    const { db } = setup();
    const c = enabled();
    const t = new TenantDb(db, "default", c);
    const payload = '{"whisperedTo":"discord:42"}';
    t.auditLog.append({
      sessionId: "s1",
      actor: "ai",
      eventType: "tool_call",
      payloadJson: payload,
      timestamp: 1,
    });
    expect(db.select().from(auditLog).get()?.payloadJson.startsWith("gcm:")).toBe(true);
    expect(t.auditLog.listForSession("s1")[0]?.payloadJson).toBe(payload);
  });
});
