// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Latency-masking fillers (design doc 0028 P2). A filler is a short, content-
 * neutral DM beat ("Dust drifts in the torchlight.") played to cover the gap
 * before real narration can start — used *rarely*, only above a latency
 * threshold, and never repeated close together (the "arrow to the knee" trap).
 *
 * Fillers carry **context tags** so selection can match the current scene, with
 * a `neutral` tag marking lines safe to play in any context (the fail-safe: a
 * wrong-context filler is worse than a generic one — design doc 0028 §P2).
 */

/** Tag marking a filler safe to play in any scene (the fail-safe pool). */
export const NEUTRAL_TAG = "neutral";

export interface Filler {
  /** The DM line to speak. Content-neutral — never quotes a player (privacy). */
  text: string;
  /** Context tags, e.g. "combat" | "social" | "exploration" | "tension";
   *  include NEUTRAL_TAG for lines safe anywhere. */
  tags: ReadonlyArray<string>;
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "you",
  "your",
  "he",
  "she",
  "it",
  "they",
  "his",
  "her",
  "their",
]);

/** Stable id for dedupe + recency/bag tracking — the normalized text. */
export function fillerId(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The leading "stem" (first content word) — what makes two fillers feel like
 * the same gesture ("strokes his beard" / "strokes his chin"). Selection
 * down-weights recently-used stems so variety isn't just line-level.
 */
export function fillerStem(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  for (const w of words) {
    if (!STOPWORDS.has(w)) return w;
  }
  return words[0] ?? "";
}
