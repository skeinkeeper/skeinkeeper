// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { ErasureService, type DeletionAdapter, type ErasureScope } from "./erasure.js";
import { ExportService } from "./export.js";
import { ConsentsAdapter } from "./adapters/consents-adapter.js";
import { consents, deletionLog } from "./schema/index.js";
import { eq } from "drizzle-orm";
import { createPiiCrypto } from "./column_crypto.js";

const PII_SALT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const enabledCrypto = () =>
  createPiiCrypto({ keySource: { getPassphrase: () => "pw" }, salt: PII_SALT });

function setup() {
  const db = openDb({ path: ":memory:", runMigrations: true });
  const erasure = new ErasureService({ db, salt: "test-salt-32-chars-aaaaaaaaaaaaaa" });
  const exporter = new ExportService();
  const adapter = new ConsentsAdapter(db);
  erasure.register(adapter);
  exporter.register(adapter);
  return { db, erasure, exporter };
}

describe("ErasureService + ConsentsAdapter", () => {
  it("erases per-player consent rows and writes a deletion_log entry", async () => {
    const { db, erasure } = setup();
    const now = Date.now();
    db.insert(consents)
      .values([
        {
          tenantId: "default",
          subjectId: "discord:111",
          purpose: "voice_processing",
          consentTextVersion: "v1",
          action: "granted",
          timestamp: now,
        },
        {
          tenantId: "default",
          subjectId: "discord:111",
          purpose: "voice_processing",
          consentTextVersion: "v1",
          action: "withdrawn",
          timestamp: now + 1,
        },
        {
          tenantId: "default",
          subjectId: "discord:222",
          purpose: "voice_processing",
          consentTextVersion: "v1",
          action: "granted",
          timestamp: now,
        },
      ])
      .run();

    const report = await erasure.erase({
      kind: "player",
      tenantId: "default",
      subjectId: "discord:111",
    });

    expect(report.totalRecords).toBe(2);
    expect(report.perAdapter).toEqual([{ adapter: "consents", recordsDeleted: 2 }]);

    const remaining = db.select().from(consents).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.subjectId).toBe("discord:222");

    const logs = db.select().from(deletionLog).all();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.scope).toBe("player");
    expect(logs[0]?.adapterName).toBe("consents");
    expect(logs[0]?.recordsDeleted).toBe(2);
    expect(logs[0]?.subjectIdHash).toHaveLength(64); // hex SHA-256
    expect(logs[0]?.subjectIdHash).not.toContain("discord:111"); // no leak
  });

  it("erases all rows for a tenant on tenant scope", async () => {
    const { db, erasure } = setup();
    db.insert(consents)
      .values([
        {
          tenantId: "default",
          subjectId: "discord:111",
          purpose: "voice_processing",
          consentTextVersion: "v1",
          action: "granted",
          timestamp: Date.now(),
        },
        {
          tenantId: "other",
          subjectId: "discord:222",
          purpose: "voice_processing",
          consentTextVersion: "v1",
          action: "granted",
          timestamp: Date.now(),
        },
      ])
      .run();

    const report = await erasure.erase({ kind: "tenant", tenantId: "default" });
    expect(report.totalRecords).toBe(1);
    const remaining = db.select().from(consents).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.tenantId).toBe("other");
  });

  it("skips campaign scope on adapters that don't support it", async () => {
    const { db, erasure } = setup();
    db.insert(consents)
      .values({
        tenantId: "default",
        subjectId: "discord:111",
        purpose: "voice_processing",
        consentTextVersion: "v1",
        action: "granted",
        timestamp: Date.now(),
      })
      .run();

    const report = await erasure.erase({
      kind: "campaign",
      tenantId: "default",
      campaignId: "phandelver",
    });
    expect(report.perAdapter).toHaveLength(0);
    expect(db.select().from(consents).all()).toHaveLength(1);
  });
});

describe("ConsentsAdapter — encrypted rows (TDD 0030)", () => {
  it("erases an AEAD-encrypted consent row by its hash companion", async () => {
    const db = openDb({ path: ":memory:", runMigrations: true });
    const c = enabledCrypto();
    db.insert(consents)
      .values({
        tenantId: "default",
        subjectId: c.enc("discord:111"),
        subjectIdHash: c.hash("discord:111"),
        purpose: "voice_processing",
        consentTextVersion: "v1",
        action: "granted",
        timestamp: Date.now(),
      })
      .run();
    const deleted = await new ConsentsAdapter(db, c).delete({
      kind: "player",
      tenantId: "default",
      subjectId: "discord:111",
    });
    expect(deleted).toEqual({ recordsDeleted: 1 });
    expect(db.select().from(consents).all()).toHaveLength(0);
  });

  it("decrypts the subject id when exporting an encrypted row", async () => {
    const db = openDb({ path: ":memory:", runMigrations: true });
    const c = enabledCrypto();
    db.insert(consents)
      .values({
        tenantId: "default",
        subjectId: c.enc("discord:111"),
        subjectIdHash: c.hash("discord:111"),
        purpose: "voice_processing",
        consentTextVersion: "v1",
        action: "granted",
        timestamp: Date.now(),
      })
      .run();
    const payload = await new ConsentsAdapter(db, c).export({
      kind: "player",
      tenantId: "default",
      subjectId: "discord:111",
    });
    const rows = payload.data as Array<{ subjectId: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subjectId).toBe("discord:111");
  });
});

describe("ExportService + ConsentsAdapter", () => {
  it("exports player consent rows with a summary", async () => {
    const { db, exporter } = setup();
    db.insert(consents)
      .values({
        tenantId: "default",
        subjectId: "discord:111",
        purpose: "voice_processing",
        consentTextVersion: "v1",
        action: "granted",
        timestamp: Date.now(),
      })
      .run();

    const bundle = await exporter.export({
      kind: "player",
      tenantId: "default",
      subjectId: "discord:111",
    });
    expect(bundle.summary).toEqual([{ adapter: "consents", lines: ["1 consent record(s)"] }]);
    const consentsData = bundle.perAdapter["consents"];
    expect(Array.isArray(consentsData)).toBe(true);
    expect((consentsData as unknown[]).length).toBe(1);
  });

  it("renders HTML that contains the subject and embedded JSON", async () => {
    const { db, exporter } = setup();
    db.insert(consents)
      .values({
        tenantId: "default",
        subjectId: "discord:hi",
        purpose: "voice_processing",
        consentTextVersion: "v1",
        action: "granted",
        timestamp: Date.now(),
      })
      .run();

    const bundle = await exporter.export({
      kind: "player",
      tenantId: "default",
      subjectId: "discord:hi",
    });
    const html = exporter.renderHtml(bundle);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Player discord:hi");
    expect(html).toContain("discord:hi"); // subject id appears in the JSON section too
  });
});

class FakeAdapter implements DeletionAdapter {
  readonly calls: Array<ErasureScope["kind"]> = [];
  constructor(
    readonly name: string,
    readonly supportedScopes: ReadonlyArray<ErasureScope["kind"]>,
    private readonly count = 1,
    private readonly throwOn?: ErasureScope["kind"],
  ) {}
  async delete(scope: ErasureScope): Promise<{ recordsDeleted: number }> {
    this.calls.push(scope.kind);
    if (this.throwOn === scope.kind) throw new Error(`${this.name} boom`);
    return { recordsDeleted: this.count };
  }
}

describe("ErasureService — multi-adapter fan-out", () => {
  it("runs only the adapters that support the scope and logs one row each", async () => {
    const db = openDb({ path: ":memory:", runMigrations: true });
    const erasure = new ErasureService({ db, salt: "test-salt-32-chars-aaaaaaaaaaaaaa" });
    const playerOnly = new FakeAdapter("player-only", ["player"], 3);
    const everywhere = new FakeAdapter("everywhere", ["player", "campaign", "tenant"], 2);
    const tenantOnly = new FakeAdapter("tenant-only", ["tenant"], 5);
    for (const a of [playerOnly, everywhere, tenantOnly]) erasure.register(a);

    const report = await erasure.erase({ kind: "campaign", tenantId: "default", campaignId: "c1" });

    // Only "everywhere" supports campaign scope.
    expect(playerOnly.calls).toEqual([]);
    expect(tenantOnly.calls).toEqual([]);
    expect(everywhere.calls).toEqual(["campaign"]);
    expect(report.totalRecords).toBe(2);
    expect(report.failures).toBe(0);
    expect(report.perAdapter).toEqual([{ adapter: "everywhere", recordsDeleted: 2 }]);
    // One deletion_log row per applicable adapter that ran.
    expect(db.select().from(deletionLog).all()).toHaveLength(1);
  });

  it("continues past a failing adapter, records the error, and counts failures", async () => {
    const db = openDb({ path: ":memory:", runMigrations: true });
    const erasure = new ErasureService({ db, salt: "test-salt-32-chars-aaaaaaaaaaaaaa" });
    const ok1 = new FakeAdapter("ok1", ["tenant"], 4);
    const boom = new FakeAdapter("boom", ["tenant"], 0, "tenant");
    const ok2 = new FakeAdapter("ok2", ["tenant"], 1);
    for (const a of [ok1, boom, ok2]) erasure.register(a);

    const report = await erasure.erase({ kind: "tenant", tenantId: "default" });

    // All three were attempted; the failure didn't abort the rest.
    expect(ok1.calls).toEqual(["tenant"]);
    expect(boom.calls).toEqual(["tenant"]);
    expect(ok2.calls).toEqual(["tenant"]);
    expect(report.failures).toBe(1);
    expect(report.totalRecords).toBe(5); // 4 + 1; the failed adapter contributes 0
    const failed = report.perAdapter.find((p) => p.adapter === "boom");
    expect(failed?.error).toContain("boom");
    expect(failed?.recordsDeleted).toBe(0);
    // No deletion_log row for the failed adapter; one each for the successes.
    const logs = db.select().from(deletionLog).all();
    expect(logs.map((l) => l.adapterName).sort()).toEqual(["ok1", "ok2"]);
  });
});

describe("integration: populate, export, delete, verify", () => {
  it("round-trips a fake player through the full lifecycle", async () => {
    const { db, erasure, exporter } = setup();

    db.insert(consents)
      .values({
        tenantId: "default",
        subjectId: "discord:999",
        purpose: "voice_processing",
        consentTextVersion: "v1",
        action: "granted",
        timestamp: Date.now(),
      })
      .run();
    expect(db.select().from(consents).all()).toHaveLength(1);

    const bundle = await exporter.export({
      kind: "player",
      tenantId: "default",
      subjectId: "discord:999",
    });
    expect((bundle.perAdapter["consents"] as unknown[]).length).toBe(1);

    const report = await erasure.erase({
      kind: "player",
      tenantId: "default",
      subjectId: "discord:999",
    });
    expect(report.totalRecords).toBe(1);

    expect(
      db.select().from(consents).where(eq(consents.subjectId, "discord:999")).all(),
    ).toHaveLength(0);

    const logs = db.select().from(deletionLog).all();
    expect(logs).toHaveLength(1);
  });
});
