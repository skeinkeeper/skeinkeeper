// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as schema from "./schema/index.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenOptions {
  /** Path to the SQLite file. ":memory:" for an in-memory database. */
  path: string;
  /** If true, run pending migrations on open. */
  runMigrations?: boolean;
}

/**
 * Open the Skeinkeeper database. Callers own the returned handle and
 * should call `close()` on shutdown.
 */
export function openDb(options: OpenOptions): Db & { close: () => void } {
  const sqlite = new Database(options.path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });
  if (options.runMigrations) {
    const here = dirname(fileURLToPath(import.meta.url));
    migrate(db, { migrationsFolder: join(here, "..", "drizzle") });
  }

  return Object.assign(db, {
    close: () => sqlite.close(),
  });
}
