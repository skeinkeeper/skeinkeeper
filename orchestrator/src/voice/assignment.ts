// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { LLMOptions, LLMProvider, LLMRequest } from "../interfaces/llm.js";
import { extractFirstJsonObject } from "../util/extract_json.js";
import type { VoiceLibraryEntry } from "./library.js";
import type { NarrationSegment } from "./markers.js";

/**
 * AI-driven NPC→voice assignment (design doc 0017). Given an NPC's
 * description and the available voice library, an orchestration-tier model
 * picks the best-fitting voice. The result is persisted by the caller so the
 * NPC sounds the same across sessions; this module is the (testable) matching
 * logic only — it does no persistence.
 */

export interface NpcVoiceAssignment {
  providerVoiceId: string;
  reason?: string;
}

const SYSTEM_PROMPT = [
  "You assign a text-to-speech voice to a tabletop RPG NPC.",
  "You are given the NPC's description and a catalog of available voices,",
  "each with an id, name, and description (gender, age, accent, timbre).",
  "Pick the single voice whose description best fits the NPC.",
  'Respond with ONLY a JSON object: {"voiceId": "<id from the catalog>", "reason": "<short>"}.',
  "The voiceId MUST be one of the catalog ids. Do not invent an id.",
].join(" ");

function buildRequest(
  npcKey: string,
  npcDescription: string,
  library: ReadonlyArray<VoiceLibraryEntry>,
): LLMRequest {
  const catalog = library
    .map((v) => `- id: ${v.id} | name: ${v.name} | ${v.description}`)
    .join("\n");
  const userText = [
    `NPC key: ${npcKey}`,
    `NPC description: ${npcDescription}`,
    "",
    "Available voices:",
    catalog,
  ].join("\n");
  return {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
    tools: [],
    modelTier: "orchestration",
    effort: "low",
  };
}

function parseChoice(text: string): { voiceId?: string | undefined; reason?: string | undefined } {
  const obj = extractFirstJsonObject(text);
  if (obj === null) return {};
  return {
    voiceId: typeof obj.voiceId === "string" ? obj.voiceId : undefined,
    reason: typeof obj.reason === "string" ? obj.reason : undefined,
  };
}

export class VoiceAssignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceAssignmentError";
  }
}

export async function assignNpcVoice(
  llm: LLMProvider,
  args: { npcKey: string; npcDescription: string; library: ReadonlyArray<VoiceLibraryEntry> },
  opts?: LLMOptions,
): Promise<NpcVoiceAssignment> {
  if (args.library.length === 0) {
    throw new VoiceAssignmentError("voice library is empty; cannot assign an NPC voice");
  }

  const req = buildRequest(args.npcKey, args.npcDescription, args.library);
  let text = "";
  for await (const ev of llm.complete(req, opts)) {
    if (ev.kind === "text_delta") text += ev.text;
    else if (ev.kind === "error") {
      throw new VoiceAssignmentError(`voice assignment LLM error: ${ev.error.message}`);
    }
  }

  const choice = parseChoice(text);
  // Accept an id, or fall back to matching the model's answer against names.
  const byId = args.library.find((v) => v.id === choice.voiceId);
  const resolved =
    byId ??
    args.library.find((v) => v.name.toLowerCase() === (choice.voiceId ?? "").toLowerCase());
  if (!resolved) {
    throw new VoiceAssignmentError(
      `model did not return a valid voice id (got ${JSON.stringify(choice.voiceId)})`,
    );
  }
  return { providerVoiceId: resolved.id, ...(choice.reason ? { reason: choice.reason } : {}) };
}

export interface ResolvedSpeechSegment {
  text: string;
  voiceId: string;
}

/**
 * Resolve parsed narration segments to ordered (text, voiceId) pairs ready
 * for the TTS path. DM segments use `dmVoiceId`; NPC segments use a persisted
 * assignment via `getNpcVoice`, assigning one on first encounter via
 * `assignNpcVoice` (which the caller wires to the LLM + persistence).
 */
export async function resolveSegmentVoices(
  segments: ReadonlyArray<NarrationSegment>,
  resolvers: {
    dmVoiceId: string;
    getNpcVoice: (npcKey: string) => string | undefined;
    assignNpcVoice: (npcKey: string) => Promise<string>;
  },
): Promise<ResolvedSpeechSegment[]> {
  const out: ResolvedSpeechSegment[] = [];
  for (const seg of segments) {
    if (seg.kind === "dm") {
      out.push({ text: seg.text, voiceId: resolvers.dmVoiceId });
    } else {
      const existing = resolvers.getNpcVoice(seg.npcKey);
      const voiceId = existing ?? (await resolvers.assignNpcVoice(seg.npcKey));
      out.push({ text: seg.text, voiceId });
    }
  }
  return out;
}
