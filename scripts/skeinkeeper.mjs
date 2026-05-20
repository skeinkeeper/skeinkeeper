#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

// Thin wrapper that lets the operator run `pnpm skeinkeeper ...` from the
// repo root during alpha. A proper bin distribution lands with v0.5.
//
// This is the CLI's composition root: it injects the LanceDB MemoryAdapter
// (which `server` can't import without a dependency cycle) so campaign/tenant
// erasure also clears the on-box episodic vector store (ADR-0014).

import { join } from "node:path";
import { runCli } from "@skeinkeeper/server/cli";
import { LanceMemoryStore, MemoryAdapter } from "@skeinkeeper/memory-lance";

const dataDir = process.env.SKEINKEEPER_DATA_DIR ?? "./data";
// Deletion ignores embedding `dimensions` (it opens the existing table and
// drops rows), so a placeholder is fine for the erasure-only CLI use.
const memoryAdapter = new MemoryAdapter(
  (tenantId) => new LanceMemoryStore({ dir: join(dataDir, "memory", tenantId), dimensions: 0 }),
);

const exit = await runCli(process.argv.slice(2), {}, { extraDeletionAdapters: [memoryAdapter] });
process.exit(exit);
