// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { isEagerness, type Eagerness } from "@skeinkeeper/orchestrator";
import type { App } from "../bootstrap.js";
import { dmPersonas } from "../personas.js";

/**
 * Operator-app JSON API logic (design doc 0020 §4-5), kept separate from the
 * http plumbing so it's unit-testable. Each handler takes the App + a parsed
 * body and returns a status + body; the DB-as-bus controls (eagerness, DM
 * voice) write through the SessionManager / TenantDb the running loop reads.
 */
export interface ApiResult {
  status: number;
  body: unknown;
}

export function getState(app: App): ApiResult {
  return {
    status: 200,
    body: {
      running: app.manager.isRunning,
      eagerness: app.manager.eagerness,
      dmVoiceId: app.manager.dmVoiceId,
      pvpEnabled: app.manager.pvpEnabled,
      campaignId: app.config.campaignId,
      personas: dmPersonas(),
      voiceAssignments: app.tenantDb.voiceAssignments.listByCampaign(app.config.campaignId),
      playerCharacterMap: app.tenantDb.playerCharacterMap.listByCampaign(app.config.campaignId),
      operator: {
        operatorUserId: app.manager.operatorUserId ?? null,
        displayName: app.manager.operatorDisplayName() ?? null,
        // Pause-notification DM opt-in (design doc 0039 step 9).
        dmConsented: app.manager.operatorDmConsented,
      },
      roster: app.manager.currentRoster(),
      intake: app.manager.getIntakeView(),
      // Foundry-down lifecycle (design doc 0039); null when not running.
      lifecycle: app.manager.lifecycleState(),
    },
  };
}

/**
 * Designate the operator (design doc 0024). Accepts a snowflake (picker),
 * a typed @username (resolved against the guild), or { clear: true }.
 */
export async function setOperator(app: App, body: unknown): Promise<ApiResult> {
  const b = (body ?? {}) as { discordId?: unknown; username?: unknown; clear?: unknown };
  if (b.clear === true) {
    app.manager.clearOperator();
    return { status: 200, body: { operatorUserId: app.manager.operatorUserId ?? null } };
  }
  if (typeof b.discordId === "string" && b.discordId.trim().length > 0) {
    app.manager.setOperator(b.discordId.trim());
    return { status: 200, body: { operatorUserId: app.manager.operatorUserId ?? null } };
  }
  if (typeof b.username === "string" && b.username.trim().length > 0) {
    const r = await app.manager.setOperatorByUsername(b.username.trim());
    if (!r.ok) return { status: 400, body: { error: r.reason ?? "could not resolve username" } };
    return {
      status: 200,
      body: {
        operatorUserId: app.manager.operatorUserId ?? null,
        pending: r.pending ?? false,
        ...(r.displayName !== undefined ? { displayName: r.displayName } : {}),
      },
    };
  }
  return { status: 400, body: { error: "provide discordId, username, or clear:true" } };
}

export function setEagerness(app: App, body: unknown): ApiResult {
  const value = (body as { eagerness?: unknown } | null)?.eagerness;
  if (typeof value !== "string" || !isEagerness(value)) {
    return { status: 400, body: { error: "eagerness must be one of reserved|balanced|eager" } };
  }
  app.manager.setEagerness(value as Eagerness);
  return { status: 200, body: { eagerness: value } };
}

export function setPvp(app: App, body: unknown): ApiResult {
  const value = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof value !== "boolean") {
    return { status: 400, body: { error: "enabled must be a boolean" } };
  }
  // Single write path: the manager persists the per-campaign setting and emits a
  // `pvp` event so the slash surface stays in sync (design docs 0026 §6, 0025).
  app.manager.setPvpEnabled(value);
  return { status: 200, body: { pvpEnabled: value } };
}

export function setDmVoice(app: App, body: unknown): ApiResult {
  const personaId = (body as { personaId?: unknown } | null)?.personaId;
  if (typeof personaId !== "string") {
    return { status: 400, body: { error: "personaId required" } };
  }
  // Single write path: the manager resolves, persists, and emits a dmVoice
  // event so the slash-command surface stays in sync (design doc 0025).
  const r = app.manager.setDmVoiceByPersona(personaId);
  if (!r.ok) return { status: 400, body: { error: r.error ?? "unknown persona" } };
  return { status: 200, body: { personaId, voiceId: r.voiceId } };
}

/**
 * Resolve an intake finding from the web console (ADR-0016 / ADR-0028).
 * The Foundry chat-command row lands in TDD 0040 against the same
 * SessionManager.resolveIntakeFinding write path.
 */
export async function resolveIntake(app: App, body: unknown): Promise<ApiResult> {
  const b = (body ?? {}) as { findingId?: unknown; optionId?: unknown };
  const findingId = typeof b.findingId === "number" ? b.findingId : Number(b.findingId);
  if (!Number.isInteger(findingId) || findingId <= 0) {
    return { status: 400, body: { error: "findingId must be a positive integer" } };
  }
  if (typeof b.optionId !== "string" || b.optionId.trim().length === 0) {
    return { status: 400, body: { error: "optionId required" } };
  }
  const result = await app.manager.resolveIntakeFinding(findingId, b.optionId.trim());
  return { status: 200, body: result };
}

/**
 * Resume a paused-foundry-down session (design doc 0039 §4). Same
 * SessionManager.resume() write path as `/skeinkeeper session action:resume`
 * (parity per ADR-0028). A blocked resume is a 409: the session stays paused.
 */
export async function resumeSession(app: App): Promise<ApiResult> {
  const result = await app.manager.resume();
  const ok = result.kind === "ok" || result.kind === "already-active";
  return { status: ok ? 200 : 409, body: result };
}

/** Operator pause-notification DM opt-in/out (design doc 0039 step 9). */
export function setOperatorDmConsent(app: App, body: unknown): ApiResult {
  const value = (body as { consented?: unknown } | null)?.consented;
  if (typeof value !== "boolean") {
    return { status: 400, body: { error: "consented must be a boolean" } };
  }
  app.manager.setOperatorDmConsent(value);
  return { status: 200, body: { dmConsented: value } };
}

/** Re-run identity pre-flight (TDD 0036). Same write path as Foundry chat. */
export async function verifyPreflight(app: App, body: unknown): Promise<ApiResult> {
  const player = (body as { player?: unknown } | null)?.player;
  const result = await app.manager.verifyPreflight(
    typeof player === "string" && player.trim().length > 0 ? player.trim() : undefined,
  );
  return { status: 200, body: result };
}
