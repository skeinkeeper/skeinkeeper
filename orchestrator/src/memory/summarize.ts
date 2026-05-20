// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { DialogueTurn } from "../hot_context.js";
import type { LLMOptions, LLMProvider, LLMRequest } from "../interfaces/llm.js";
import { extractFirstJsonObject } from "../util/extract_json.js";
import { formatSpeakerLine } from "../util/format.js";

/**
 * Episodic summary generation (design doc 0019 §3). At session end an
 * orchestration-tier model condenses the transcript into a structured
 * summary: prose recap PLUS explicit structured deltas (quest flags, NPCs
 * met/died, party decisions, unresolved threads). Deltas are kept separate
 * from prose so later consolidation can't lose them (ADR-0002).
 *
 * Pure logic: this produces the summary; the caller embeds + stores it.
 */
export interface EpisodicSummary {
  text: string;
  deltas: Record<string, unknown>;
}

const SYSTEM_PROMPT = [
  "You summarize a tabletop RPG session for the AI Dungeon Master's long-term",
  "memory. Produce a concise prose recap AND a structured list of concrete",
  "deltas (quest flags changed, NPCs met or killed, party decisions, items",
  "gained/lost, unresolved threads). The deltas must capture facts the DM will",
  "need in a later session, separate from the prose.",
  'Respond with ONLY JSON: {"summary": "<prose>", "deltas": { ... }}.',
].join(" ");

function renderTranscript(dialogue: ReadonlyArray<DialogueTurn>): string {
  return dialogue.map((t) => formatSpeakerLine(t)).join("\n");
}

function parse(text: string): EpisodicSummary | null {
  const obj = extractFirstJsonObject(text);
  if (obj === null) return null;
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  if (summary.length === 0) return null;
  const deltas =
    obj.deltas !== null && typeof obj.deltas === "object"
      ? (obj.deltas as Record<string, unknown>)
      : {};
  return { text: summary, deltas };
}

export class EpisodicSummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpisodicSummaryError";
  }
}

export async function generateEpisodicSummary(
  llm: LLMProvider,
  dialogue: ReadonlyArray<DialogueTurn>,
  opts?: LLMOptions,
): Promise<EpisodicSummary> {
  if (dialogue.length === 0) {
    throw new EpisodicSummaryError("no dialogue to summarize");
  }
  const req: LLMRequest = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: renderTranscript(dialogue) }] }],
    tools: [],
    modelTier: "orchestration",
    effort: "low",
  };

  let text = "";
  for await (const ev of llm.complete(req, opts)) {
    if (ev.kind === "text_delta") text += ev.text;
    else if (ev.kind === "error") {
      throw new EpisodicSummaryError(`summary LLM error: ${ev.error.message}`);
    }
  }

  const parsed = parse(text);
  if (parsed === null) {
    throw new EpisodicSummaryError("model did not return a usable summary");
  }
  const result: EpisodicSummary = { text: parsed.text, deltas: parsed.deltas };
  return result;
}
