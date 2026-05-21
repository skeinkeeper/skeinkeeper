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
      },
      roster: app.manager.currentRoster(),
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
