// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Layer 2 voice validation: the bot joins a voice channel and prints a live
 * transcript of what it hears — validating the audio-receive path
 * (DiscordVoiceIO capture → opus decode → Deepgram STT → utterance events),
 * plus the lull signal the always-listening loop relies on.
 *
 * Consent is auto-granted for this test (isConsented → true); the real flow
 * gates per-player consent before STT.
 *
 * Run (be in the channel and talk):
 *   pnpm check:discord-listen            # listens 45s
 *   pnpm check:discord-listen -- --seconds 60
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { VoiceConnectionStatus, entersState, joinVoiceChannel } from "@discordjs/voice";
import { DeepgramStreamingSTT, DiscordVoiceIO } from "@skeinkeeper/voice-discord";
import type { TTSProvider } from "@skeinkeeper/orchestrator";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

function requireValue(value: string | undefined, label: string): string {
  if (!value) {
    console.error(`Missing ${label}`);
    process.exit(1);
  }
  return value;
}

// Listen-only test: never speaks, so a no-op TTS satisfies the interface.
const noopTts: TTSProvider = {
  name: "noop",
  async synthesize() {
    return new Uint8Array(0);
  },
};

async function main(): Promise<void> {
  loadEnv(join(REPO_ROOT, ".env"));
  const token = requireValue(process.env["DISCORD_BOT_TOKEN"], "DISCORD_BOT_TOKEN in .env");
  const deepgramKey = requireValue(process.env["DEEPGRAM_API_KEY"], "DEEPGRAM_API_KEY in .env");
  const channelId = requireValue(
    arg("--channel") ?? process.env["DISCORD_VOICE_CHANNEL_ID"],
    "--channel <id> (or DISCORD_VOICE_CHANNEL_ID)",
  );
  const seconds = Number(arg("--seconds") ?? "45");

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  console.log("→ logging in…");
  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
  await client.login(token);
  await ready;
  console.log(`  ✓ logged in as ${client.user?.tag ?? "?"}`);

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isVoiceBased()) {
    throw new Error(`channel ${channelId} is not a voice channel (or not visible to the bot)`);
  }
  console.log(`  ✓ channel: #${channel.name} in "${channel.guild.name}"`);

  const connection = joinVoiceChannel({
    channelId,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    // Must NOT self-deafen, or the bot receives no audio to transcribe.
    selfDeaf: false,
    selfMute: true,
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  console.log("  ✓ connection ready");

  // Discord decodes to 48 kHz stereo s16le PCM; tell Deepgram exactly that.
  const stt = new DeepgramStreamingSTT({
    apiKey: deepgramKey,
    encoding: "linear16",
    sampleRate: 48_000,
    channels: 2,
    language: "en",
  });

  const guild = channel.guild;
  const voiceIO = new DiscordVoiceIO({
    connection,
    stt,
    tts: noopTts,
    isConsented: () => true,
    resolveDisplayName: (id) => guild.members.cache.get(id)?.displayName,
  });

  console.log(`\n🎙  Listening for ${seconds}s — talk now. Transcripts:\n`);
  const stop = setTimeout(() => void voiceIO.close(), seconds * 1000);

  let utterances = 0;
  for await (const event of voiceIO.listen()) {
    if (event.kind === "utterance") {
      utterances += 1;
      const u = event.utterance;
      const conf = u.confidence !== undefined ? ` (${(u.confidence * 100).toFixed(0)}%)` : "";
      console.log(`  [${u.displayName ?? u.speaker}] ${u.text}${conf}`);
    } else if (event.kind === "consent_needed") {
      console.log(`  (consent needed: ${event.speaker})`);
    } else if (event.kind === "lull") {
      console.log(`  · lull`);
    }
  }

  clearTimeout(stop);
  console.log(`\n${utterances > 0 ? "✓" : "✗"} Layer 2 ${utterances > 0 ? "PASS" : "— heard nothing"}: ${utterances} utterance(s) transcribed.`);
  connection.destroy();
  await client.destroy();
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("\n✗ Layer 2 FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
