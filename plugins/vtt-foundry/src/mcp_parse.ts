// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Defensive parsing for the OSS Foundry MCP bridge's responses, which wrap
 * results in varying envelope shapes across versions (design doc 0014). Shared
 * by the client + the compendium reader so there's one canonical set rather
 * than two subtly-different copies.
 */

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** A string only if non-empty (compendium ids/names must be present). */
export function nonEmptyStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** The first present key's value, else the input unchanged (envelope-stripping). */
export function unwrap(res: unknown, keys: ReadonlyArray<string>): unknown {
  const rec = asRecord(res);
  if (!rec) return res;
  for (const k of keys) {
    if (k in rec) return rec[k];
  }
  return res;
}

/** A `res` that's already an array, or the first array-valued key, else []. */
export function toArray(res: unknown, keys: ReadonlyArray<string>): unknown[] {
  if (Array.isArray(res)) return res;
  const rec = asRecord(res);
  if (rec) {
    for (const k of keys) {
      if (Array.isArray(rec[k])) return rec[k] as unknown[];
    }
  }
  return [];
}
