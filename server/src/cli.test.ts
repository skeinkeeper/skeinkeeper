// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.js";
import { openDb } from "./db.js";
import { consents, tenants } from "./schema/index.js";
import type { DeletionAdapter, ErasureScope } from "./erasure.js";
import type { FoundryChatDeletionClient } from "./adapters/foundry-whisper-deletion.js";

async function withCapturedStdout<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const chunks: string[] = [];
  const orig = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    const value = await fn();
    return { value, out: chunks.join("") };
  } finally {
    process.stdout.write = orig;
  }
}

const dirs: string[] = [];
function tmpEnv(): { dbPath: string; saltPath: string } {
  const d = mkdtempSync(join(tmpdir(), "sk-cli-"));
  dirs.push(d);
  return { dbPath: join(d, "skeinkeeper.db"), saltPath: join(d, ".salt") };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

class RecordingAdapter implements DeletionAdapter {
  readonly name = "recording";
  readonly supportedScopes = ["campaign", "tenant"] as const;
  readonly calls: Array<ErasureScope> = [];
  async delete(scope: ErasureScope): Promise<{ recordsDeleted: number }> {
    this.calls.push(scope);
    return { recordsDeleted: 7 };
  }
}

describe("runCli — injected (extra) deletion adapters", () => {
  it("registers and invokes an injected adapter on campaign:delete", async () => {
    const env = tmpEnv();
    const extra = new RecordingAdapter();
    const code = await runCli(
      ["campaign:delete", "--tenant", "default", "--campaign", "c1", "--yes"],
      env,
      { extraDeletionAdapters: [extra] },
    );
    expect(code).toBe(0);
    expect(extra.calls).toHaveLength(1);
    expect(extra.calls[0]).toEqual({ kind: "campaign", tenantId: "default", campaignId: "c1" });
  });

  it("invokes the injected adapter on tenant:delete too", async () => {
    const env = tmpEnv();
    const extra = new RecordingAdapter();
    const code = await runCli(["tenant:delete", "--tenant", "default", "--yes"], env, {
      extraDeletionAdapters: [extra],
    });
    expect(code).toBe(0);
    expect(extra.calls[0]?.kind).toBe("tenant");
  });

  it("reports a non-zero exit and the error when an adapter fails", async () => {
    const env = tmpEnv();
    const failing: DeletionAdapter = {
      name: "boom",
      supportedScopes: ["tenant"],
      async delete() {
        throw new Error("kaboom");
      },
    };
    const code = await runCli(["tenant:delete", "--tenant", "default", "--yes"], env, {
      extraDeletionAdapters: [failing],
    });
    expect(code).toBe(1);
  });
});

describe("runCli — player:delete partial success (TDD 0038)", () => {
  it("exits 2 and prints WARNING lines when an adapter returns a remainder", async () => {
    const env = tmpEnv();
    const remainder: DeletionAdapter = {
      name: "foundry-whisper",
      supportedScopes: ["player"],
      async delete() {
        return {
          recordsDeleted: 0,
          manualRemainder: {
            reason: "addon-unavailable",
            message: "delete via Foundry GM chat-log UI",
          },
        };
      },
    };
    const { value: code, out } = await withCapturedStdout(() =>
      runCli(["player:delete", "--tenant", "t", "--subject", "d", "--yes"], env, {
        extraDeletionAdapters: [remainder],
        registerFoundryWhisperAdapter: false,
      }),
    );
    expect(code).toBe(2);
    expect(out.split("\n").some((line) => line.startsWith("WARNING:"))).toBe(true);
  });

  it("exits 0 on a clean Foundry cascade", async () => {
    const env = tmpEnv();
    const foundry: FoundryChatDeletionClient & { calls: unknown[] } = {
      calls: [],
      async deleteChatMessages(args) {
        this.calls.push(args);
        return { deletedCount: args.scope === "by-recipient" ? 7 : 3 };
      },
    };
    const { value: code, out } = await withCapturedStdout(() =>
      runCli(["player:delete", "--tenant", "t", "--subject", "d", "--yes"], env, {
        foundry,
        foundryConnected: true,
        identityMap: { currentForPlayer: () => ({ foundryUserId: "u1" }) },
      }),
    );
    expect(code).toBe(0);
    expect(out.split("\n").some((line) => line.startsWith("WARNING:"))).toBe(false);
    expect(foundry.calls).toHaveLength(2);
  });

  it("probes Foundry connection on a standalone player:delete (no session)", async () => {
    const env = tmpEnv();
    let probed = false;
    const { value: code, out } = await withCapturedStdout(() =>
      runCli(["player:delete", "--tenant", "t", "--subject", "d", "--yes"], env, {
        identityMap: { currentForPlayer: () => ({ foundryUserId: "u1" }) },
        probeFoundryConnected: async () => {
          probed = true;
          return false;
        },
        foundry: {
          async deleteChatMessages() {
            throw new Error("must not be called when the probe reports disconnected");
          },
        },
      }),
    );
    expect(probed).toBe(true);
    expect(code).toBe(2);
    expect(out).toMatch(/^WARNING:/m);
    expect(out).toMatch(/addon is not connected|not connected/i);
  });
});

describe("runCli — player:export HTML (TDD 0038)", () => {
  it("writes an HTML summary that names Foundry-side data not exported", async () => {
    const env = tmpEnv();
    const outDir = env.dbPath.replace(/skeinkeeper\.db$/, "exports");
    const { value: code } = await withCapturedStdout(() =>
      runCli(["player:export", "--tenant", "t", "--subject", "d", "--out", outDir], env),
    );
    expect(code).toBe(0);
    const html = readFileSync(join(outDir, "player-d.export.html"), "utf8");
    expect(html).toContain("Foundry-side data not exported");
    expect(html).toMatch(/Foundry's own/i);
  });
});

describe("runCli — pii:encrypt (TDD 0030)", () => {
  function seedPlaintextConsent(dbPath: string): void {
    const db = openDb({ path: dbPath, runMigrations: true });
    db.insert(tenants).values({ id: "default", name: "T", createdAt: 1 }).run();
    db.insert(consents)
      .values({
        tenantId: "default",
        subjectId: "discord:42",
        purpose: "voice_processing",
        consentTextVersion: "v1",
        action: "granted",
        timestamp: 1,
      })
      .run();
    db.close();
  }

  it("refuses without a passphrase (fail closed)", async () => {
    const env = tmpEnv();
    const prev = process.env.SKEINKEEPER_SECRET_PASSPHRASE;
    delete process.env.SKEINKEEPER_SECRET_PASSPHRASE;
    try {
      seedPlaintextConsent(env.dbPath);
      const code = await runCli(["pii:encrypt"], env);
      expect(code).not.toBe(0);
      const db = openDb({ path: env.dbPath });
      expect(db.select().from(consents).get()?.subjectId).toBe("discord:42"); // untouched
      db.close();
    } finally {
      if (prev !== undefined) process.env.SKEINKEEPER_SECRET_PASSPHRASE = prev;
    }
  });

  it("encrypts the PII columns when a passphrase is set", async () => {
    const env = tmpEnv();
    const prev = process.env.SKEINKEEPER_SECRET_PASSPHRASE;
    process.env.SKEINKEEPER_SECRET_PASSPHRASE = "build-test-passphrase";
    try {
      seedPlaintextConsent(env.dbPath);
      const code = await runCli(["pii:encrypt"], env);
      expect(code).toBe(0);
      const db = openDb({ path: env.dbPath });
      const row = db.select().from(consents).get();
      expect(row?.subjectId.startsWith("gcm:")).toBe(true);
      expect(row?.subjectIdHash).toHaveLength(64);
      db.close();
    } finally {
      if (prev === undefined) delete process.env.SKEINKEEPER_SECRET_PASSPHRASE;
      else process.env.SKEINKEEPER_SECRET_PASSPHRASE = prev;
    }
  });
});
