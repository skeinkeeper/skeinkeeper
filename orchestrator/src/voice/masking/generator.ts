// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { LLMProvider, LLMRequest } from "../../interfaces/llm.js";
import { extractFirstJsonObject } from "../../util/extract_json.js";
import { NEUTRAL_TAG, type Filler } from "./filler.js";

/**
 * Background filler generation (design doc 0028 §P2). The slow, **off-critical-
 * path** half of masking: a cheap orchestration-tier (Haiku) call produces a
 * batch of short, content-neutral DM beats, **seeded from the current scene** so
 * the pool drifts to match tone over the session. Selection (selector.ts) then
 * draws from the pool instantly. Run this during lulls / while a real turn
 * generates — never on the response path.
 *
 * Privacy (design doc 0028): fillers are atmosphere/gesture only — the prompt
 * forbids naming or quoting a player and forbids resolving any action, so a
 * cached/persisted clip can never carry player content.
 */

const VALID_TAGS = new Set([
  "combat",
  "social",
  "exploration",
  "tension",
  "comedic",
  "mystery",
  NEUTRAL_TAG,
]);

/** Drop anything longer than this (fillers must be short to be cheap + snappy). */
const MAX_FILLER_CHARS = 120;

const SYSTEM_PROMPT = [
  "You write very short 'thinking beats' for an AI Dungeon Master — atmospheric lines it can say to fill a beat while it composes its real response.",
  "Hard rules:",
  "- Atmosphere or gesture ONLY (weather, sounds, light, an NPC's small movement). Never resolve an action, advance the plot, or reveal information.",
  "- NEVER name, quote, or describe a specific player or their character. Stay generic.",
  "- Keep each under 12 words. No questions.",
  "- Tag each line with 1-3 of: combat, social, exploration, tension, comedic, mystery, neutral. Use 'neutral' for lines that fit any scene.",
  'Respond with ONLY a JSON object: {"fillers": [{"text": "...", "tags": ["..."]}]}',
].join("\n");

export interface GenerateFillersInput {
  /** Recent dialogue lines (scene context to seed tone). */
  recentDialogue?: ReadonlyArray<string>;
  /** Scene tags to bias toward (e.g. ["combat"]). */
  sceneTags?: ReadonlyArray<string>;
  /** DM persona/tone hint (the active behavior-spec preset). */
  persona?: string;
  /** How many to request. Default 12. */
  count?: number;
}

export async function generateFillers(
  llm: LLMProvider,
  input: GenerateFillersInput = {},
): Promise<Filler[]> {
  const count = input.count ?? 12;
  const req: LLMRequest = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: buildUserPrompt(input, count) }] }],
    tools: [],
    modelTier: "orchestration",
  };

  let text = "";
  try {
    for await (const ev of llm.complete(req)) {
      if (ev.kind === "text_delta") text += ev.text;
      else if (ev.kind === "error") return [];
    }
  } catch {
    return []; // generation is best-effort; never throw onto the caller
  }
  return parseFillers(text, count);
}

function buildUserPrompt(input: GenerateFillersInput, count: number): string {
  const lines: string[] = [`Write ${count} thinking beats.`];
  if (input.persona) lines.push(`DM tone: ${input.persona}`);
  if (input.sceneTags && input.sceneTags.length > 0) {
    lines.push(`Current scene leans: ${input.sceneTags.join(", ")} (also include some neutral).`);
  }
  if (input.recentDialogue && input.recentDialogue.length > 0) {
    lines.push("Recent table moments (for tone only — do not quote or reference players):");
    for (const d of input.recentDialogue.slice(-6)) lines.push(`  - ${d}`);
  }
  return lines.join("\n");
}

/** Parse + sanitize the model's JSON into valid Fillers (best-effort). */
export function parseFillers(raw: string, cap: number): Filler[] {
  const obj = extractFirstJsonObject(raw);
  const arr = obj?.fillers;
  if (!Array.isArray(arr)) return [];
  const out: Filler[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { text?: unknown; tags?: unknown };
    if (typeof rec.text !== "string") continue;
    const text = rec.text.trim();
    if (text.length === 0 || text.length > MAX_FILLER_CHARS) continue;
    const tags = Array.isArray(rec.tags)
      ? [
          ...new Set(
            rec.tags.filter((t): t is string => typeof t === "string" && VALID_TAGS.has(t)),
          ),
        ]
      : [];
    out.push({ text, tags: tags.length > 0 ? tags : [NEUTRAL_TAG] });
    if (out.length >= cap) break;
  }
  return out;
}
