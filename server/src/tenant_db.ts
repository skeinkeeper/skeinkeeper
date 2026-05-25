// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { and, asc, desc, eq, or } from "drizzle-orm";
import type { Db } from "./db.js";
import { defaultPiiCrypto, type PiiCrypto } from "./column_crypto.js";
import { decryptDialogueRow, decryptPcmapRow } from "./pii_columns.js";
import {
  campaigns,
  consents,
  dialogue,
  playerCharacterMap,
  questFlags,
  settings,
  sessions,
  voiceAssignments,
  auditLog,
  type Action,
  type NewCampaign,
  type NewDialogueRow,
  type NewPlayerCharacterMapRow,
  type NewQuestFlag,
  type NewSetting,
  type NewSession,
  type NewVoiceAssignmentRow,
  type NewAuditLogEntry,
  type Purpose,
} from "./schema/index.js";

/**
 * Tenant-scoped access to the database. The orchestrator, plugins, and CLI
 * receive a TenantDb instance from the bootstrap layer and never see the
 * raw Db — every read and write goes through here and is implicitly
 * scoped by tenantId. Per ADR-0008.
 *
 * Per design doc 0007, mechanical state (characters, NPCs, locations,
 * faction relationships) lives in Foundry, accessed via FoundryClient.
 * This wrapper covers AI-DM-specific state only: campaigns, sessions,
 * audit log, consents (separate adapter), and quest flags.
 *
 * Application code that needs to break out (migrations, operator tools
 * that span tenants) uses unsafelyAcrossTenants() — grep-able, code-review
 * gated.
 */
export class TenantDb {
  constructor(
    private readonly db: Db,
    public readonly tenantId: string,
    /**
     * Per-column PII crypto (TDD 0030). Encrypts PII columns on write and
     * decrypts on read; supplies the salted hash companion that equality lookups
     * and erasure match on. Defaults to a disabled (plaintext-passthrough)
     * instance; bootstrap injects the real one built from the per-install salt +
     * passphrase KeySource.
     */
    public readonly piiCrypto: PiiCrypto = defaultPiiCrypto(),
  ) {}

  // ---- campaigns ----
  readonly campaigns = {
    list: () => this.db.select().from(campaigns).where(eq(campaigns.tenantId, this.tenantId)).all(),
    get: (id: string) =>
      this.db
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.tenantId, this.tenantId), eq(campaigns.id, id)))
        .get(),
    create: (data: Omit<NewCampaign, "tenantId">) =>
      this.db
        .insert(campaigns)
        .values({ ...data, tenantId: this.tenantId })
        .run(),
  };

  // ---- quest flags ----
  readonly questFlags = {
    listByCampaign: (campaignId: string) =>
      this.db
        .select()
        .from(questFlags)
        .where(and(eq(questFlags.tenantId, this.tenantId), eq(questFlags.campaignId, campaignId)))
        .all(),
    set: (data: Omit<NewQuestFlag, "tenantId" | "id">) =>
      this.db
        .insert(questFlags)
        .values({ ...data, tenantId: this.tenantId })
        .onConflictDoUpdate({
          target: [questFlags.tenantId, questFlags.campaignId, questFlags.key],
          set: { value: data.value, updatedAt: data.updatedAt },
        })
        .run(),
  };

  // ---- settings (operator-settable config; design doc 0024) ----
  // `value` may hold operator PII (TDD 0030): AEAD on write, decrypt on read.
  readonly settings = {
    get: (campaignId: string, key: string) => {
      const row = this.db
        .select()
        .from(settings)
        .where(
          and(
            eq(settings.tenantId, this.tenantId),
            eq(settings.campaignId, campaignId),
            eq(settings.key, key),
          ),
        )
        .get();
      return row === undefined ? undefined : { ...row, value: this.piiCrypto.dec(row.value) };
    },
    set: (data: Omit<NewSetting, "tenantId" | "id">) => {
      const value = this.piiCrypto.enc(data.value);
      return this.db
        .insert(settings)
        .values({ ...data, value, tenantId: this.tenantId })
        .onConflictDoUpdate({
          target: [settings.tenantId, settings.campaignId, settings.key],
          set: { value, updatedAt: data.updatedAt },
        })
        .run();
    },
    delete: (campaignId: string, key: string) =>
      this.db
        .delete(settings)
        .where(
          and(
            eq(settings.tenantId, this.tenantId),
            eq(settings.campaignId, campaignId),
            eq(settings.key, key),
          ),
        )
        .run(),
    listByCampaign: (campaignId: string) =>
      this.db
        .select()
        .from(settings)
        .where(and(eq(settings.tenantId, this.tenantId), eq(settings.campaignId, campaignId)))
        .all()
        .map((row) => ({ ...row, value: this.piiCrypto.dec(row.value) })),
  };

  // ---- sessions ----
  readonly sessions = {
    listByCampaign: (campaignId: string) =>
      this.db
        .select()
        .from(sessions)
        .where(and(eq(sessions.tenantId, this.tenantId), eq(sessions.campaignId, campaignId)))
        .all(),
    get: (id: string) =>
      this.db
        .select()
        .from(sessions)
        .where(and(eq(sessions.tenantId, this.tenantId), eq(sessions.id, id)))
        .get(),
    create: (data: Omit<NewSession, "tenantId">) =>
      this.db
        .insert(sessions)
        .values({ ...data, tenantId: this.tenantId })
        .run(),
    /** Mark a session ended. Sets endedAt and (optionally) the summary. */
    end: (id: string, endedAt: number, summaryJson?: string) =>
      this.db
        .update(sessions)
        .set({ endedAt, ...(summaryJson !== undefined ? { summaryJson } : {}) })
        .where(and(eq(sessions.tenantId, this.tenantId), eq(sessions.id, id)))
        .run(),
  };

  // ---- dialogue (append-only transcript) ----
  // `speaker`/`text`/`displayName` are PII (TDD 0030): AEAD on write, decrypt on
  // read; `speakerHash` is the key-free companion for per-speaker erasure.
  // `audience`/`conversationId` are routing tokens (already hashed by the caller)
  // and stay plaintext for equality matching.
  readonly dialogue = {
    append: (entry: Omit<NewDialogueRow, "tenantId" | "id">) =>
      this.db
        .insert(dialogue)
        .values({
          ...entry,
          tenantId: this.tenantId,
          speaker: this.piiCrypto.enc(entry.speaker),
          speakerHash: this.piiCrypto.hash(entry.speaker),
          text: this.piiCrypto.enc(entry.text),
          ...(entry.displayName != null
            ? { displayName: this.piiCrypto.enc(entry.displayName) }
            : {}),
        })
        .run(),
    /** All turns across every conversation in a session (resume / replay /
     *  export). Ordered oldest-first. */
    listBySession: (sessionId: string) =>
      this.db
        .select()
        .from(dialogue)
        .where(and(eq(dialogue.tenantId, this.tenantId), eq(dialogue.sessionId, sessionId)))
        .orderBy(asc(dialogue.timestamp), asc(dialogue.id))
        .all()
        .map((row) => decryptDialogueRow(this.piiCrypto, row)),
    /** Turns scoped to one conversation thread (the table loop, or a player's
     *  1:1 side-channel) — design doc 0026 §2. Ordered oldest-first. */
    listByConversation: (sessionId: string, conversationId: string) =>
      this.db
        .select()
        .from(dialogue)
        .where(
          and(
            eq(dialogue.tenantId, this.tenantId),
            eq(dialogue.sessionId, sessionId),
            eq(dialogue.conversationId, conversationId),
          ),
        )
        .orderBy(asc(dialogue.timestamp), asc(dialogue.id))
        .all()
        .map((row) => decryptDialogueRow(this.piiCrypto, row)),
  };

  // ---- player↔character map (most recent row per player wins) ----
  // `discordUserId`/`displayName` are PII (TDD 0030): AEAD on write, decrypt on
  // read; lookup matches the key-free `discordUserIdHash` companion (with a
  // plaintext fallback for legacy rows written before the companion existed).
  readonly playerCharacterMap = {
    record: (data: Omit<NewPlayerCharacterMapRow, "tenantId" | "id">) =>
      this.db
        .insert(playerCharacterMap)
        .values({
          ...data,
          tenantId: this.tenantId,
          discordUserId: this.piiCrypto.enc(data.discordUserId),
          discordUserIdHash: this.piiCrypto.hash(data.discordUserId),
          ...(data.displayName != null
            ? { displayName: this.piiCrypto.enc(data.displayName) }
            : {}),
        })
        .run(),
    currentForPlayer: (campaignId: string, discordUserId: string) => {
      const row = this.db
        .select()
        .from(playerCharacterMap)
        .where(
          and(
            eq(playerCharacterMap.tenantId, this.tenantId),
            eq(playerCharacterMap.campaignId, campaignId),
            or(
              eq(playerCharacterMap.discordUserIdHash, this.piiCrypto.hash(discordUserId)),
              eq(playerCharacterMap.discordUserId, discordUserId),
            ),
          ),
        )
        .orderBy(desc(playerCharacterMap.confirmedAt), desc(playerCharacterMap.id))
        .limit(1)
        .get();
      return row === undefined ? undefined : decryptPcmapRow(this.piiCrypto, row);
    },
    listByCampaign: (campaignId: string) =>
      this.db
        .select()
        .from(playerCharacterMap)
        .where(
          and(
            eq(playerCharacterMap.tenantId, this.tenantId),
            eq(playerCharacterMap.campaignId, campaignId),
          ),
        )
        .all()
        .map((row) => decryptPcmapRow(this.piiCrypto, row)),
  };

  // ---- voice assignments (one row per subject; upsert on remap) ----
  readonly voiceAssignments = {
    upsert: (data: Omit<NewVoiceAssignmentRow, "tenantId" | "id">) =>
      this.db
        .insert(voiceAssignments)
        .values({ ...data, tenantId: this.tenantId })
        .onConflictDoUpdate({
          target: [
            voiceAssignments.tenantId,
            voiceAssignments.campaignId,
            voiceAssignments.subjectKind,
            voiceAssignments.subjectKey,
          ],
          set: {
            providerVoiceId: data.providerVoiceId,
            personaId: data.personaId ?? null,
            source: data.source,
            assignedAt: data.assignedAt,
          },
        })
        .run(),
    get: (campaignId: string, subjectKind: string, subjectKey: string) =>
      this.db
        .select()
        .from(voiceAssignments)
        .where(
          and(
            eq(voiceAssignments.tenantId, this.tenantId),
            eq(voiceAssignments.campaignId, campaignId),
            eq(voiceAssignments.subjectKind, subjectKind),
            eq(voiceAssignments.subjectKey, subjectKey),
          ),
        )
        .get(),
    listByCampaign: (campaignId: string) =>
      this.db
        .select()
        .from(voiceAssignments)
        .where(
          and(
            eq(voiceAssignments.tenantId, this.tenantId),
            eq(voiceAssignments.campaignId, campaignId),
          ),
        )
        .all(),
  };

  // ---- consents (append-only event log; current state = most recent row) ----
  // `subjectId` is PII (TDD 0030): AEAD on write; lookup matches the key-free
  // `subjectIdHash` companion (plaintext fallback for legacy rows).
  readonly consents = {
    /** Record a consent event (granting or withdrawing). Append-only. */
    record: (data: {
      subjectId: string;
      purpose: Purpose;
      action: Action;
      consentTextVersion: string;
      timestamp: number;
      metadata?: string;
    }) =>
      this.db
        .insert(consents)
        .values({
          ...data,
          tenantId: this.tenantId,
          subjectId: this.piiCrypto.enc(data.subjectId),
          subjectIdHash: this.piiCrypto.hash(data.subjectId),
        })
        .run(),
    /** The most recent action for a (subject, purpose), or undefined if no
     *  consent event has ever been recorded. */
    currentState: (subjectId: string, purpose: Purpose): Action | undefined => {
      const row = this.db
        .select()
        .from(consents)
        .where(
          and(
            eq(consents.tenantId, this.tenantId),
            or(
              eq(consents.subjectIdHash, this.piiCrypto.hash(subjectId)),
              eq(consents.subjectId, subjectId),
            ),
            eq(consents.purpose, purpose),
          ),
        )
        .orderBy(desc(consents.timestamp), desc(consents.id))
        .limit(1)
        .get();
      return row?.action as Action | undefined;
    },
    /** Convenience: is consent currently granted for (subject, purpose)? */
    isGranted: (subjectId: string, purpose: Purpose): boolean =>
      this.consents.currentState(subjectId, purpose) === "granted",
  };

  // ---- audit log (append-only) ----
  // `payloadJson` may embed PII (TDD 0030): AEAD on write, decrypt on read.
  // Deletion is tenant-scoped (by tenant_id), so it never needs the key.
  readonly auditLog = {
    append: (entry: Omit<NewAuditLogEntry, "tenantId" | "id">) =>
      this.db
        .insert(auditLog)
        .values({
          ...entry,
          tenantId: this.tenantId,
          ...(entry.payloadJson !== undefined
            ? { payloadJson: this.piiCrypto.enc(entry.payloadJson) }
            : {}),
        })
        .run(),
    listForSession: (sessionId: string) =>
      this.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, this.tenantId), eq(auditLog.sessionId, sessionId)))
        .all()
        .map((row) => ({ ...row, payloadJson: this.piiCrypto.dec(row.payloadJson) })),
  };

  /**
   * Escape hatch. Grep-able by name (`unsafelyAcrossTenants`). Use only
   * for migrations and operator-wide tooling; every callsite needs code
   * review per ADR-0008.
   */
  unsafelyAcrossTenants<T>(fn: (db: Db) => T): T {
    return fn(this.db);
  }
}
