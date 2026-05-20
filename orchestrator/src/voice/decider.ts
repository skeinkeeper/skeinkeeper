// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { LLMOptions, LLMProvider, LLMRequest } from "../interfaces/llm.js";
import { extractFirstJsonObject } from "../util/extract_json.js";
import { renderBuffer, type BufferFragment } from "./buffer.js";
import { eagernessInstruction, type Eagerness } from "./eagerness.js";

/**
 * The "should I respond?" decider (design doc 0015 §2). A cheap
 * orchestration-tier (Haiku) judgment over the recent transcription buffer:
 * does the DM need to speak now? True for direct address, consequential
 * action declarations, rules questions, and lulls; false for pure
 * inter-player deliberation. The Eagerness setting biases the threshold.
 *
 * Reserving the expensive narration model (Opus, via runTurn) for when this
 * returns true is the cost-correct two-tier split from design doc 0008.
 */
export interface RespondDecision {
  respond: boolean;
  reason: string;
}

const SYSTEM_PROMPT = [
  "You are the attention gate for an AI tabletop RPG Dungeon Master.",
  "Given a short transcript of what players just said, decide whether the DM",
  "should speak NOW. Respond when adjudication or DM input is warranted:",
  "a player addresses the DM, declares a consequential action the DM must",
  "resolve, asks a rules question, or the table has fallen into a lull and is",
  "waiting for the DM. ALSO respond when a player introduces themselves or",
  "names the character they are playing — the session-start ritual where the",
  "DM must acknowledge it aloud and record who is playing whom, so the player",
  "knows they were heard. Do NOT respond to pure player-to-player deliberation",
  "that needs no adjudication — that is context to absorb silently.",
  'Respond with ONLY a JSON object: {"respond": <true|false>, "reason": "<short>"}.',
].join(" ");

function buildRequest(transcript: string, level: Eagerness): LLMRequest {
  const userText = [eagernessInstruction(level), "", "Recent table transcript:", transcript].join(
    "\n",
  );
  return {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
    tools: [],
    modelTier: "orchestration",
    effort: "low",
  };
}

function parseDecision(text: string): RespondDecision | null {
  const obj = extractFirstJsonObject(text);
  if (obj === null || typeof obj.respond !== "boolean") return null;
  return {
    respond: obj.respond,
    reason: typeof obj.reason === "string" ? obj.reason : "",
  };
}

export async function decideShouldRespond(
  llm: LLMProvider,
  args: { fragments: ReadonlyArray<BufferFragment>; eagerness: Eagerness },
  opts?: LLMOptions,
): Promise<RespondDecision> {
  // No content to react to → stay quiet without spending a model call.
  if (args.fragments.length === 0) {
    return { respond: false, reason: "empty buffer" };
  }

  const req = buildRequest(renderBuffer(args.fragments), args.eagerness);
  let text = "";
  for await (const ev of llm.complete(req, opts)) {
    if (ev.kind === "text_delta") text += ev.text;
    else if (ev.kind === "error") {
      // Fail safe: stay quiet rather than crash or interrupt the table.
      return { respond: false, reason: `decider error: ${ev.error.message}` };
    }
  }

  const decision = parseDecision(text);
  // Unparseable → stay quiet (a chatty wrong-guess DM is the worse failure).
  return decision ?? { respond: false, reason: "undecided (unparseable response)" };
}
