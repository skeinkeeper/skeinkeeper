// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { Utterance } from "../interfaces/voice.js";
import { formatSpeakerLine } from "../util/format.js";

/**
 * The rolling, per-speaker transcription buffer (design doc 0015 §1). The
 * always-listening loop captures every consented speaker's finalized
 * transcript fragments into here continuously, independent of the
 * respond cycle, so nothing said while the DM is thinking/speaking is lost.
 *
 * Ephemeral working memory only — durable persistence is the `dialogue`
 * table, written on each response flush.
 */
export interface BufferFragment {
  /** Discord user ID (or other stable speaker identifier). */
  speaker: string;
  displayName?: string;
  text: string;
  startTs: number;
  endTs: number;
  /** Whether this is a finalized STT result (only finalized fragments are
   *  retained; interim results inform timing only). */
  final: boolean;
}

export function utteranceToFragment(u: Utterance): BufferFragment {
  return {
    speaker: u.speaker,
    ...(u.displayName !== undefined ? { displayName: u.displayName } : {}),
    text: u.text,
    startTs: u.timestamp,
    endTs: u.timestamp,
    final: true,
  };
}

export class TranscriptionBuffer {
  private fragments: BufferFragment[] = [];

  /** Append a fragment. Only finalized fragments are retained. */
  append(fragment: BufferFragment): void {
    if (!fragment.final) return;
    this.fragments.push(fragment);
  }

  /** Fragments accumulated since the last drain, in arrival order. */
  pending(): ReadonlyArray<BufferFragment> {
    return [...this.fragments];
  }

  get size(): number {
    return this.fragments.length;
  }

  /** Take and clear all accumulated fragments (called when the DM responds). */
  drain(): BufferFragment[] {
    const out = this.fragments;
    this.fragments = [];
    return out;
  }
}

/** Render a buffer window as a speaker-labeled transcript for prompts. */
export function renderBuffer(fragments: ReadonlyArray<BufferFragment>): string {
  return fragments.map((f) => formatSpeakerLine(f)).join("\n");
}
