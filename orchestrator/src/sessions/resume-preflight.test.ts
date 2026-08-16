// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { MockFoundryClient } from "../foundry/mock.js";
import { runResumePreflight } from "./resume-preflight.js";

function makeTenantDb(): TenantDb {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(schema.tenants).values({ id: "default", name: "T", createdAt: Date.now() }).run();
  return new TenantDb(db, "default");
}

const CTX = { campaignId: "c1", sessionId: "sess-1", sessionConfig: {} };

describe("runResumePreflight", () => {
  it("returns critical-gaps when listUsers still fails (Foundry not back)", async () => {
    const foundry = new MockFoundryClient({ system: "dnd5e" });
    foundry.listUsers = async () => {
      throw new Error("fake-gateway-timeout");
    };
    const outcome = await runResumePreflight({ foundry, tenantDb: makeTenantDb(), ctx: CTX });
    expect(outcome.status).toBe("critical-gaps");
    expect(outcome.criticalCount).toBe(1);
    expect(outcome.findings).toEqual([{ kind: "bridge-listusers-unavailable" }]);
  });

  it("delegates to the identity pre-flight verifier when Foundry answers", async () => {
    const foundry = new MockFoundryClient({ system: "dnd5e" });
    foundry.seedUsers([
      { id: "fake-gm", name: "fake-gm", role: "GAMEMASTER", isActive: true, ownedActorIds: [] },
    ]);
    const outcome = await runResumePreflight({
      foundry,
      tenantDb: makeTenantDb(),
      ctx: { ...CTX, dmFoundryUserId: "fake-gm" },
    });
    // No expected players and no identity map: verifier reports only the
    // unmapped-extra-user info finding → warnings-only, resume may proceed.
    expect(outcome.status).not.toBe("critical-gaps");
    expect(outcome.criticalCount).toBe(0);
  });

  it("reports critical findings from the verifier with a count", async () => {
    const foundry = new MockFoundryClient({ system: "dnd5e" });
    foundry.seedUsers([]);
    const outcome = await runResumePreflight({
      foundry,
      tenantDb: makeTenantDb(),
      // No DM Foundry user designated → a critical finding.
      ctx: CTX,
      expectedPlayers: [{ discordUserId: "fake-player-1" }],
    });
    expect(outcome.status).toBe("critical-gaps");
    expect(outcome.criticalCount).toBeGreaterThanOrEqual(1);
  });
});
