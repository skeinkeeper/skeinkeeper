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
  "Skeinkeeper transcribes voice in this channel using your operator's configured " +
  "speech-to-text provider. Audio is streamed for transcription and immediately " +
  "discarded; we never store voice recordings. Transcripts are retained in your " +
  "operator's local Skeinkeeper instance. Do you consent to voice processing in " +
  "this channel? You can withdraw at any time with /skeinkeeper consent withdraw voice.";

export const VOICE_CONSENT_TEXT_VERSION = "v1";
