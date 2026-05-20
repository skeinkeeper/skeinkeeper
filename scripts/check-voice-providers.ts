// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Layer 0 voice validation (no Discord): exercises the live ElevenLabs +
 * Deepgram adapters end to end, chained:
 *
 *   1. ElevenLabsVoiceLibrary.list()  → your available voices
 *   2. ElevenLabsTTS.synthesize(...)  → an .mp3 written to disk
 *   3. DeepgramSTT.transcribe(mp3)    → the transcript of that clip
 *
 * If the transcript roughly matches the spoken line, the API keys and the
 * request shapes in all three adapters are correct. Run with:
 *
 *   pnpm check:voice
 *
 * Reads keys from the repo-root .env (ELEVENLABS_API_KEY, DEEPGRAM_API_KEY).
 * Optional: ELEVENLABS_DM_VOICE_ID to pin which voice synthesizes the clip.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DeepgramSTT,
  ElevenLabsTTS,
  ElevenLabsVoiceLibrary,
} from "@skeinkeeper/voice-discord";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE_LINE = "The cavern mouth yawns before you, cold and patient.";
const OUT_PATH = join(REPO_ROOT, "voice-check.mp3");

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

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
  return v;
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

async function main(): Promise<void> {
  loadEnv(join(REPO_ROOT, ".env"));
  const elevenKey = requireEnv("ELEVENLABS_API_KEY");
  const deepgramKey = requireEnv("DEEPGRAM_API_KEY");

  // 1) List voices.
  console.log("→ [1/3] ElevenLabs: listing voices…");
  const library = new ElevenLabsVoiceLibrary({ apiKey: elevenKey });
  const voices = await library.list();
  console.log(`  ✓ ${voices.length} voice(s) available:`);
  for (const v of voices.slice(0, 10)) {
    console.log(`    - ${v.name} (${v.id}) — ${v.description || "(no description)"}`);
  }
  if (voices.length > 10) console.log(`    … and ${voices.length - 10} more`);
  if (voices.length === 0) {
    console.error("  ✗ No voices on this account; cannot synthesize. Stopping.");
    process.exit(1);
  }

  const voiceId = process.env["ELEVENLABS_DM_VOICE_ID"] ?? voices[0]!.id;
  const voiceName = voices.find((v) => v.id === voiceId)?.name ?? voiceId;

  // 2) Synthesize.
  console.log(`→ [2/3] ElevenLabs: synthesizing with "${voiceName}"…`);
  const tts = new ElevenLabsTTS({ apiKey: elevenKey });
  const audio = await tts.synthesize(SAMPLE_LINE, { voiceId });
  writeFileSync(OUT_PATH, audio);
  console.log(`  ✓ wrote ${audio.length} bytes → ${OUT_PATH}`);
  console.log(`    (play it to confirm it sounds right)`);

  // 3) Transcribe the mp3 back through Deepgram (auto-detects container).
  console.log("→ [3/3] Deepgram: transcribing the clip…");
  const stt = new DeepgramSTT({ apiKey: deepgramKey });
  let transcript = "";
  for await (const u of stt.transcribe(once(audio), { speaker: "voice-check" })) {
    transcript += u.text;
  }
  console.log(`  spoken:     "${SAMPLE_LINE}"`);
  console.log(`  transcript: "${transcript}"`);

  if (transcript.trim().length === 0) {
    console.error("  ✗ Empty transcript — check the Deepgram key/plan.");
    process.exit(1);
  }
  console.log("\n✓ Layer 0 PASS — all three adapters reached their APIs successfully.");
  console.log("  Eyeball the transcript above; it should roughly match the spoken line.");
}

main().catch((err: unknown) => {
  console.error("\n✗ Layer 0 FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
