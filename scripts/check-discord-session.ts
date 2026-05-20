// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Layer 3 voice validation: the full always-listening AI-DM loop over a live
 * Discord channel. Wires every piece together:
 *
 *   DiscordVoiceIO (capture, selfDeaf:false) → Deepgram STT → transcription
 *   buffer → Haiku "should I respond?" decider (Eagerness) → on yes, Opus
 *   narration via runTurn → [NPC:x] marker split → ElevenLabs per-voice TTS
 *   → playback.
 *
 * This is a throwaway composition root for live validation (the real one is
 * the Phase 5 operator app). It uses an in-memory DB, a MockFoundryClient
 * party, and auto-granted consent.
 *
 * Run (be in the channel; introduce yourself, then declare an action):
 *   pnpm check:discord-session              # 120s window
 *   pnpm check:discord-session -- --seconds 180
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { VoiceConnectionStatus, entersState, joinVoiceChannel } from "@discordjs/voice";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { AnthropicProvider } from "@skeinkeeper/llm-anthropic";
import {
  MockFoundryClient,
  ToolDispatcher,
  createDefaultRegistry,
  findDefaultBehaviorSpec,
  loadBehaviorSpec,
  runAlwaysListeningSession,
  startSession,
  endSession,
  assignNpcVoice as assignNpcVoiceLLM,
  VOICE_CONSENT_TEXT,
  type FoundryActor,
} from "@skeinkeeper/orchestrator";
import {
  DeepgramStreamingSTT,
  DiscordVoiceIO,
  ElevenLabsTTS,
  ElevenLabsVoiceLibrary,
} from "@skeinkeeper/voice-discord";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DM_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"; // George — warm storyteller
const CAMPAIGN_ID = "voice-check";

function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function need(value: string | undefined, label: string): string {
  if (!value) {
    console.error(`Missing ${label}`);
    process.exit(1);
  }
  return value;
}

const PARTY: ReadonlyArray<FoundryActor> = [
  { id: "actor-aragorn", name: "Aragorn", type: "character", system: "dnd5e", sheet: { attributes: { hp: { value: 24, max: 24 } } } },
  { id: "actor-gimli", name: "Gimli", type: "character", system: "dnd5e", sheet: { attributes: { hp: { value: 30, max: 30 } } } },
];

async function main(): Promise<void> {
  loadEnv(join(REPO_ROOT, ".env"));
  const token = need(process.env["DISCORD_BOT_TOKEN"], "DISCORD_BOT_TOKEN");
  const anthropicKey = need(process.env["ANTHROPIC_API_KEY"], "ANTHROPIC_API_KEY");
  const deepgramKey = need(process.env["DEEPGRAM_API_KEY"], "DEEPGRAM_API_KEY");
  const elevenKey = need(process.env["ELEVENLABS_API_KEY"], "ELEVENLABS_API_KEY");
  const channelId = need(arg("--channel") ?? process.env["DISCORD_VOICE_CHANNEL_ID"], "--channel / DISCORD_VOICE_CHANNEL_ID");
  const seconds = Number(arg("--seconds") ?? "120");

  // --- AI-DM state (in-memory) ---
  const db = openDb({ path: ":memory:", runMigrations: true });
  const now = Date.now();
  db.insert(schema.tenants).values({ id: "default", name: "Voice Check", createdAt: now }).run();
  db.insert(schema.campaigns).values({
    id: CAMPAIGN_ID,
    tenantId: "default",
    name: "Voice Check",
    rulesetId: "dnd5e",
    behaviorSpecVersion: "v0.1",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  const tenantDb = new TenantDb(db, "default");

  const behaviorSpec = loadBehaviorSpec(findDefaultBehaviorSpec(import.meta.dirname));
  const llm = new AnthropicProvider({ apiKey: anthropicKey, defaultEffortNarration: "low" });
  const dispatcher = new ToolDispatcher({ registry: createDefaultRegistry() });
  const foundry = new MockFoundryClient({
    system: "dnd5e",
    actors: PARTY,
    partyActorIds: PARTY.map((a) => a.id),
  });
  const session = startSession({
    sessionId: `voice-check-${now}`,
    campaignId: CAMPAIGN_ID,
    behaviorSpec,
    llm,
    dispatcher,
    foundry,
    tenantDb,
    eagerness: "balanced",
  });

  // --- voice I/O ---
  const stt = new DeepgramStreamingSTT({ apiKey: deepgramKey, encoding: "linear16", sampleRate: 48_000, channels: 2, language: "en" });
  const tts = new ElevenLabsTTS({ apiKey: elevenKey, defaultVoiceId: DM_VOICE_ID });
  const library = new ElevenLabsVoiceLibrary({ apiKey: elevenKey });

  console.log("→ logging in…");
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
  await client.login(token);
  await ready;
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isVoiceBased()) throw new Error(`channel ${channelId} is not a voice channel`);
  console.log(`  ✓ ${client.user?.tag} → #${channel.name} in "${channel.guild.name}"`);

  const connection = joinVoiceChannel({
    channelId,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  const guild = channel.guild;
  const voiceIO = new DiscordVoiceIO({
    connection,
    stt,
    tts,
    isConsented: () => true,
    resolveDisplayName: (id) => guild.members.cache.get(id)?.displayName,
  });

  // Per-character voice routing: DM persona for narration, AI-assigned + cached
  // ElevenLabs voices for NPCs.
  const voiceRouting = {
    dmVoiceId: DM_VOICE_ID,
    getNpcVoice: (key: string) =>
      tenantDb.voiceAssignments.get(CAMPAIGN_ID, "npc", key)?.providerVoiceId,
    assignNpcVoice: async (key: string): Promise<string> => {
      const voices = await library.list();
      const a = await assignNpcVoiceLLM(llm, { npcKey: key, npcDescription: key, library: voices });
      tenantDb.voiceAssignments.upsert({
        campaignId: CAMPAIGN_ID,
        subjectKind: "npc",
        subjectKey: key,
        providerVoiceId: a.providerVoiceId,
        source: "ai",
        assignedAt: Date.now(),
      });
      console.log(`  · assigned NPC "${key}" → voice ${a.providerVoiceId}`);
      return a.providerVoiceId;
    },
  };

  console.log(`\n🎲 DM is live for ${seconds}s. Introduce yourself, then declare an action.\n`);
  const stop = setTimeout(() => void voiceIO.close(), seconds * 1000);

  const result = await runAlwaysListeningSession({
    voiceIO,
    session,
    consentText: VOICE_CONSENT_TEXT,
    voiceRouting,
    onDecision: (d, frags) => {
      const heard = frags.map((f) => f.text).join(" | ");
      console.log(`  · decide: respond=${d.respond} (${d.reason}) ← "${heard}"`);
    },
    onTurn: (turn) => {
      console.log(`  🗣  DM: ${turn.narration}`);
      if (turn.toolCalls.length > 0) {
        console.log(`     tools: ${turn.toolCalls.map((t) => `${t.name}(${t.ok ? "ok" : "fail"})`).join(", ")}`);
      }
    },
  });

  clearTimeout(stop);
  console.log(`\n✓ Layer 3 done: ${result.decisionCount} decision(s), ${result.turnCount} DM turn(s).`);
  endSession(session);
  connection.destroy();
  await client.destroy();
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("\n✗ Layer 3 FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
