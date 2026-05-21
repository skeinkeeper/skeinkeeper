// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import type { App } from "../bootstrap.js";
import { getState, setEagerness, setDmVoice, setOperator, setPvp } from "./api.js";

interface Upsert {
  subjectKind: string;
  providerVoiceId: string;
  personaId?: string;
}

interface StubState {
  eagerness: string;
  dmVoiceId: string;
  pvpEnabled: boolean;
  upserts: Upsert[];
  operator: string | undefined;
  usernameResult: { ok: boolean; pending?: boolean; reason?: string; displayName?: string };
  usernameCalls: string[];
  dmVoiceCalls: string[];
  dmVoiceResult: { ok: boolean; voiceId?: string; error?: string };
}

function stubApp(): { app: App; state: StubState } {
  const state: StubState = {
    eagerness: "balanced",
    dmVoiceId: "v0",
    pvpEnabled: false,
    upserts: [],
    operator: undefined,
    usernameResult: { ok: true },
    usernameCalls: [],
    dmVoiceCalls: [],
    dmVoiceResult: { ok: true, voiceId: "v-resolved" },
  };
  const app = {
    config: { campaignId: "c1" },
    manager: {
      isRunning: false,
      get eagerness() {
        return state.eagerness;
      },
      get dmVoiceId() {
        return state.dmVoiceId;
      },
      setEagerness(e: string) {
        state.eagerness = e;
      },
      get pvpEnabled() {
        return state.pvpEnabled;
      },
      setPvpEnabled(enabled: boolean) {
        state.pvpEnabled = enabled;
      },
      setDmVoiceByPersona(personaId: string) {
        state.dmVoiceCalls.push(personaId);
        if (state.dmVoiceResult.ok && state.dmVoiceResult.voiceId !== undefined) {
          state.dmVoiceId = state.dmVoiceResult.voiceId;
        }
        return state.dmVoiceResult;
      },
      get operatorUserId() {
        return state.operator;
      },
      operatorDisplayName() {
        return undefined;
      },
      currentRoster() {
        return [];
      },
      setOperator(id: string) {
        state.operator = id;
      },
      clearOperator() {
        state.operator = undefined;
      },
      async setOperatorByUsername(username: string) {
        state.usernameCalls.push(username);
        if (state.usernameResult.ok && state.usernameResult.pending !== true) {
          state.operator = "resolved-1";
        }
        return state.usernameResult;
      },
    },
    tenantDb: {
      voiceAssignments: {
        listByCampaign: () => [],
        upsert: (r: Upsert) => state.upserts.push(r),
      },
      playerCharacterMap: { listByCampaign: () => [] },
    },
  } as unknown as App;
  return { app, state };
}

describe("operator API", () => {
  it("getState reports running + eagerness + personas", () => {
    const { app } = stubApp();
    const r = getState(app);
    expect(r.status).toBe(200);
    const body = r.body as { running: boolean; personas: unknown[] };
    expect(body.running).toBe(false);
    expect(body.personas.length).toBeGreaterThan(0);
  });

  it("setEagerness validates and applies", () => {
    const { app, state } = stubApp();
    expect(setEagerness(app, { eagerness: "eager" }).status).toBe(200);
    expect(state.eagerness).toBe("eager");
    expect(setEagerness(app, { eagerness: "nope" }).status).toBe(400);
  });

  it("setPvp validates the boolean and applies it (design doc 0026 §6)", () => {
    const { app, state } = stubApp();
    expect(setPvp(app, { enabled: true }).status).toBe(200);
    expect(state.pvpEnabled).toBe(true);
    expect(setPvp(app, { enabled: false }).status).toBe(200);
    expect(state.pvpEnabled).toBe(false);
    // Non-boolean is rejected.
    expect(setPvp(app, { enabled: "yes" }).status).toBe(400);
    expect(setPvp(app, {}).status).toBe(400);
  });

  it("getState reports pvpEnabled", () => {
    const { app } = stubApp();
    expect((getState(app).body as { pvpEnabled: boolean }).pvpEnabled).toBe(false);
  });

  it("setDmVoice delegates to the manager and maps ok/err to status", () => {
    const { app, state } = stubApp();
    const r = setDmVoice(app, { personaId: "warm-storyteller" });
    expect(r.status).toBe(200);
    expect(state.dmVoiceCalls).toEqual(["warm-storyteller"]);
    expect(state.dmVoiceId).toBe("v-resolved");
    state.dmVoiceResult = { ok: false, error: "unknown persona: ghost" };
    expect(setDmVoice(app, { personaId: "ghost" }).status).toBe(400);
  });

  it("setDmVoice requires a personaId", () => {
    expect(setDmVoice(stubApp().app, {}).status).toBe(400);
  });

  it("getState includes operator + roster", () => {
    const { app, state } = stubApp();
    state.operator = "op-1";
    const body = getState(app).body as {
      operator: { operatorUserId: string | null };
      roster: unknown[];
    };
    expect(body.operator.operatorUserId).toBe("op-1");
    expect(Array.isArray(body.roster)).toBe(true);
  });

  it("setOperator: snowflake (picker) sets the operator", async () => {
    const { app, state } = stubApp();
    const r = await setOperator(app, { discordId: "123" });
    expect(r.status).toBe(200);
    expect(state.operator).toBe("123");
  });

  it("setOperator: clear unsets the operator", async () => {
    const { app, state } = stubApp();
    state.operator = "123";
    const r = await setOperator(app, { clear: true });
    expect(r.status).toBe(200);
    expect(state.operator).toBeUndefined();
  });

  it("setOperator: username delegates to the manager and 400s on failure", async () => {
    const { app, state } = stubApp();
    const ok = await setOperator(app, { username: "chris" });
    expect(ok.status).toBe(200);
    expect(state.usernameCalls).toEqual(["chris"]);
    state.usernameResult = { ok: false, reason: "not found" };
    const bad = await setOperator(app, { username: "ghost" });
    expect(bad.status).toBe(400);
  });

  it("setOperator: rejects an empty request", async () => {
    const { app } = stubApp();
    expect((await setOperator(app, {})).status).toBe(400);
  });
});
