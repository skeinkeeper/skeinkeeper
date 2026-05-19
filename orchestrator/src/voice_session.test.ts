// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import type { BehaviorSpec } from "./behavior.js";
import { MockFoundryClient } from "./foundry/mock.js";
import { FakeVoiceIO, fakeLlmFromEvents, type VoiceEvent } from "./interfaces/index.js";
import { ToolDispatcher, ToolRegistry } from "./registry.js";
import { startSession, type Session, type SessionConfig } from "./session.js";
import { runVoiceSession, VOICE_CONSENT_TEXT } from "./voice_session.js";

const SPEC: BehaviorSpec = { content: "AI DM spec.", version: "v0.1", path: "/s.md" };
const DONE = { inputTokens: 10, outputTokens: 5 };

function makeSession(): { session: Session } {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(schema.tenants).values({ id: "default", name: "T", createdAt: Date.now() }).run();
  db.insert(schema.campaigns)
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
  const tenantDb = new TenantDb(db, "default");
  const registry = new ToolRegistry();
  const config: SessionConfig = {
    sessionId: "vs-1",
    campaignId: "c1",
    behaviorSpec: SPEC,
    llm: fakeLlmFromEvents([
      { kind: "text_delta", text: "Narrated response." },
      { kind: "done", stopReason: "end_turn", usage: DONE },
    ]),
    dispatcher: new ToolDispatcher({ registry }),
    foundry: new MockFoundryClient({ system: "dnd5e" }),
    tenantDb,
  };
  return { session: startSession(config) };
}

describe("runVoiceSession", () => {
  it("turns consented utterances into runTurn calls and speaks the narration", async () => {
    const { session } = makeSession();
    const voiceIO = new FakeVoiceIO([
      {
        kind: "utterance",
        utterance: { speaker: "p1", displayName: "Aragorn", text: "I open the door.", timestamp: 1 },
      },
    ]);
    const count = await runVoiceSession({
      voiceIO,
      session,
      consentText: VOICE_CONSENT_TEXT,
    });
    expect(count).toBe(1);
    expect(voiceIO.spoken).toHaveLength(1);
    expect(voiceIO.spoken[0]?.text).toBe("Narrated response.");
    const playerTurns = session.dialogue.filter((d) => d.speaker !== "narrator");
    expect(playerTurns).toHaveLength(1);
    expect(playerTurns[0]?.text).toBe("I open the door.");
  });

  it("requests consent (and does NOT run a turn) on a consent_needed event", async () => {
    const { session } = makeSession();
    const voiceIO = new FakeVoiceIO([
      { kind: "consent_needed", speaker: "p2", displayName: "Newcomer" },
    ]);
    const count = await runVoiceSession({
      voiceIO,
      session,
      consentText: VOICE_CONSENT_TEXT,
    });
    expect(count).toBe(0);
    expect(voiceIO.consentRequests).toHaveLength(1);
    expect(voiceIO.consentRequests[0]?.subjectId).toBe("p2");
    expect(voiceIO.consentRequests[0]?.consentText).toBe(VOICE_CONSENT_TEXT);
    expect(voiceIO.spoken).toHaveLength(0);
    expect(session.dialogue).toHaveLength(0);
  });

  it("interleaves consent requests and turns across a mixed event stream", async () => {
    const { session } = makeSession();
    const events: VoiceEvent[] = [
      { kind: "utterance", utterance: { speaker: "p1", text: "First.", timestamp: 1 } },
      { kind: "consent_needed", speaker: "p2" },
      { kind: "utterance", utterance: { speaker: "p1", text: "Second.", timestamp: 2 } },
    ];
    const voiceIO = new FakeVoiceIO(events);
    const count = await runVoiceSession({
      voiceIO,
      session,
      consentText: VOICE_CONSENT_TEXT,
    });
    expect(count).toBe(2);
    expect(voiceIO.spoken).toHaveLength(2);
    expect(voiceIO.consentRequests).toHaveLength(1);
    const playerTexts = session.dialogue.filter((d) => d.speaker !== "narrator").map((d) => d.text);
    expect(playerTexts).toEqual(["First.", "Second."]);
  });

  it("passes a resolved voice ID through to speak()", async () => {
    const { session } = makeSession();
    const voiceIO = new FakeVoiceIO([
      { kind: "utterance", utterance: { speaker: "p1", text: "hi", timestamp: 1 } },
    ]);
    await runVoiceSession({
      voiceIO,
      session,
      consentText: VOICE_CONSENT_TEXT,
      resolveVoiceId: () => "voice-sildar",
    });
    expect(voiceIO.spoken[0]?.opts?.voiceId).toBe("voice-sildar");
  });

  it("invokes the onTurn hook for each processed turn", async () => {
    const { session } = makeSession();
    const voiceIO = new FakeVoiceIO([
      { kind: "utterance", utterance: { speaker: "p1", text: "a", timestamp: 1 } },
      { kind: "utterance", utterance: { speaker: "p1", text: "b", timestamp: 2 } },
    ]);
    const seen: string[] = [];
    await runVoiceSession({
      voiceIO,
      session,
      consentText: VOICE_CONSENT_TEXT,
      onTurn: (t) => seen.push(t.stopReason),
    });
    expect(seen).toEqual(["end_turn", "end_turn"]);
  });
});
