// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { FoundryGateway, FoundryGatewayError, type GatewayBind } from "./foundry_gateway.js";

const gateways: FoundryGateway[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  sockets.length = 0;
  for (const g of gateways) {
    await g.close();
  }
  gateways.length = 0;
});

function gateway(opts: {
  bind: GatewayBind;
  port?: number;
  secret?: string;
  tls?: { cert: string; key: string };
}): FoundryGateway {
  const g = new FoundryGateway({
    bind: opts.bind,
    port: opts.port ?? 7733,
    pairingSecret: opts.secret ?? "s3cret",
    ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
  });
  gateways.push(g);
  return g;
}

describe("gateway bind host (TDD 0043)", () => {
  it("binds loopback only in loopback mode", () => {
    expect(gateway({ bind: "loopback" }).bindHost).toBe("127.0.0.1");
  });

  it("binds every interface in container mode", () => {
    // Inside a container that is the container's own network namespace, reached
    // from the host through the compose file's loopback-scoped publish mapping.
    expect(gateway({ bind: "container" }).bindHost).toBe("0.0.0.0");
  });

  it("binds every interface in lan mode", () => {
    expect(gateway({ bind: "lan" }).bindHost).toBe("0.0.0.0");
  });
});

describe("advertised add-on URL (TDD 0043)", () => {
  it("advertises loopback in loopback mode", () => {
    expect(gateway({ bind: "loopback" }).listenUrl).toBe("ws://127.0.0.1:7733");
  });

  it("advertises the host publish mapping — never 0.0.0.0 — in container mode", () => {
    // The GM's browser dials this; 0.0.0.0 is not a dialable address.
    const url = gateway({ bind: "container" }).listenUrl;
    expect(url).toBe("ws://127.0.0.1:7733");
    expect(url).not.toContain("0.0.0.0");
  });

  it("advertises the wildcard in lan mode, and wss when TLS is configured", () => {
    expect(gateway({ bind: "lan" }).listenUrl).toBe("ws://0.0.0.0:7733");
    const tls = gateway({ bind: "lan", tls: { cert: "fake-cert", key: "fake-key" } });
    expect(tls.listenUrl).toBe("wss://0.0.0.0:7733");
  });
});

describe("per-mode listen validation (TDD 0043)", () => {
  it("actually listens in container mode and accepts a loopback peer", async () => {
    const g = gateway({ bind: "container", port: 0 });
    await g.listen();
    expect(g.port).toBeGreaterThan(0);
    const ws = new WebSocket(`ws://127.0.0.1:${g.port}`);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
  });

  it("refuses container mode without a pairing secret", async () => {
    // The namespace edge is not the credential — the pairing secret is
    // (foundry_gateway.ts hello authorization). A blank one would fall back to
    // "any loopback peer", and inside a container every sibling arrives as one.
    const g = gateway({ bind: "container", port: 0, secret: "   " });
    await expect(g.listen()).rejects.toBeInstanceOf(FoundryGatewayError);
  });

  it("still refuses lan mode without TLS", async () => {
    const g = gateway({ bind: "lan", port: 0 });
    await expect(g.listen()).rejects.toBeInstanceOf(FoundryGatewayError);
  });
});
