// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { openDb } from "./db.js";
import { ErasureService, type ErasureScope, type DeletionAdapter } from "./erasure.js";
import { ExportService } from "./export.js";
import { ConsentsAdapter } from "./adapters/consents-adapter.js";
import { CampaignAdapter } from "./adapters/campaign-adapter.js";
import { AuditLogAdapter } from "./adapters/audit-log-adapter.js";
import { DialogueAdapter } from "./adapters/dialogue-adapter.js";
import { PlayerCharacterMapAdapter } from "./adapters/player-character-map-adapter.js";
import { loadOrCreateSalt } from "./salt.js";
import { runSecretsCli } from "./secrets_cli.js";
import { EnvKeySource } from "./secret_store.js";
import { createPiiCrypto } from "./column_crypto.js";
import { encryptPiiColumns } from "./pii_migrate.js";

const USAGE = `\
skeinkeeper — local operator CLI

Usage:
  skeinkeeper player:export   --tenant <id> --subject <discord-id>  [--out <dir>]
  skeinkeeper player:delete   --tenant <id> --subject <discord-id>  [--yes]
  skeinkeeper campaign:export --tenant <id> --campaign <id>          [--out <dir>]
  skeinkeeper campaign:delete --tenant <id> --campaign <id>          [--yes]
  skeinkeeper tenant:delete   --tenant <id>                          [--yes]

  skeinkeeper secrets:seal                          seal .env secrets to a sealed file
  skeinkeeper secrets:status                        list sealed key names (no values)
  skeinkeeper secrets:rotate  --new-passphrase <p>  re-seal under a new passphrase
  skeinkeeper secrets:unseal  [--remove]            print sealed values; --remove deletes the file

  skeinkeeper pii:encrypt                           encrypt PII columns at rest (needs the passphrase)

Defaults:
  --tenant  default
  --out     ./exports
`;

interface CliEnv {
  /** Path to the SQLite file. Defaults to ./data/skeinkeeper.db. */
  dbPath?: string;
  /** Path to the salt file. Defaults to ./data/.salt. */
  saltPath?: string;
}

export interface CliOptions {
  /** Deletion adapters from packages the `server` package can't import without
   *  a cycle (e.g. the LanceDB MemoryAdapter in `memory-lance`). The CLI
   *  composition root (scripts/skeinkeeper.mjs) builds and injects them so
   *  campaign/tenant erasure also clears the vector store. */
  extraDeletionAdapters?: ReadonlyArray<DeletionAdapter>;
}

export async function runCli(
  argv: ReadonlyArray<string>,
  env: CliEnv = {},
  opts: CliOptions = {},
): Promise<number> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    stdout.write(USAGE);
    return command ? 0 : 1;
  }

  // secrets:* manage the sealed credential store (design doc 0029) — no DB needed,
  // and their own flags (--new-passphrase/--remove) must not hit the erasure parser.
  if (command.startsWith("secrets:")) {
    const r = runSecretsCli(argv, process.env);
    stdout.write(r.output);
    return r.code;
  }

  // pii:encrypt migrates PII columns to ciphertext at rest (design doc 0030).
  // Encryption is gated on the passphrase, so refuse without it (fail closed).
  if (command === "pii:encrypt") {
    const keySource = new EnvKeySource(process.env);
    if (keySource.getPassphrase() === undefined) {
      stdout.write(
        "pii:encrypt needs SKEINKEEPER_SECRET_PASSPHRASE set — encryption at rest is gated on it.\n" +
          "Set the passphrase (the same one used for secrets:seal) and re-run.\n",
      );
      return 2;
    }
    const dbPath = env.dbPath ?? process.env.SKEINKEEPER_DB_PATH ?? "./data/skeinkeeper.db";
    const saltPath = env.saltPath ?? process.env.SKEINKEEPER_SALT_PATH ?? "./data/.salt";
    const db = openDb({ path: dbPath, runMigrations: true });
    try {
      const crypto = createPiiCrypto({ keySource, salt: loadOrCreateSalt(saltPath) });
      const r = encryptPiiColumns(db, crypto);
      const total = r.consents + r.playerCharacterMap + r.dialogue + r.settings + r.auditLog;
      stdout.write(
        `Encrypted PII columns — ${total} row(s) migrated:\n` +
          `  consents: ${r.consents}\n` +
          `  player_character_map: ${r.playerCharacterMap}\n` +
          `  dialogue: ${r.dialogue}\n` +
          `  settings: ${r.settings}\n` +
          `  audit_log: ${r.auditLog}\n`,
      );
      return 0;
    } finally {
      db.close();
    }
  }

  const { values } = parseArgs({
    args: [...argv.slice(1)],
    options: {
      tenant: { type: "string", default: "default" },
      subject: { type: "string" },
      campaign: { type: "string" },
      out: { type: "string", default: "./exports" },
      yes: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const dbPath = env.dbPath ?? process.env.SKEINKEEPER_DB_PATH ?? "./data/skeinkeeper.db";
  const saltPath = env.saltPath ?? process.env.SKEINKEEPER_SALT_PATH ?? "./data/.salt";

  const db = openDb({ path: dbPath, runMigrations: true });
  try {
    const salt = loadOrCreateSalt(saltPath);
    const erasure = new ErasureService({ db, salt });
    const exporter = new ExportService();

    // Register every adapter so each erasure/export scope is fully handled.
    // (Previously only consents was wired, so campaign:delete and audit-log
    // erasure silently no-op'd — fixed here alongside the new dialogue store.)
    const consentsAdapter = new ConsentsAdapter(db);
    const campaignAdapter = new CampaignAdapter(db);
    const auditLogAdapter = new AuditLogAdapter(db);
    const dialogueAdapter = new DialogueAdapter(db);
    const pcMapAdapter = new PlayerCharacterMapAdapter(db);
    for (const a of [
      consentsAdapter,
      campaignAdapter,
      auditLogAdapter,
      dialogueAdapter,
      pcMapAdapter,
    ]) {
      erasure.register(a);
    }
    // Injected adapters from packages `server` can't import (cycle): e.g. the
    // LanceDB MemoryAdapter, so campaign/tenant deletion clears episodic memory.
    for (const a of opts.extraDeletionAdapters ?? []) {
      erasure.register(a);
    }
    // Only adapters that implement ExportAdapter are registered for export.
    exporter.register(consentsAdapter);
    exporter.register(dialogueAdapter);
    exporter.register(pcMapAdapter);

    const scope = scopeFromArgs(command, values);
    if (!scope) {
      stdout.write(`Error: invalid arguments for "${command}"\n\n${USAGE}`);
      return 2;
    }

    if (command.endsWith(":export")) {
      const bundle = await exporter.export(scope);
      if (Object.keys(bundle.perAdapter).length === 0) {
        stdout.write(
          `Warning: no export adapter covers ${scope.kind} scope — the bundle will be empty.\n`,
        );
      }
      const outDir = values.out ?? "./exports";
      mkdirSync(outDir, { recursive: true });
      const label =
        scope.kind === "player"
          ? `player-${sanitize(scope.subjectId)}`
          : scope.kind === "campaign"
            ? `campaign-${sanitize(scope.campaignId)}`
            : `tenant-${sanitize(scope.tenantId)}`;
      const jsonPath = join(outDir, `${label}.export.json`);
      const htmlPath = join(outDir, `${label}.export.html`);
      writeFileSync(jsonPath, JSON.stringify(bundle, null, 2));
      writeFileSync(htmlPath, exporter.renderHtml(bundle));
      stdout.write(`Wrote ${jsonPath}\nWrote ${htmlPath}\n`);
      return 0;
    }

    if (command.endsWith(":delete")) {
      if (!values.yes) {
        const confirmed = await confirm(
          `Delete ${describeScope(scope)}? This cannot be undone. [y/N] `,
        );
        if (!confirmed) {
          stdout.write("Aborted.\n");
          return 1;
        }
      }
      const report = await erasure.erase(scope);
      stdout.write(
        `Deleted ${report.totalRecords} record(s) across ${report.perAdapter.length} adapter(s).\n`,
      );
      for (const r of report.perAdapter) {
        stdout.write(
          `  ${r.adapter}: ${r.error !== undefined ? `FAILED — ${r.error}` : r.recordsDeleted}\n`,
        );
      }
      if (report.failures > 0) {
        stdout.write(
          `\n${report.failures} adapter(s) failed; data may be partially erased. Re-run after investigating.\n`,
        );
        return 1;
      }
      return 0;
    }

    stdout.write(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  } finally {
    db.close();
  }
}

function scopeFromArgs(command: string, values: Record<string, unknown>): ErasureScope | null {
  const tenantId = String(values.tenant ?? "default");
  if (command.startsWith("player:") && typeof values.subject === "string") {
    return { kind: "player", tenantId, subjectId: values.subject };
  }
  if (command.startsWith("campaign:") && typeof values.campaign === "string") {
    return { kind: "campaign", tenantId, campaignId: values.campaign };
  }
  if (command.startsWith("tenant:")) {
    return { kind: "tenant", tenantId };
  }
  return null;
}

function describeScope(scope: ErasureScope): string {
  if (scope.kind === "player") return `player ${scope.subjectId} (tenant ${scope.tenantId})`;
  if (scope.kind === "campaign") return `campaign ${scope.campaignId} (tenant ${scope.tenantId})`;
  return `ALL data for tenant ${scope.tenantId}`;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const ans = await rl.question(prompt);
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}
