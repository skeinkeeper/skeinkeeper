// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Load (or, on first run, generate) the per-installation salt used for
 * one-way hashing of subject identifiers in the deletion log.
 *
 * Alpha-only: stored as a file at `${dataDir}/.salt`. In v0.5+ this moves
 * to the OS keyring per ADR-0010.
 */
export function loadOrCreateSalt(saltPath: string): string {
  if (existsSync(saltPath)) {
    const raw = readFileSync(saltPath, "utf8").trim();
    if (raw.length >= 32) return raw;
  }
  const salt = randomBytes(32).toString("hex");
  mkdirSync(dirname(saltPath), { recursive: true });
  writeFileSync(saltPath, salt, { mode: 0o600 });
  return salt;
}
