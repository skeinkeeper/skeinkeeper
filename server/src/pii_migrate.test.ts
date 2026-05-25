// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import { openDb, type Db } from "./db.js";
import { TenantDb } from "./tenant_db.js";
import { createPiiCrypto } from "./column_crypto.js";
import { playerConversation } from "./audience.js";
import { encryptPiiColumns } from "./pii_migrate.js";
import {
  auditLog,
  campaigns,
  consents,
  dialogue,
  playerCharacterMap,
  settings,
  sessions,
  tenants,
} from "./schema/index.js";

const SALT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const crypto = () => createPiiCrypto({ keySource: { getPassphrase: () => "pw" }, salt: SALT });

/** Seed a "legacy" plaintext DB: raw rows, no hash companions, raw audience tokens. */
function seedLegacy(): Db {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(tenants).values({ id: "default", name: "T", createdAt: 1 }).run();
  db.insert(campaigns)
    .values({
      id: "c1",
      tenantId: "default",
      name: "C",
      rulesetId: "dnd5e",
      behaviorSpecVersion: "v0.1",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  db.insert(sessions)
    .values({
      id: "s1",
      tenantId: "default",
      campaignId: "c1",
      behaviorSpecVersion: "v0.1",
      startedAt: 1,
    })
    .run();
  db.insert(consents)
    .values({
      tenantId: "default",
      subjectId: "discord:42",
      purpose: "voice_processing",
      consentTextVersion: "v1",
      action: "granted",
      timestamp: 1,
    })
    .run();
  db.insert(playerCharacterMap)
    .values({
      tenantId: "default",
      campaignId: "c1",
      discordUserId: "discord:42",
      displayName: "Alice",
      foundryActorId: "actor-1",
      source: "player",
      confirmedAt: 1,
    })
    .run();
  db.insert(dialogue)
    .values({
      tenantId: "default",
      sessionId: "s1",
      speaker: "discord:42",
      displayName: "Alice",
      text: "hello table",
      timestamp: 1,
      audience: "table",
      conversationId: "table",
    })
    .run();
  // A DM private reply addressed to discord:42 with a legacy raw token.
  db.insert(dialogue)
    .values({
      tenantId: "default",
      sessionId: "s1",
      speaker: "narrator",
      text: "psst, the chest is trapped",
      timestamp: 2,
      audience: "player:discord:42",
      conversationId: "player:discord:42",
    })
    .run();
  db.insert(settings)
    .values({
      tenantId: "default",
      campaignId: "c1",
      key: "operator.discord_user_id",
      value: "discord:op",
      updatedAt: 1,
    })
    .run();
  db.insert(auditLog)
    .values({
      tenantId: "default",
      sessionId: "s1",
      actor: "ai",
      eventType: "tool_call",
      payloadJson: '{"whisperedTo":"discord:42"}',
      timestamp: 1,
    })
    .run();
  return db;
}

describe("encryptPiiColumns (pii:encrypt migration, TDD 0030)", () => {
  it("encrypts values, fills hash companions, and rewrites audience tokens", () => {
    const db = seedLegacy();
    const c = crypto();
    const result = encryptPiiColumns(db, c);

    expect(result.consents).toBe(1);
    expect(result.playerCharacterMap).toBe(1);
    expect(result.dialogue).toBe(2);
    expect(result.settings).toBe(1);
    expect(result.auditLog).toBe(1);

    const consent = db.select().from(consents).get();
    expect(consent?.subjectId.startsWith("gcm:")).toBe(true);
    expect(consent?.subjectIdHash).toBe(c.hash("discord:42"));

    const pcmap = db.select().from(playerCharacterMap).get();
    expect(pcmap?.discordUserId.startsWith("gcm:")).toBe(true);
    expect(pcmap?.displayName?.startsWith("gcm:")).toBe(true);
    expect(pcmap?.discordUserIdHash).toBe(c.hash("discord:42"));

    const rows = db.select().from(dialogue).orderBy(asc(dialogue.timestamp)).all();
    expect(rows[0]?.speaker.startsWith("gcm:")).toBe(true);
    expect(rows[0]?.text.startsWith("gcm:")).toBe(true);
    expect(rows[0]?.speakerHash).toBe(c.hash("discord:42"));
    // Routing tokens rewritten from the raw id to the hashed form.
    expect(rows[1]?.audience).toBe(`player:${c.hash("discord:42")}`);
    expect(rows[1]?.conversationId).toBe(`player:${c.hash("discord:42")}`);

    expect(db.select().from(settings).get()?.value.startsWith("gcm:")).toBe(true);
    expect(db.select().from(auditLog).get()?.payloadJson.startsWith("gcm:")).toBe(true);
  });

  it("leaves the data queryable + decryptable through TenantDb after migration", () => {
    const db = seedLegacy();
    const c = crypto();
    encryptPiiColumns(db, c);
    const t = new TenantDb(db, "default", c);

    expect(t.consents.isGranted("discord:42", "voice_processing")).toBe(true);
    expect(t.playerCharacterMap.currentForPlayer("c1", "discord:42")?.displayName).toBe("Alice");
    expect(t.settings.get("c1", "operator.discord_user_id")?.value).toBe("discord:op");
    expect(t.auditLog.listForSession("s1").map((r) => r.payloadJson)).toContain(
      '{"whisperedTo":"discord:42"}',
    );
    const thread = t.dialogue.listByConversation("s1", playerConversation(c, "discord:42"));
    expect(thread.map((r) => r.text)).toEqual(["psst, the chest is trapped"]);
  });

  it("is idempotent — a second run touches nothing", () => {
    const db = seedLegacy();
    const c = crypto();
    encryptPiiColumns(db, c);
    const cipher = db.select().from(consents).get()?.subjectId;

    const again = encryptPiiColumns(db, c);
    expect(again).toEqual({
      consents: 0,
      playerCharacterMap: 0,
      dialogue: 0,
      settings: 0,
      auditLog: 0,
    });
    // Untouched: ciphertext is identical (not re-encrypted), data still readable.
    expect(db.select().from(consents).get()?.subjectId).toBe(cipher);
    expect(
      new TenantDb(db, "default", c).consents.isGranted("discord:42", "voice_processing"),
    ).toBe(true);
  });
});
