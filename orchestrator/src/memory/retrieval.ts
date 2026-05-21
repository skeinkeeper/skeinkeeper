// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { Audience } from "@skeinkeeper/server";
import type { EmbeddingProvider } from "../interfaces/embedding.js";
import type { DialogueTurn } from "../hot_context.js";
import type { MemoryKind, MemoryRecord, MemoryStore } from "./store.js";

/**
 * Cold/episodic retrieval (design doc 0019 §5). Builds a query from the
 * recent dialogue, embeds it, and returns the top-K relevant memory records
 * for injection into hot context. Bounded (small top-K) and only run on a
 * responding turn — never on the cheap decider path.
 */

export const DEFAULT_RETRIEVAL_TOP_K = 4;
const DEFAULT_QUERY_WINDOW = 6;

/** Compose a retrieval query from the most recent dialogue turns. */
export function buildMemoryQuery(
  dialogue: ReadonlyArray<DialogueTurn>,
  opts: { window?: number } = {},
): string {
  const window = opts.window ?? DEFAULT_QUERY_WINDOW;
  return dialogue
    .slice(-window)
    .map((t) => t.text)
    .join(" ")
    .trim();
}

export async function retrieveMemory(
  embed: EmbeddingProvider,
  store: MemoryStore,
  args: {
    query: string;
    campaignId: string;
    topK?: number;
    kinds?: ReadonlyArray<MemoryKind>;
    /** Audiences this conversation may see (design doc 0026 §10). Pass
     *  `allowedAudiencesFor(conversationId)` so a side-channel never retrieves
     *  another player's private or `gm` content. Absent = no audience filter. */
    audiences?: ReadonlyArray<Audience | string>;
  },
): Promise<MemoryRecord[]> {
  if (args.query.trim().length === 0) return [];
  const [vector] = await embed.embed([args.query]);
  if (vector === undefined) return [];
  return store.query(vector, {
    campaignId: args.campaignId,
    topK: args.topK ?? DEFAULT_RETRIEVAL_TOP_K,
    ...(args.kinds !== undefined ? { kinds: args.kinds } : {}),
    ...(args.audiences !== undefined ? { audiences: args.audiences } : {}),
  });
}
