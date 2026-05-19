// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

// CLI entry point: opens the DB at $SKEINKEEPER_DB_PATH (defaults to ./data/skeinkeeper.db)
// and applies any pending migrations.

import { openDb } from "./db.js";

const path = process.env.SKEINKEEPER_DB_PATH ?? "./data/skeinkeeper.db";
const db = openDb({ path, runMigrations: true });
db.close();
console.log(`Migrations applied to ${path}`);
