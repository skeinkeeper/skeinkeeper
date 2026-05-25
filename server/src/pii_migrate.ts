// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { eq } from "drizzle-orm";
import type { Db } from "./db.js";
import type { PiiCrypto } from "./column_crypto.js";
import { isPlayerScoped, playerAudience, playerIdOf } from "./audience.js";
import { auditLog, consents, dialogue, playerCharacterMap, settings } from "./schema/index.js";

/**
 * One-shot `pii:encrypt` migration (TDD 0030). Walks every PII table across all
 * tenants, encrypts the values, backfills the salted `_hash` companions, and
 * rewrites legacy `player:<rawId>` routing tokens to `player:<hash>`. Operates on
 * raw columns (cross-tenant), so it deliberately bypasses the tenant-scoped query
 * layer — this is migration tooling, not request handling.
 *
 * Idempotent: a value already tagged as ciphertext (`gcm:`) means the row was
 * written by an encryption-enabled TenantDb, which already set the hash and the
 * hashed token, so the row is skipped. Re-running touches nothing.
 */
export interface PiiMigrateResult {
  consents: number;
  playerCharacterMap: number;
  dialogue: number;
  settings: number;
  auditLog: number;
}

const HASHED_TOKEN = /^[0-9a-f]{64}$/;

function isCiphertext(value: string): boolean {
  return value.startsWith("gcm:");
}

/**
 * Rewrite a `player:<rawId>` routing token to `player:<hash>`. Idempotent: an
 * already-hashed token (64-hex suffix) and non-player tokens pass through
 * unchanged, so a double hash can never happen.
 */
function rewriteToken(crypto: PiiCrypto, token: string): string {
  if (!isPlayerScoped(token)) return token;
  const suffix = playerIdOf(token);
  if (suffix === null || HASHED_TOKEN.test(suffix)) return token;
  return playerAudience(crypto, suffix);
}

export function encryptPiiColumns(db: Db, crypto: PiiCrypto): PiiMigrateResult {
  const result: PiiMigrateResult = {
    consents: 0,
    playerCharacterMap: 0,
    dialogue: 0,
    settings: 0,
    auditLog: 0,
  };

  for (const row of db.select().from(consents).all()) {
    if (isCiphertext(row.subjectId)) continue;
    db.update(consents)
      .set({ subjectId: crypto.enc(row.subjectId), subjectIdHash: crypto.hash(row.subjectId) })
      .where(eq(consents.id, row.id))
      .run();
    result.consents++;
  }

  for (const row of db.select().from(playerCharacterMap).all()) {
    if (isCiphertext(row.discordUserId)) continue;
    db.update(playerCharacterMap)
      .set({
        discordUserId: crypto.enc(row.discordUserId),
        discordUserIdHash: crypto.hash(row.discordUserId),
        ...(row.displayName !== null ? { displayName: crypto.enc(row.displayName) } : {}),
      })
      .where(eq(playerCharacterMap.id, row.id))
      .run();
    result.playerCharacterMap++;
  }

  for (const row of db.select().from(dialogue).all()) {
    if (isCiphertext(row.speaker)) continue;
    db.update(dialogue)
      .set({
        speaker: crypto.enc(row.speaker),
        speakerHash: crypto.hash(row.speaker),
        text: crypto.enc(row.text),
        ...(row.displayName !== null ? { displayName: crypto.enc(row.displayName) } : {}),
        audience: rewriteToken(crypto, row.audience),
        conversationId: rewriteToken(crypto, row.conversationId),
      })
      .where(eq(dialogue.id, row.id))
      .run();
    result.dialogue++;
  }

  for (const row of db.select().from(settings).all()) {
    if (isCiphertext(row.value)) continue;
    db.update(settings)
      .set({ value: crypto.enc(row.value) })
      .where(eq(settings.id, row.id))
      .run();
    result.settings++;
  }

  for (const row of db.select().from(auditLog).all()) {
    if (isCiphertext(row.payloadJson)) continue;
    db.update(auditLog)
      .set({ payloadJson: crypto.enc(row.payloadJson) })
      .where(eq(auditLog.id, row.id))
      .run();
    result.auditLog++;
  }

  return result;
}
