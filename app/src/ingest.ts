// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Compendium-backed cold ingestion (TDD 0021), over the first-party Foundry
 * add-on (ADR-0029 / TDD 0041 — the third-party MCP spawn is withdrawn).
 *
 *   pnpm ingest:compendium goblin fireball grapple "cragmaw"
 *
 * Connects the add-on gateway (Foundry must be running with the Skeinkeeper
 * add-on enabled and paired), searches the world's compendia for each term, and
 * embeds the hits into the per-tenant cold tier. Embed text is name+type from
 * the search index today; full-description ingestion awaits an add-on
 * `getCompendiumEntry` method (TDD 0021 follow-up). Operator-run and
 * operator-validated (it needs a live Foundry).
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LocalEmbeddingProvider } from "@skeinkeeper/embed-local";
import { ingestColdEntries } from "@skeinkeeper/orchestrator";
import { EnvKeySource, loadEffectiveEnv } from "@skeinkeeper/server";
import { readCompendiumEntries } from "@skeinkeeper/vtt-foundry";
import { loadConfig } from "./config.js";
import { loadDotenv } from "./dotenv.js";
import { createFoundrySource } from "./foundry_source.js";
import { memoryStoreFor } from "./providers.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function main(): Promise<void> {
  const queries = process.argv.slice(2).filter((a) => a.trim().length > 0);
  if (queries.length === 0) {
    console.error(
      'Usage: pnpm ingest:compendium <term> [term ...]\n  e.g. pnpm ingest:compendium goblin fireball "cragmaw"',
    );
    process.exit(1);
  }

  loadDotenv(REPO_ROOT);
  const baseEnv = process.env;
  const dataDir = baseEnv["SKEINKEEPER_DATA_DIR"] ?? "./data";
  const env = loadEffectiveEnv(baseEnv, {
    path: join(dataDir, "secrets.sealed"),
    keySource: new EnvKeySource(baseEnv),
  });
  const config = loadConfig(env);

  const embed = new LocalEmbeddingProvider();
  const store = memoryStoreFor(config, embed.dimensions, config.tenantId);
  const foundrySource = createFoundrySource(config, process.env);

  let foundry;
  try {
    foundry = await foundrySource.connect();
  } catch (err) {
    console.error(
      `Foundry add-on did not connect: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      "Enable the Skeinkeeper add-on in your running Foundry world (paired), then retry.",
    );
    process.exit(1);
  }

  try {
    const entries = await readCompendiumEntries(foundry, { queries });
    if (entries.length === 0) {
      console.log("No compendium entries matched those terms.");
      return;
    }
    const count = await ingestColdEntries(embed, store, {
      campaignId: config.campaignId,
      entries: entries.map((e) => ({ id: e.id, text: e.text })),
    });
    console.log(
      `Ingested ${count} compendium entr${count === 1 ? "y" : "ies"} into the cold tier (tenant ${config.tenantId}).`,
    );
  } finally {
    await foundrySource.close();
  }
}

main().catch((err: unknown) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
