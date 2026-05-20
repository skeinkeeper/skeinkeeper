// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { VoiceIO } from "./interfaces/voice.js";
import { runTurn, type Session, type TurnOutput } from "./session.js";

/**
 * Voice session loop per design doc 0012. Bridges a `VoiceIO` to the
 * orchestrator's `runTurn`: consented utterances become turns, the AI DM's
 * narration is spoken back, and `consent_needed` signals trigger a consent
 * prompt (the adapter has already discarded the unconsented audio without
 * transcribing it).
 */

export interface VoiceSessionConfig {
  voiceIO: VoiceIO;
  session: Session;
  /** Consent text shown to players who haven't yet granted voice processing. */
  consentText: string;
  /** Optional mapper from a completed turn to a TTS voice ID (e.g., to
   *  voice an NPC differently). Returning undefined uses the default voice. */
  resolveVoiceId?: (turn: TurnOutput) => string | undefined;
  /** Optional hook invoked after each turn — for operator UI updates,
   *  logging, etc. */
  onTurn?: (turn: TurnOutput) => void;
}

/**
 * Run the voice session until the VoiceIO's `listen()` stream completes
 * (channel closed). Returns the number of turns processed.
 */
export async function runVoiceSession(config: VoiceSessionConfig): Promise<number> {
  const { voiceIO, session } = config;
  let turnCount = 0;

  for await (const event of voiceIO.listen()) {
    if (event.kind === "consent_needed") {
      await voiceIO.requestConsent(event.speaker, config.consentText);
      continue;
    }
    // The naive loop is per-utterance; it has no buffer, so lull/endpointing
    // signals are not actionable here (the always-listening loop uses them).
    if (event.kind !== "utterance") continue;

    const { utterance } = event;
    const turn = await runTurn(session, {
      speaker: utterance.speaker,
      ...(utterance.displayName !== undefined ? { displayName: utterance.displayName } : {}),
      text: utterance.text,
    });
    turnCount += 1;

    config.onTurn?.(turn);

    if (turn.narration.length > 0) {
      const voiceId = config.resolveVoiceId?.(turn);
      await voiceIO.speak(turn.narration, voiceId !== undefined ? { voiceId } : undefined);
    }
  }

  return turnCount;
}

/**
 * The default voice-processing consent text. Versioned via
 * VOICE_CONSENT_TEXT_VERSION so consent records can be tied to the exact
 * wording the player saw. Matches docs/PRIVACY.md.
 */
export const VOICE_CONSENT_TEXT =
  "Skeinkeeper (your group's AI Dungeon Master) would like to transcribe your voice " +
  "in this game's channel, using your operator's configured speech-to-text provider. " +
  "Audio is streamed for transcription and immediately discarded — we never store " +
  "voice recordings. Transcripts are kept in your operator's local Skeinkeeper " +
  "instance. The AI also keeps a shared, campaign-level memory of what happens at the " +
  "table; that shared record is not erased when an individual player asks to be " +
  "forgotten (your personal transcript lines and data are).\n\n" +
  "Tap **Grant voice consent** below to take part by voice. Until you do, your audio " +
  "is not transcribed. You can tap **Withdraw** here anytime (or run " +
  "`/skeinkeeper consent`).";

// v1 -> v2: shared-campaign-memory disclosure (ADR-0014).
// v2 -> v3: button-based grant/withdraw + clearer wording.
export const VOICE_CONSENT_TEXT_VERSION = "v3";
