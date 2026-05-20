// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Compendium-backed cold ingestion (design doc 0021). Pulls game-system content
 * (monsters, spells, items, rules) matching the given search terms from the
 * connected Foundry world's compendia — via the real OSS MCP bridge — and
 * ingests it into the campaign's cold memory so the DM can recall it.
 *
 *   pnpm ingest:compendium goblin fireball grapple "cragmaw"
 *
 * Requires FOUNDRY_MCP_COMMAND set + Foundry running with the bridge connected.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ingestColdEntries } from "@skeinkeeper/orchestrator";
import { LocalEmbeddingProvider } from "@skeinkeeper/embed-local";
import { StdioMcpToolCaller, readCompendiumEntries } from "@skeinkeeper/vtt-foundry";
import { loadConfig } from "./config.js";
import { envRecord, loadDotenv } from "./dotenv.js";
import { memoryStoreFor } from "./providers.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function main(): Promise<void> {
  loadDotenv(REPO_ROOT);
  const config = loadConfig(process.env);
  const queries = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (queries.length === 0) {
    console.error('Usage: pnpm ingest:compendium <term> [term...]   e.g. goblin fireball "grapple"');
    process.exit(1);
  }
  const cmd = config.foundry.mcpCommand;
  if (cmd === undefined || cmd.length === 0) {
    console.error("FOUNDRY_MCP_COMMAND is not set — point it at your OSS bridge server.");
    process.exit(1);
  }

  const caller = new StdioMcpToolCaller({ command: cmd[0]!, args: cmd.slice(1), env: envRecord() });
  const embed = new LocalEmbeddingProvider();
  const store = memoryStoreFor(config, embed.dimensions, config.tenantId);

  try {
    console.log(`→ searching ${queries.length} term(s) in the connected world's compendia…`);
    const entries = await readCompendiumEntries(caller, { queries });
    console.log(`  ✓ ${entries.length} unique entr(y/ies) found`);
    if (entries.length === 0) {
      console.log("  (nothing to ingest)");
      return;
    }
    console.log("→ embedding + storing into cold memory (first run downloads the model)…");
    const n = await ingestColdEntries(embed, store, {
      campaignId: config.campaignId,
      entries: entries.map((e) => ({
        id: e.id,
        text: e.text,
        deltas: {
          name: e.name,
          type: e.type,
          ...(e.packLabel !== undefined ? { pack: e.packLabel } : {}),
          ...(e.system !== undefined ? { system: e.system } : {}),
        },
      })),
    });
    console.log(`\n✓ Ingested ${n} cold record(s) into campaign "${config.campaignId}".`);
  } finally {
    await caller.close().catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("\n✗ Ingestion failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
