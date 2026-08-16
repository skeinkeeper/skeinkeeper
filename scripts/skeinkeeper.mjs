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
import { createPiiCrypto, EnvKeySource, loadOrCreateSalt } from "@skeinkeeper/server";
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
// The same PII hasher the app uses (TDD 0030), so player-scope memory erasure
// matches the hashed `player:<hash>` audience tokens written at runtime. Built
// from the same per-install salt + passphrase KeySource.
const piiCrypto = createPiiCrypto({
  keySource: new EnvKeySource(process.env),
  salt: loadOrCreateSalt(join(dataDir, ".salt")),
});
// Deletion ignores embedding `dimensions` (it opens the existing table and
// drops rows), so a placeholder is fine for the erasure-only CLI use.
const memoryAdapter = new MemoryAdapter(
  (tenantId) => new LanceMemoryStore({ dir: join(dataDir, "memory", tenantId), dimensions: 0 }),
  piiCrypto,
);

/** Open the MCP Foundry client for player:delete cascade (TDD 0038). */
async function openFoundryDeletionClient() {
  const raw = process.env.FOUNDRY_MCP_COMMAND?.trim();
  if (!raw) return null;
  const { McpFoundryClient, StdioMcpToolCaller } =
    await import("../plugins/vtt-foundry/src/index.ts");
  const argv = raw.split(/\s+/);
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e) => typeof e[1] === "string"),
  );
  const caller = new StdioMcpToolCaller({
    command: argv[0],
    args: argv.slice(1),
    env,
  });
  try {
    const client = await McpFoundryClient.connect(caller);
    return {
      foundry: client,
      close: () => caller.close().catch(() => undefined),
    };
  } catch {
    await caller.close().catch(() => undefined);
    return null;
  }
}

const foundrySession = await openFoundryDeletionClient();
const exit = await runCli(
  process.argv.slice(2),
  {},
  {
    extraDeletionAdapters: [memoryAdapter],
    ...(foundrySession !== null
      ? {
          foundry: foundrySession.foundry,
          probeFoundryConnected: async () => {
            try {
              const info = await foundrySession.foundry.getWorldInfo();
              return info.connected === true;
            } catch {
              return false;
            }
          },
        }
      : { probeFoundryConnected: async () => false }),
  },
);
await foundrySession?.close();
process.exit(exit);
