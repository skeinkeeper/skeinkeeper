// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { ErasureService } from "./erasure.js";
import { ExportService } from "./export.js";
import { ConsentsAdapter } from "./adapters/consents-adapter.js";
import { consents, deletionLog } from "./schema/index.js";
import { eq } from "drizzle-orm";

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
      db
        .select()
        .from(consents)
        .where(eq(consents.subjectId, "discord:999"))
        .all(),
    ).toHaveLength(0);

    const logs = db.select().from(deletionLog).all();
    expect(logs).toHaveLength(1);
  });
});
