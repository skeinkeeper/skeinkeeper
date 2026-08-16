// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it, vi } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { ToolDispatcher } from "../registry.js";
import { FakeOutboundSurface, SurfaceRouter } from "../surfaces/index.js";
import { createDefaultRegistry } from "./index.js";

function bootstrap() {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(schema.tenants).values({ id: "default", name: "Test", createdAt: Date.now() }).run();
  const tenantDb = new TenantDb(db, "default");
  return { tenantDb, dispatcher: new ToolDispatcher({ registry: createDefaultRegistry() }) };
}

describe("notify_operator — Foundry GM routing (TDD 0036)", () => {
  it("emits gm-audience text with meta.escalation via the surface router", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const gm = new FakeOutboundSurface("foundry-gm", ["gm"]);
    const router = new SurfaceRouter();
    router.register(gm);
    const track = vi.fn();
    const r = await dispatcher.dispatch(
      { name: "notify_operator", input: { message: "Couldn't match Sam.", severity: "warning" } },
      {
        tenantDb,
        sessionId: "s",
        turnId: "t",
        caller: "llm",
        surfaces: router,
        analytics: { track, flush: async () => undefined },
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.output as { delivered: boolean }).delivered).toBe(true);
    expect(gm.emits).toEqual([
      {
        audience: { kind: "gm" },
        text: "Couldn't match Sam.",
        meta: { escalation: true, severity: "warning" },
      },
    ]);
    expect(track).toHaveBeenCalledWith("escalation.notify-operator", { severity: "warning" });
  });

  it("still delivers via ctx.notifyOperator when no router is wired", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const sent: string[] = [];
    const r = await dispatcher.dispatch(
      { name: "notify_operator", input: { message: "gap" } },
      {
        tenantDb,
        sessionId: "s",
        turnId: "t",
        caller: "llm",
        notifyOperator: async (m) => {
          sent.push(m);
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(sent).toEqual(["gap"]);
  });

  it("emits an operatorEscalation callback when no operator Foundry user is known", async () => {
    const { tenantDb, dispatcher } = bootstrap();
    const gm = new FakeOutboundSurface("foundry-gm", ["gm"]);
    const router = new SurfaceRouter();
    router.register(gm);
    const escalations: Array<{ message: string; severity: string }> = [];
    await dispatcher.dispatch(
      { name: "notify_operator", input: { message: "x" } },
      {
        tenantDb,
        sessionId: "s",
        turnId: "t",
        caller: "llm",
        surfaces: router,
        onOperatorEscalation: (e) => escalations.push(e),
      },
    );
    expect(gm.emits).toHaveLength(1);
    expect(escalations).toEqual([{ message: "x", severity: "info" }]);
  });
});
