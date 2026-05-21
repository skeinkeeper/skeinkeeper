// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { LLMProvider, LLMRequest } from "../interfaces/llm.js";

/**
 * Anticipatory reasoning — "think while listening" (design doc 0028 §P3, after
 * the LTS-VoiceAgent listen-think-speak pattern). While a player is still
 * talking, a cheap orchestration-tier (Haiku) pass can pre-plan a
 * resolution-independent opening from the *partial* transcript, so when the turn
 * fires the DM can begin immediately.
 *
 * EXPERIMENTAL — these are the building blocks (a pure trigger + the pre-plan
 * call), unit-tested but **not wired into the live loop**. Enabling it requires
 * surfacing STT partials to the loop and measuring the token cost against the
 * latency win on real sessions — the design gates it behind P1/P2 proving out.
 * Until then this is opt-in scaffolding, off by default.
 */

export interface PreplanDecisionOptions {
  /** Minimum words in the partial before pre-planning is worthwhile. Default 5. */
  minWords?: number;
}

/**
 * Whether a partial transcript is developed enough to speculatively pre-plan on.
 * Pure + cheap (no model call). Conservative: enough words, and the partial
 * doesn't trail off mid-token (Deepgram partials are word-complete, but guard
 * anyway). Speculation on too-little input wastes tokens and is usually wrong.
 */
export function shouldPreplan(
  partialTranscript: string,
  opts: PreplanDecisionOptions = {},
): boolean {
  const minWords = opts.minWords ?? 5;
  const trimmed = partialTranscript.trim();
  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < minWords) return false;
  // A trailing hyphen/ellipsis reads as "still going" — wait for it to settle.
  return !/[-–—]$|\.\.\.$/.test(trimmed);
}

export interface PreplanInput {
  /** The in-progress (partial) player transcript. */
  partialTranscript: string;
  /** A few recent dialogue lines for scene context (optional). */
  recentDialogue?: ReadonlyArray<string>;
}

const SYSTEM_PROMPT = [
  "A player at a tabletop RPG is still mid-sentence. From their PARTIAL line, predict where they're going and give the DM a one-line, resolution-independent opening it can start narrating immediately — sensory/scene detail only, never the outcome.",
  "Output just that single line, no preamble.",
].join("\n");

/**
 * Speculatively pre-plan an opening from the partial transcript (Haiku). Returns
 * a short hint the real turn can lead with, or "" on any failure (best-effort —
 * a pre-plan must never break or block the turn). Off the response path by
 * design.
 */
export async function preplanIntent(llm: LLMProvider, input: PreplanInput): Promise<string> {
  const lines = [`Partial: "${input.partialTranscript.trim()}"`];
  if (input.recentDialogue && input.recentDialogue.length > 0) {
    lines.push("Recent:");
    for (const d of input.recentDialogue.slice(-4)) lines.push(`  - ${d}`);
  }
  const req: LLMRequest = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: lines.join("\n") }] }],
    tools: [],
    modelTier: "orchestration",
  };
  let text = "";
  try {
    for await (const ev of llm.complete(req)) {
      if (ev.kind === "text_delta") text += ev.text;
      else if (ev.kind === "error") return "";
    }
  } catch {
    return "";
  }
  return text.trim();
}
