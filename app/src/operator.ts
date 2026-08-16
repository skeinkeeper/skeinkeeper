// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { TenantDb } from "@skeinkeeper/server";

/**
 * Operator designation (design doc 0024). Persists the resolved Discord
 * snowflake of the human the AI DMs for setup escalations, with the
 * `DISCORD_OPERATOR_USER_ID` env var as a fallback default. A thin service over
 * `TenantDb.settings` so the precedence + persistence is unit-testable apart
 * from the Discord gateway.
 *
 * Precedence: a persisted value (set via console picker / @username / the
 * `/skeinkeeper operator claim` slash command) wins; otherwise the env
 * fallback; otherwise unset (escalations degrade to the server log).
 */
export const OPERATOR_SETTING_KEY = "operator.discord_user_id";
export const OPERATOR_PENDING_USERNAME_KEY = "operator.pending_username";
/**
 * Operator-side DM-consent timestamp (design doc 0039 §3 step 4). Separate
 * from player consent: gates ONLY the pause-notification DM — the second of
 * two narrow exceptions to "Discord DM = one-time consent only" (the first is
 * TDD 0034's courtesy redirect). Absent = no consent on file, no DM is sent.
 * Additive to the existing operator-designation storage; erased with it.
 */
export const OPERATOR_DM_CONSENT_KEY = "operator.dm_consented_at";

export class OperatorService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly campaignId: string,
    /** `DISCORD_OPERATOR_USER_ID`, used only when nothing is persisted. */
    private readonly envFallback?: string,
  ) {}

  /** The effective operator snowflake, or undefined if none is set. */
  get(): string | undefined {
    const persisted = this.tenantDb.settings.get(this.campaignId, OPERATOR_SETTING_KEY)?.value;
    return persisted ?? this.envFallback;
  }

  /** Whether the effective operator comes from persisted state (vs. the env). */
  isPersisted(): boolean {
    return this.tenantDb.settings.get(this.campaignId, OPERATOR_SETTING_KEY) !== undefined;
  }

  set(discordUserId: string): void {
    this.tenantDb.settings.set({
      campaignId: this.campaignId,
      key: OPERATOR_SETTING_KEY,
      value: discordUserId,
      updatedAt: Date.now(),
    });
    this.clearPending();
  }

  /** Remove the persisted designation; `get()` then falls back to the env. */
  clear(): void {
    this.tenantDb.settings.delete(this.campaignId, OPERATOR_SETTING_KEY);
    this.clearPending();
  }

  /** A username typed before a session was running, to resolve at next start. */
  getPendingUsername(): string | undefined {
    return this.tenantDb.settings.get(this.campaignId, OPERATOR_PENDING_USERNAME_KEY)?.value;
  }

  setPendingUsername(username: string): void {
    this.tenantDb.settings.set({
      campaignId: this.campaignId,
      key: OPERATOR_PENDING_USERNAME_KEY,
      value: username,
      updatedAt: Date.now(),
    });
  }

  clearPending(): void {
    this.tenantDb.settings.delete(this.campaignId, OPERATOR_PENDING_USERNAME_KEY);
  }

  /** When (epoch ms) the operator consented to pause-notification DMs, or
   *  undefined when no consent is on file. */
  dmConsentedAt(): number | undefined {
    const raw = this.tenantDb.settings.get(this.campaignId, OPERATOR_DM_CONSENT_KEY)?.value;
    if (raw === undefined || raw.length === 0) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  /** Grant (persist a timestamp) or revoke (delete the row) DM consent. */
  setDmConsent(consented: boolean): void {
    if (!consented) {
      this.tenantDb.settings.delete(this.campaignId, OPERATOR_DM_CONSENT_KEY);
      return;
    }
    this.tenantDb.settings.set({
      campaignId: this.campaignId,
      key: OPERATOR_DM_CONSENT_KEY,
      value: String(Date.now()),
      updatedAt: Date.now(),
    });
  }
}

/**
 * Whether an `/skeinkeeper operator` action mutates the designation and so
 * must be authorized (design doc 0024 §5). `claim`/`clear` are gated behind the
 * Manage Channel permission on the play voice channel; `show` (and any unknown
 * action, which only gets a usage hint) is read-only and open to anyone.
 */
export function operatorActionIsPrivileged(action: string | null | undefined): boolean {
  return action === "claim" || action === "clear";
}

/** A guild member, reduced to what username resolution needs. */
export interface ResolvableMember {
  id: string;
  /** Discord @username (unique, lowercase). */
  username?: string;
  /** Server nickname / global display name (not unique). */
  displayName?: string;
}

export type OperatorResolution =
  | { kind: "match"; id: string; displayName?: string }
  | { kind: "ambiguous"; candidates: ReadonlyArray<ResolvableMember> }
  | { kind: "not_found" };

const norm = (s: string): string => s.trim().replace(/^@/, "").toLowerCase();

/**
 * Resolve a typed identifier to a single guild member (design doc 0024). Prefers
 * an exact **username** match (usernames are unique); falls back to an exact
 * display-name/nickname match, which can be ambiguous (two "Chris"es) and is
 * reported as such so the caller can ask the operator to use the picker or the
 * slash command instead. Pure — the caller fetches the members.
 */
export function resolveOperatorFromMembers(
  members: ReadonlyArray<ResolvableMember>,
  query: string,
): OperatorResolution {
  const q = norm(query);
  if (q.length === 0) return { kind: "not_found" };

  const byUsername = members.filter((m) => m.username !== undefined && norm(m.username) === q);
  if (byUsername.length === 1) {
    const m = byUsername[0]!;
    return m.displayName !== undefined
      ? { kind: "match", id: m.id, displayName: m.displayName }
      : { kind: "match", id: m.id };
  }
  if (byUsername.length > 1) return { kind: "ambiguous", candidates: byUsername };

  const byDisplay = members.filter((m) => m.displayName !== undefined && norm(m.displayName) === q);
  if (byDisplay.length === 1) {
    const m = byDisplay[0]!;
    return m.displayName !== undefined
      ? { kind: "match", id: m.id, displayName: m.displayName }
      : { kind: "match", id: m.id };
  }
  if (byDisplay.length > 1) return { kind: "ambiguous", candidates: byDisplay };

  return { kind: "not_found" };
}
