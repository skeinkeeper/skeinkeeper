// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal `.env` loader shared by the app entrypoints (no dotenv dependency).
 * Reads `${repoRoot}/.env` if present and sets each `KEY=value` into
 * `process.env` *without* overriding values already set in the real environment.
 * Strips matching single/double quotes around the value.
 */
export function loadDotenv(repoRoot: string): void {
  const path = join(repoRoot, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/** `process.env` narrowed to defined string values (for `loadConfig`). */
export function envRecord(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}
