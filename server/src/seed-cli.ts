// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

// CLI entry for seeding. Reads from $SKEINKEEPER_SEED_PATH (default
// ./data/seed.yaml) and applies to $SKEINKEEPER_DB_PATH.

import { openDb } from "./db.js";
import { seedFromFile } from "./seed.js";

const dbPath = process.env.SKEINKEEPER_DB_PATH ?? "./data/skeinkeeper.db";
const seedPath = process.env.SKEINKEEPER_SEED_PATH ?? "./data/seed.yaml";

const db = openDb({ path: dbPath, runMigrations: true });
try {
  const { inserted } = seedFromFile(db, seedPath);
  console.log(`Seed: inserted ${inserted} row(s) from ${seedPath}`);
} finally {
  db.close();
}
