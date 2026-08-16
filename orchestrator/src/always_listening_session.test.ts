// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import type { BehaviorSpec } from "./behavior.js";
import { MockFoundryClient } from "./foundry/mock.js";
import { FakeLLMProvider } from "./interfaces/fake_llm_provider.js";
import { FakeVoiceIO } from "./interfaces/fake_voice_io.js";
import type { LLMEvent, LLMProvider, LLMRequest, TokenUsage } from "./interfaces/llm.js";
import { MaskingPool } from "./voice/masking/pool.js";
import {
  InterruptedError,
  type VoiceEvent,
  type Utterance,
  type VoiceIO,
} from "./interfaces/voice.js";
import { ToolDispatcher, ToolRegistry } from "./registry.js";
import { startSession, type Session } from "./session.js";
import {
  runAlwaysListeningSession,
  mergeFragmentsToTurnInput,
} from "./always_listening_session.js";
import type { BufferFragment } from "./voice/buffer.js";

const SPEC: BehaviorSpec = { content: "You are the AI DM.", version: "v0.1", path: "/t/spec.md" };
const USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5 };

function deciderAndNarration(deciderJson: string, narration: string): FakeLLMProvider {
  return new FakeLLMProvider([
    {
      match: (req) => req.modelTier === "orchestration",
      events: [
        { kind: "text_delta", text: deciderJson },
        { kind: "done", stopReason: "end_turn", usage: USAGE },
      ],
    },
    {
      match: (req) => req.modelTier === "narration",
      events: [
        { kind: "text_delta", text: narration },
        { kind: "done", stopReason: "end_turn", usage: USAGE },
      ],
    },
  ]);
}

function setupSession(llm: LLMProvider): { session: Session; tenantDb: TenantDb } {
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
  const dispatcher = new ToolDispatcher({ registry: new ToolRegistry() });
  const session = startSession({
    sessionId: "sess-1",
    campaignId: "c1",
    behaviorSpec: SPEC,
    llm,
    dispatcher,
    foundry: new MockFoundryClient({ system: "dnd5e" }),
    tenantDb,
  });
  return { session, tenantDb };
}

function utter(speaker: string, text: string, displayName?: string): VoiceEvent {
  const u: Utterance = { speaker, text, timestamp: Date.now() };
  if (displayName !== undefined) u.displayName = displayName;
  return { kind: "utterance", utterance: u };
}

function presence(members: ReadonlyArray<{ id: string; displayName?: string }>): VoiceEvent {
  return { kind: "presence", members };
}

describe("runAlwaysListeningSession", () => {
  it("captures utterances and responds on a lull when the decider says yes", async () => {
    const llm = deciderAndNarration(
      '{"respond": true, "reason": "consequential action"}',
      "The floor gives way beneath you.",
    );
    const { session, tenantDb } = setupSession(llm);
    const voiceIO = new FakeVoiceIO([
      utter("discord:alice", "I move into the dark corner", "Alice"),
      { kind: "lull", durationMs: 1500 },
    ]);

    const result = await runAlwaysListeningSession({
      voiceIO,
      session,
      consentText: "consent",
    });

    expect(result.decisionCount).toBe(1);
    expect(result.turnCount).toBe(1);
    expect(voiceIO.spoken.map((s) => s.text)).toEqual(["The floor gives way beneath you."]);
    const lines = tenantDb.dialogue.listBySession("sess-1");
    expect(lines.map((l) => l.speaker)).toEqual(["discord:alice", "narrator"]);
  });

  it("stays quiet during pure deliberation (decider says no)", async () => {
    const llm = deciderAndNarration('{"respond": false, "reason": "chatter"}', "unused");
    const { session, tenantDb } = setupSession(llm);
    const voiceIO = new FakeVoiceIO([
      utter("discord:alice", "should we trust him?"),
      utter("discord:bob", "dunno, seems shifty"),
      { kind: "lull" },
    ]);

    const result = await runAlwaysListeningSession({ voiceIO, session, consentText: "c" });

    expect(result.decisionCount).toBe(1);
    expect(result.turnCount).toBe(0);
    expect(voiceIO.spoken).toHaveLength(0);
    expect(tenantDb.dialogue.listBySession("sess-1")).toHaveLength(0);
  });

  it("collapses multiple speakers' fragments into one turn on respond", async () => {
    const llm = deciderAndNarration('{"respond": true}', "You all shuffle forward.");
    const { session, tenantDb } = setupSession(llm);
    const voiceIO = new FakeVoiceIO([
      utter("discord:alice", "I take point", "Alice"),
      utter("discord:bob", "I'm right behind", "Bob"),
      { kind: "lull" },
    ]);

    await runAlwaysListeningSession({ voiceIO, session, consentText: "c" });

    const playerLine = tenantDb.dialogue
      .listBySession("sess-1")
      .find((l) => l.speaker === "discord:bob");
    expect(playerLine?.text).toContain("[Alice] I take point");
    expect(playerLine?.text).toContain("[Bob] I'm right behind");
  });

  it("reads eagerness fresh each cycle via getEagerness", async () => {
    const llm = deciderAndNarration('{"respond": false}', "x");
    const { session } = setupSession(llm);
    const seen: string[] = [];
    const voiceIO = new FakeVoiceIO([utter("a", "hi"), { kind: "lull" }]);

    await runAlwaysListeningSession({
      voiceIO,
      session,
      consentText: "c",
      getEagerness: () => {
        seen.push("read");
        return "eager";
      },
    });

    expect(seen).toEqual(["read"]);
    const sentDecider = llm.receivedRequests.find((r) => r.modelTier === "orchestration")!;
    const text = sentDecider.messages[0]!.content.map((c) =>
      c.type === "text" ? c.text : "",
    ).join("");
    expect(text).toContain("EAGER");
  });

  it("routes narration to per-character voices when voiceRouting is set", async () => {
    const llm = deciderAndNarration(
      '{"respond": true}',
      'The guard scowls. [NPC:Sildar] "State your business."',
    );
    const { session } = setupSession(llm);
    const voiceIO = new FakeVoiceIO([utter("a", "I approach the gate"), { kind: "lull" }]);
    const assigned: string[] = [];

    await runAlwaysListeningSession({
      voiceIO,
      session,
      consentText: "c",
      voiceRouting: {
        dmVoiceId: "dm-voice",
        getNpcVoice: () => undefined,
        assignNpcVoice: async (key) => {
          assigned.push(key);
          return "sildar-voice";
        },
      },
    });

    expect(voiceIO.spoken).toEqual([
      { text: "The guard scowls.", opts: { voiceId: "dm-voice" } },
      { text: '"State your business."', opts: { voiceId: "sildar-voice" } },
    ]);
    expect(assigned).toEqual(["sildar"]);
  });

  it("does not run the decider on a lull with an empty buffer", async () => {
    const llm = deciderAndNarration('{"respond": true}', "x");
    const { session } = setupSession(llm);
    const decisions: number[] = [];
    const voiceIO = new FakeVoiceIO([{ kind: "lull" }, { kind: "lull" }]);
    const result = await runAlwaysListeningSession({
      voiceIO,
      session,
      consentText: "c",
      onDecision: () => decisions.push(1),
    });
    expect(result.decisionCount).toBe(0);
    expect(decisions).toHaveLength(0);
  });

  it("stays silent in an empty channel", async () => {
    const llm = deciderAndNarration('{"respond": true}', "should not speak");
    const { session } = setupSession(llm);
    const voiceIO = new FakeVoiceIO([presence([]), { kind: "lull" }]);
    const result = await runAlwaysListeningSession({ voiceIO, session, consentText: "c" });
    expect(result.onboardingCount).toBe(0);
    expect(result.turnCount).toBe(0);
    expect(voiceIO.spoken).toHaveLength(0);
  });

  it("runs an onboarding turn for a present unmapped member, bypassing the decider", async () => {
    const llm = deciderAndNarration('{"respond": false}', "Welcome to the table.");
    const { session } = setupSession(llm);
    const voiceIO = new FakeVoiceIO([
      presence([{ id: "discord:alice", displayName: "Alice" }]),
      { kind: "lull" },
    ]);
    const result = await runAlwaysListeningSession({ voiceIO, session, consentText: "c" });
    expect(result.onboardingCount).toBe(1);
    expect(result.turnCount).toBe(1);
    expect(result.decisionCount).toBe(0); // decider bypassed for the ritual
    expect(voiceIO.spoken.map((s) => s.text)).toEqual(["Welcome to the table."]);
  });

  it("does not announce ready / onboard while minimum intake is blocked", async () => {
    const llm = deciderAndNarration('{"respond": false}', "Welcome to the table.");
    const { session } = setupSession(llm);
    const voiceIO = new FakeVoiceIO([
      presence([{ id: "discord:alice", displayName: "Alice" }]),
      { kind: "lull" },
    ]);
    const result = await runAlwaysListeningSession({
      voiceIO,
      session,
      consentText: "c",
      intakeReady: () => false,
    });
    expect(result.onboardingCount).toBe(0);
    expect(result.turnCount).toBe(0);
    expect(voiceIO.spoken).toHaveLength(0);
  });

  it("does not re-greet a member after onboarding them", async () => {
    const llm = deciderAndNarration('{"respond": false}', "Welcome.");
    const { session } = setupSession(llm);
    const voiceIO = new FakeVoiceIO([
      presence([{ id: "discord:alice", displayName: "Alice" }]),
      { kind: "lull" }, // onboarding turn
      { kind: "lull" }, // already greeted + empty buffer → silent
    ]);
    const result = await runAlwaysListeningSession({ voiceIO, session, consentText: "c" });
    expect(result.onboardingCount).toBe(1);
    expect(result.turnCount).toBe(1);
  });

  it("skips onboarding for a member already mapped to a character", async () => {
    const llm = deciderAndNarration('{"respond": false}', "x");
    const { session, tenantDb } = setupSession(llm);
    tenantDb.playerCharacterMap.record({
      campaignId: "c1",
      discordUserId: "discord:alice",
      foundryActorId: "ch-aragorn",
      source: "player",
      confirmedAt: Date.now(),
    });
    const voiceIO = new FakeVoiceIO([
      presence([{ id: "discord:alice", displayName: "Alice" }]),
      { kind: "lull" },
    ]);
    const result = await runAlwaysListeningSession({ voiceIO, session, consentText: "c" });
    expect(result.onboardingCount).toBe(0);
    expect(result.turnCount).toBe(0);
  });

  it("greets a full room in a single onboarding turn", async () => {
    const llm = deciderAndNarration('{"respond": false}', "Welcome, everyone.");
    const { session } = setupSession(llm);
    const voiceIO = new FakeVoiceIO([
      presence([
        { id: "discord:alice", displayName: "Alice" },
        { id: "discord:bob", displayName: "Bob" },
      ]),
      { kind: "lull" },
      { kind: "lull" }, // both greeted → silent
    ]);
    const result = await runAlwaysListeningSession({ voiceIO, session, consentText: "c" });
    expect(result.onboardingCount).toBe(1);
    expect(result.turnCount).toBe(1);
  });

  it("prompts an unconsented present member and does not onboard them", async () => {
    const llm = deciderAndNarration('{"respond": false}', "should not speak");
    const { session } = setupSession(llm);
    const voiceIO = new FakeVoiceIO([
      presence([{ id: "discord:alice", displayName: "Alice" }]),
      { kind: "lull" },
    ]);
    const result = await runAlwaysListeningSession({
      voiceIO,
      session,
      consentText: "please consent",
      isConsented: () => false,
    });
    expect(result.onboardingCount).toBe(0);
    expect(result.turnCount).toBe(0);
    expect(voiceIO.spoken).toHaveLength(0);
    expect(voiceIO.consentRequests).toEqual([
      { subjectId: "discord:alice", consentText: "please consent" },
    ]);
  });

  it("onboards a member on the lull after they consent", async () => {
    const llm = deciderAndNarration('{"respond": false}', "Welcome, Alice.");
    const { session } = setupSession(llm);
    let consented = false;
    const spoken: string[] = [];
    // Custom transport: Alice grants consent in the break between the two lulls.
    const voiceIO: VoiceIO = {
      name: "fake",
      async *listen() {
        yield presence([{ id: "discord:alice", displayName: "Alice" }]);
        yield { kind: "lull" }; // not consented yet → consent prompt, no onboarding
        consented = true;
        yield { kind: "lull" }; // now consented → onboarding turn
      },
      async speak(text) {
        spoken.push(text);
      },
      async requestConsent() {
        /* recorded via spoken-independent path; not asserted here */
      },
      async close() {
        /* no-op */
      },
    };
    const result = await runAlwaysListeningSession({
      voiceIO,
      session,
      consentText: "c",
      isConsented: () => consented,
    });
    expect(result.onboardingCount).toBe(1);
    expect(spoken).toEqual(["Welcome, Alice."]);
  });

  it("folds a newcomer's introduction into the onboarding turn", async () => {
    const llm = deciderAndNarration('{"respond": false}', "Welcome, Alice — you're playing Mirna.");
    const { session, tenantDb } = setupSession(llm);
    const voiceIO = new FakeVoiceIO([
      presence([{ id: "discord:alice", displayName: "Alice" }]),
      utter("discord:alice", "Hi, I'm Alice, I'm playing Mirna", "Alice"),
      { kind: "lull" },
    ]);
    const result = await runAlwaysListeningSession({ voiceIO, session, consentText: "c" });
    expect(result.onboardingCount).toBe(1);
    const lines = tenantDb.dialogue.listBySession("sess-1").map((l) => l.text);
    expect(lines.some((t) => t.includes("Mirna"))).toBe(true);
    expect(lines.some((t) => t.includes("[Onboarding]"))).toBe(true);
  });

  it("suppresses onboarding for a voice-join identity critical gap (TDD 0036)", async () => {
    const llm = deciderAndNarration('{"respond": false}', "Welcome, Alice.");
    const { session } = setupSession(llm);
    const gaps: string[] = [];
    const voiceIO = new FakeVoiceIO([
      presence([
        { id: "discord:alice", displayName: "Alice" },
        { id: "discord:bob", displayName: "Bob" },
      ]),
      { kind: "lull" },
    ]);
    const result = await runAlwaysListeningSession({
      voiceIO,
      session,
      consentText: "c",
      identityPreflight: {
        verifyPlayer: async (p) => (p.discordUserId === "discord:bob" ? "critical-gaps" : "ok"),
        onCriticalGap: async (p) => {
          gaps.push(p.displayName ?? p.discordUserId);
        },
      },
    });
    expect(result.onboardingCount).toBe(1);
    expect(result.turnCount).toBe(1);
    const narration = llm.receivedRequests.find((r) => r.modelTier === "narration");
    const text = (narration?.messages ?? [])
      .flatMap((m) => m.content)
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("\n");
    expect(text).toContain("Alice");
    expect(text).not.toMatch(/Bob/);
    expect(gaps).toEqual(["Bob"]);
  });

  it("sends the voice-join identity courtesy once per player per session", async () => {
    const llm = deciderAndNarration('{"respond": false}', "Welcome.");
    const { session } = setupSession(llm);
    const gaps: string[] = [];
    const voiceIO = new FakeVoiceIO([
      presence([{ id: "discord:bob", displayName: "Bob" }]),
      { kind: "lull" },
      presence([{ id: "discord:bob", displayName: "Bob" }]),
      { kind: "lull" },
    ]);
    const result = await runAlwaysListeningSession({
      voiceIO,
      session,
      consentText: "c",
      identityPreflight: {
        verifyPlayer: async () => "critical-gaps",
        onCriticalGap: async (p) => {
          gaps.push(p.displayName ?? p.discordUserId);
        },
      },
    });
    expect(result.onboardingCount).toBe(0);
    expect(gaps).toEqual(["Bob"]);
  });

  it("records identity-blocked utterances as player:unmapped and does not take a table turn", async () => {
    const llm = deciderAndNarration('{"respond": true}', "I should not hear Bob.");
    const { session, tenantDb } = setupSession(llm);
    const voiceIO = new FakeVoiceIO([
      presence([{ id: "discord:bob", displayName: "Bob" }]),
      utter("discord:bob", "can you hear me", "Bob"),
      { kind: "lull" },
    ]);
    const result = await runAlwaysListeningSession({
      voiceIO,
      session,
      consentText: "c",
      identityPreflight: {
        verifyPlayer: async () => "critical-gaps",
        onCriticalGap: async () => undefined,
      },
    });
    expect(result.turnCount).toBe(0);
    const rows = tenantDb.dialogue.listBySession("sess-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("can you hear me");
    expect(rows[0]?.audience).toBe("player:unmapped");
    expect(rows[0]?.conversationId).toBe("player:unmapped");
  });

  it("escalates a single operator line on voice-join warnings-only", async () => {
    const llm = deciderAndNarration('{"respond": false}', "Welcome.");
    const { session } = setupSession(llm);
    const warnings: string[] = [];
    const voiceIO = new FakeVoiceIO([
      presence([{ id: "discord:bob", displayName: "Bob" }]),
      { kind: "lull" },
    ]);
    const result = await runAlwaysListeningSession({
      voiceIO,
      session,
      consentText: "c",
      identityPreflight: {
        verifyPlayer: async () => "warnings-only",
        onCriticalGap: async () => undefined,
        onWarning: async (p) => {
          warnings.push(p.displayName ?? p.discordUserId);
        },
      },
    });
    expect(result.onboardingCount).toBe(1);
    expect(warnings).toEqual(["Bob"]);
  });

  it("requests consent for unconsented speakers", async () => {
    const llm = deciderAndNarration('{"respond": false}', "x");
    const { session } = setupSession(llm);
    const voiceIO = new FakeVoiceIO([{ kind: "consent_needed", speaker: "discord:carol" }]);

    await runAlwaysListeningSession({ voiceIO, session, consentText: "please consent" });

    expect(voiceIO.consentRequests).toEqual([
      { subjectId: "discord:carol", consentText: "please consent" },
    ]);
  });
});

describe("mergeFragmentsToTurnInput", () => {
  function frag(speaker: string, text: string, displayName?: string): BufferFragment {
    return {
      speaker,
      ...(displayName !== undefined ? { displayName } : {}),
      text,
      startTs: 1,
      endTs: 1,
      final: true,
    };
  }

  it("returns null for an empty buffer", () => {
    expect(mergeFragmentsToTurnInput([])).toBeNull();
  });

  it("passes a single fragment through unlabeled", () => {
    const input = mergeFragmentsToTurnInput([frag("discord:1", "I attack", "Alice")]);
    expect(input).toEqual({ speaker: "discord:1", displayName: "Alice", text: "I attack" });
  });

  it("labels multiple speakers and attributes to the last", () => {
    const input = mergeFragmentsToTurnInput([
      frag("discord:1", "I take point", "Alice"),
      frag("discord:2", "behind you", "Bob"),
    ]);
    expect(input?.speaker).toBe("discord:2");
    expect(input?.text).toBe("[Alice] I take point\n[Bob] behind you");
  });
});

/** A provider that delays its narration so the masking threshold can fire. */
class DelayedNarrationLLM implements LLMProvider {
  readonly name = "delayed";
  constructor(
    private readonly narration: string,
    private readonly delayMs: number,
  ) {}
  async *complete(req: LLMRequest): AsyncIterable<LLMEvent> {
    if (req.modelTier === "orchestration") {
      yield { kind: "text_delta", text: '{"respond": true}' };
      yield { kind: "done", stopReason: "end_turn", usage: USAGE };
      return;
    }
    await new Promise((r) => setTimeout(r, this.delayMs));
    yield { kind: "text_delta", text: this.narration };
    yield { kind: "done", stopReason: "end_turn", usage: USAGE };
  }
}

describe("runAlwaysListeningSession — latency masking (design doc 0028 P2)", () => {
  const routing = {
    dmVoiceId: "dm",
    getNpcVoice: () => "npc",
    assignNpcVoice: async () => "npc",
  };

  it("speaks a filler to cover the gap when the turn is slow to start", async () => {
    const { session } = setupSession(new DelayedNarrationLLM("The vault grinds open.", 60));
    const voiceIO = new FakeVoiceIO([utter("a", "I open it"), { kind: "lull" }]);
    const pool = new MaskingPool({ rng: () => 0 });
    pool.add([{ text: "You steady your breath.", tags: ["neutral"] }]);

    await runAlwaysListeningSession({
      voiceIO,
      session,
      consentText: "c",
      voiceRouting: routing,
      masking: { pool, thresholdMs: 5 },
    });

    const texts = voiceIO.spoken.map((s) => s.text);
    expect(texts[0]).toBe("You steady your breath."); // filler covered the gap first
    expect(texts).toContain("The vault grinds open."); // then the real narration
  });

  it("does not speak a filler when narration starts within the threshold", async () => {
    const { session } = setupSession(deciderAndNarration('{"respond": true}', "Immediate."));
    const voiceIO = new FakeVoiceIO([utter("a", "go"), { kind: "lull" }]);
    const pool = new MaskingPool({ rng: () => 0 });
    pool.add([{ text: "unused filler", tags: ["neutral"] }]);

    await runAlwaysListeningSession({
      voiceIO,
      session,
      consentText: "c",
      voiceRouting: routing,
      masking: { pool, thresholdMs: 2000 },
    });

    expect(voiceIO.spoken.map((s) => s.text)).toEqual(["Immediate."]);
  });
});

describe("runAlwaysListeningSession — barge-in (design doc 0028 P2)", () => {
  it("invokes interrupt() and finishes cleanly when playback is interrupted", async () => {
    const llm = deciderAndNarration('{"respond": true}', "The guard scowls. He steps forward.");
    const { session } = setupSession(llm);

    // A VoiceIO whose playback is barged in on (speak rejects), exposing an
    // interrupt spy — mimics a player talking over the DM mid-sentence.
    const base = new FakeVoiceIO([utter("a", "I approach"), { kind: "lull" }]);
    let interrupts = 0;
    const voiceIO: VoiceIO = {
      name: "barge",
      listen: () => base.listen(),
      speak: () => Promise.reject(new InterruptedError()),
      requestConsent: async () => {},
      interrupt: () => {
        interrupts += 1;
      },
      close: async () => {},
    };

    // Must not throw out of the loop, and the barge-in must trigger interrupt().
    const result = await runAlwaysListeningSession({
      voiceIO,
      session,
      consentText: "c",
      voiceRouting: {
        dmVoiceId: "dm-voice",
        getNpcVoice: () => "npc-voice",
        assignNpcVoice: async () => "npc-voice",
      },
    });
    expect(result.turnCount).toBe(1);
    expect(interrupts).toBeGreaterThanOrEqual(1);
  });
});
