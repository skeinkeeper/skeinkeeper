// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import type { AnalyticsClient } from "@skeinkeeper/telemetry";
import type { AppConfig } from "./config.js";
import { ConsentService } from "./consent.js";
import { createFoundrySource, type FoundrySource } from "./foundry_source.js";
import { buildProviders, memoryStoreFor, type AppProviders } from "./providers.js";
import { SessionManager, type AppEvent } from "./session_manager.js";

/**
 * Wires the operator app from config: opens the on-disk DB, ensures the
 * tenant + campaign rows, builds providers + the per-tenant memory store, and
 * constructs the SessionManager. Returns the pieces the web UI (Phase 5b)
 * mounts on. Foundry is the real OSS MCP bridge when FOUNDRY_MCP_COMMAND is
 * set (connected at session start), else a mock.
 */
export interface App {
  config: AppConfig;
  tenantDb: TenantDb;
  providers: AppProviders;
  consent: ConsentService;
  manager: SessionManager;
}

export function createApp(
  config: AppConfig,
  opts: {
    foundry?: FoundrySource;
    onEvent?: (event: AppEvent) => void;
    analytics?: AnalyticsClient;
  } = {},
): App {
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb({ path: join(config.dataDir, "skeinkeeper.db"), runMigrations: true });

  const now = Date.now();
  db.insert(schema.tenants)
    .values({ id: config.tenantId, name: config.tenantId, createdAt: now })
    .onConflictDoNothing()
    .run();
  db.insert(schema.campaigns)
    .values({
      id: config.campaignId,
      tenantId: config.tenantId,
      name: config.campaignId,
      rulesetId: "dnd5e",
      behaviorSpecVersion: "v0.1",
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();

  const tenantDb = new TenantDb(db, config.tenantId);
  const providers = buildProviders(config);
  const memoryStore = memoryStoreFor(config, providers.embed.dimensions, config.tenantId);
  const foundry = opts.foundry ?? createFoundrySource(config, process.env);
  const consent = new ConsentService(tenantDb);

  const manager = new SessionManager({
    config,
    tenantDb,
    providers,
    foundry,
    consent,
    memoryStore,
    campaignId: config.campaignId,
    ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
    ...(opts.analytics !== undefined ? { analytics: opts.analytics } : {}),
  });

  return { config, tenantDb, providers, consent, manager };
}
