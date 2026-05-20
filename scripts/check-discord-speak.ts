// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Layer 1 voice validation: the bot joins a Discord voice channel and speaks
 * one line via DiscordVoiceIO.speak(), then leaves. Validates the output half
 * of the voice stack — @discordjs/voice playback + ffmpeg + opus + sodium +
 * ElevenLabs TTS — without the (trickier) audio-receive path.
 *
 * Prereqs:
 *   - ffmpeg on PATH (`sudo apt install ffmpeg`).
 *   - Bot invited to the server with Connect + Speak on the target channel.
 *   - .env with DISCORD_BOT_TOKEN + ELEVENLABS_API_KEY.
 *
 * Run (be in the channel to hear it):
 *   pnpm check:discord-speak -- --guild <id> --channel <id>
 *   (or set DISCORD_GUILD_ID / DISCORD_VOICE_CHANNEL_ID in .env)
 *
 * Optional: ELEVENLABS_DM_VOICE_ID to pick the voice (default: George).
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client, Events, GatewayIntentBits } from "discord.js";
import {
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import { DiscordVoiceIO, ElevenLabsTTS } from "@skeinkeeper/voice-discord";
import type { STTProvider } from "@skeinkeeper/orchestrator";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LINE = "Skeinkeeper is online. If you can hear this, the voice path works.";
const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"; // George — warm storyteller

function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!;
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) {
    console.error(`Missing ${label}`);
    process.exit(1);
  }
  return value;
}

// speak-only test never reads audio; a no-op STT satisfies the interface.
const noopStt: STTProvider = {
  name: "noop",
  // eslint-disable-next-line require-yield
  async *transcribe() {
    return;
  },
};

/**
 * Diagnostic only: dig through @discordjs/voice internals to log the voice
 * WebSocket close code (4006 = session invalid, 1006 = abnormal/network
 * reset, 4014/4015 = server-side). Not part of the shipped adapter.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function hookWsCloseCodes(connection: { on: (e: string, l: (...a: any[]) => void) => void; state: any }): void {
  const seenNet = new WeakSet<object>();
  const seenWs = new WeakSet<object>();
  const hookWs = (netState: any): void => {
    const ws = netState?.ws;
    if (ws && typeof ws.on === "function" && !seenWs.has(ws)) {
      seenWs.add(ws);
      ws.on("close", (ev: any) => {
        const code = typeof ev === "number" ? ev : ev?.code;
        console.log(`  ⋯ [WS close] code=${code} reason=${ev?.reason ?? ""}`);
      });
    }
  };
  const hookNet = (state: any): void => {
    const net = state?.networking;
    if (net && typeof net.on === "function" && !seenNet.has(net)) {
      seenNet.add(net);
      net.on("stateChange", (_o: any, n: any) => hookWs(n));
      hookWs(net.state);
    }
  };
  connection.on("stateChange", (_o: any, n: any) => hookNet(n));
  hookNet(connection.state);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function main(): Promise<void> {
  loadEnv(join(REPO_ROOT, ".env"));
  const token = requireValue(process.env["DISCORD_BOT_TOKEN"], "DISCORD_BOT_TOKEN in .env");
  const elevenKey = requireValue(process.env["ELEVENLABS_API_KEY"], "ELEVENLABS_API_KEY in .env");
  const channelId = requireValue(
    arg("--channel") ?? process.env["DISCORD_VOICE_CHANNEL_ID"],
    "--channel <id> (or DISCORD_VOICE_CHANNEL_ID)",
  );
  const voiceId = process.env["ELEVENLABS_DM_VOICE_ID"] ?? DEFAULT_VOICE_ID;

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  console.log("→ logging in…");
  // login() resolves before the gateway has cached guilds; wait for ClientReady
  // so the voice adapter can route VOICE_SERVER_UPDATE for the guild.
  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
  await client.login(token);
  await ready;
  console.log(`  ✓ logged in as ${client.user?.tag ?? "?"}`);

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isVoiceBased()) {
    throw new Error(`channel ${channelId} is not a voice channel (or not visible to the bot)`);
  }
  console.log(`  ✓ channel: #${channel.name} in "${channel.guild.name}"`);

  console.log("→ joining voice channel…");
  const debug = process.argv.includes("--debug");
  const connection = joinVoiceChannel({
    channelId,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    debug,
  });

  // Surface the connection lifecycle so a stall is diagnosable (Signalling →
  // Connecting → Ready). Getting stuck at Connecting points at UDP (the WSL2
  // voice path). Pass --debug for the full @discordjs/voice networking trace.
  connection.on("stateChange", (oldState, newState) => {
    console.log(`  · voice: ${oldState.status} → ${newState.status}`);
  });
  connection.on("error", (err: Error) => {
    console.error(`  · voice connection error: ${err.message}`);
  });
  if (debug) {
    connection.on("debug", (msg: string) => console.log(`  ⋯ ${msg}`));
    hookWsCloseCodes(connection);
  }

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    console.log("  ✓ connection ready");

    const tts = new ElevenLabsTTS({ apiKey: elevenKey, defaultVoiceId: voiceId });
    const voiceIO = new DiscordVoiceIO({
      connection,
      stt: noopStt,
      tts,
      isConsented: () => true,
    });

    console.log(`→ speaking (voice ${voiceId})…`);
    await voiceIO.speak(LINE, { voiceId });
    console.log("  ✓ playback finished");
    await voiceIO.close();
    console.log("\n✓ Layer 1 PASS — did you hear it in the channel?");
  } finally {
    connection.destroy();
    await client.destroy();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("\n✗ Layer 1 FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
