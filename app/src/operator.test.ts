// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import {
  OperatorService,
  operatorActionIsPrivileged,
  resolveOperatorFromMembers,
  type ResolvableMember,
} from "./operator.js";

function setup() {
  const db = openDb({ path: ":memory:", runMigrations: true });
  const now = Date.now();
  db.insert(schema.tenants).values({ id: "default", name: "T", createdAt: now }).run();
  db.insert(schema.campaigns)
    .values({
      id: "c1",
      tenantId: "default",
      name: "C",
      rulesetId: "dnd5e",
      behaviorSpecVersion: "v0.1",
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return new TenantDb(db, "default");
}

describe("OperatorService", () => {
  it("falls back to the env value when nothing is persisted", () => {
    const svc = new OperatorService(setup(), "c1", "env-123");
    expect(svc.get()).toBe("env-123");
    expect(svc.isPersisted()).toBe(false);
  });

  it("prefers a persisted value over the env fallback, and clears back to env", () => {
    const svc = new OperatorService(setup(), "c1", "env-123");
    svc.set("set-456");
    expect(svc.get()).toBe("set-456");
    expect(svc.isPersisted()).toBe(true);
    svc.clear();
    expect(svc.get()).toBe("env-123");
    expect(svc.isPersisted()).toBe(false);
  });

  it("returns undefined when neither persisted nor env is present", () => {
    const svc = new OperatorService(setup(), "c1");
    expect(svc.get()).toBeUndefined();
  });

  it("stores and clears a pending username; set() clears it", () => {
    const svc = new OperatorService(setup(), "c1");
    svc.setPendingUsername("chris");
    expect(svc.getPendingUsername()).toBe("chris");
    svc.set("id-1");
    expect(svc.getPendingUsername()).toBeUndefined();
  });
});

describe("operatorActionIsPrivileged", () => {
  it("gates claim and clear, leaves show / unknown / null open", () => {
    expect(operatorActionIsPrivileged("claim")).toBe(true);
    expect(operatorActionIsPrivileged("clear")).toBe(true);
    expect(operatorActionIsPrivileged("show")).toBe(false);
    expect(operatorActionIsPrivileged("bogus")).toBe(false);
    expect(operatorActionIsPrivileged(null)).toBe(false);
  });
});

describe("resolveOperatorFromMembers", () => {
  const members: ResolvableMember[] = [
    { id: "1", username: "chris", displayName: "Chris C" },
    { id: "2", username: "dana42", displayName: "Dana" },
    { id: "3", username: "samthebard", displayName: "Chris C" }, // duplicate display name
  ];

  it("matches an exact username (case-insensitive, @-stripped)", () => {
    expect(resolveOperatorFromMembers(members, "@Chris")).toEqual({
      kind: "match",
      id: "1",
      displayName: "Chris C",
    });
  });

  it("falls back to a unique display-name match", () => {
    expect(resolveOperatorFromMembers(members, "Dana")).toEqual({
      kind: "match",
      id: "2",
      displayName: "Dana",
    });
  });

  it("reports ambiguity when a display name isn't unique", () => {
    const r = resolveOperatorFromMembers(members, "Chris C");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates.map((c) => c.id)).toEqual(["1", "3"]);
  });

  it("returns not_found for an unknown identifier or blank input", () => {
    expect(resolveOperatorFromMembers(members, "nobody")).toEqual({ kind: "not_found" });
    expect(resolveOperatorFromMembers(members, "   ")).toEqual({ kind: "not_found" });
  });
});
