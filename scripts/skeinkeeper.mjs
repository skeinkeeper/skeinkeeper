#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

// Thin wrapper that lets the operator run `pnpm skeinkeeper ...` from the
// repo root during alpha. A proper bin distribution lands with v0.5.
//
// This is the CLI's composition root: it injects the LanceDB MemoryAdapter
// (which `server` can't import without a dependency cycle) so campaign/tenant
// erasure also clears the on-box episodic vector store (ADR-0014).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runCli } from "@skeinkeeper/server/cli";
import { LanceMemoryStore, MemoryAdapter } from "@skeinkeeper/memory-lance";

// Load repo-root .env into process.env so `secrets:seal` can read the secret
// values to seal (and every command sees the same env as the app). Existing env
// wins; quotes are stripped. Mirrors app/src/dotenv.ts (server can't import app).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadDotenv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
loadDotenv(join(REPO_ROOT, ".env"));

const dataDir = process.env.SKEINKEEPER_DATA_DIR ?? "./data";
// Deletion ignores embedding `dimensions` (it opens the existing table and
// drops rows), so a placeholder is fine for the erasure-only CLI use.
const memoryAdapter = new MemoryAdapter(
  (tenantId) => new LanceMemoryStore({ dir: join(dataDir, "memory", tenantId), dimensions: 0 }),
);

const exit = await runCli(process.argv.slice(2), {}, { extraDeletionAdapters: [memoryAdapter] });
process.exit(exit);
