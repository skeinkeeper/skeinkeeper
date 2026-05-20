// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Render one speaker-attributed transcript line as `[Name] text`, preferring a
 * display name and falling back to the raw speaker id. The single source of this
 * format, shared by the transcription buffer, the turn-input merge, the episodic
 * summary transcript, and the hot-context dialogue block — so they can't drift.
 */
export function formatSpeakerLine(line: {
  speaker: string;
  displayName?: string;
  text: string;
}): string {
  return `[${line.displayName ?? line.speaker}] ${line.text}`;
}
