// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { ConsentService } from "./consent.js";

function service(): ConsentService {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(schema.tenants).values({ id: "default", name: "T", createdAt: Date.now() }).run();
  return new ConsentService(new TenantDb(db, "default"));
}

describe("ConsentService", () => {
  it("starts ungranted and needing a prompt", () => {
    const c = service();
    expect(c.isGranted("discord:1")).toBe(false);
    expect(c.needsPrompt("discord:1")).toBe(true);
  });

  it("grants and then gates audio on", () => {
    const c = service();
    c.grant("discord:1", 1000);
    expect(c.isGranted("discord:1")).toBe(true);
    expect(c.needsPrompt("discord:1")).toBe(false);
  });

  it("withdrawal takes effect (most recent wins) and re-requires a prompt", () => {
    const c = service();
    c.grant("discord:1", 1000);
    c.withdraw("discord:1", 2000);
    expect(c.isGranted("discord:1")).toBe(false);
    expect(c.needsPrompt("discord:1")).toBe(true);
  });

  it("scopes consent per speaker", () => {
    const c = service();
    c.grant("discord:1");
    expect(c.isGranted("discord:1")).toBe(true);
    expect(c.isGranted("discord:2")).toBe(false);
  });
});
