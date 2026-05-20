// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Extract and parse the first `{...}` JSON object from a model's text response.
 * Models often wrap JSON in prose or fences; this pulls the outermost object and
 * parses it. Returns `null` when there's no object or it doesn't parse — callers
 * do their own field-shape validation on the result.
 *
 * Shared by the orchestration-tier deciders (respond decider, NPC voice
 * assignment, episodic summary), which all expect a single JSON object back.
 */
export function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
