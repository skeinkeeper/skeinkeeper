// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import { seedFromFile } from "./seed.js";
import { tenants, campaigns, clocks } from "./schema/index.js";

describe("seedFromFile", () => {
  it("inserts tenant, campaign, and clocks; is idempotent on re-run", () => {
    const db = openDb({ path: ":memory:", runMigrations: true });
    const dir = mkdtempSync(join(tmpdir(), "seedtest-"));
    const path = join(dir, "seed.yaml");
    writeFileSync(
      path,
      `tenant: { id: default, name: "Test Group" }
campaigns:
  - id: phandelver
    name: "Lost Mine of Phandelver"
    rulesetId: dnd5e
    behaviorSpecVersion: v0.1
    foundryWorldName: phandelver
    clocks:
      - id: clk-redbrands
        name: "Faction: Redbrands"
        category: faction
        segmentsTotal: 6
        segmentsFilled: 1
`,
    );
    expect(seedFromFile(db, path).inserted).toBe(3);
    expect(seedFromFile(db, path).inserted).toBe(0); // idempotent

    expect(db.select().from(tenants).all()).toHaveLength(1);
    expect(db.select().from(campaigns).all()).toHaveLength(1);
    const clkRows = db.select().from(clocks).all();
    expect(clkRows).toHaveLength(1);
    expect(clkRows[0]?.segmentsFilled).toBe(1);
  });

  it("returns 0 when seed file is absent", () => {
    const db = openDb({ path: ":memory:", runMigrations: true });
    expect(seedFromFile(db, "/nonexistent.yaml").inserted).toBe(0);
  });
});
