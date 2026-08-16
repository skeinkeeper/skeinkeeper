// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { FoundryGateway, FoundryGatewayError } from "./foundry_gateway.js";
import { ModuleFoundryClient } from "./module_foundry_client.js";

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

async function listen(opts: {
  bind?: "loopback" | "lan";
  secret?: string;
  tls?: { cert: string; key: string };
}): Promise<FoundryGateway> {
  const g = new FoundryGateway({
    bind: opts.bind ?? "loopback",
    port: 0,
    pairingSecret: opts.secret ?? "s3cret",
    ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
    requestTimeoutMs: 200,
  });
  gateways.push(g);
  await g.listen();
  return g;
}

function connectClient(g: FoundryGateway): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${g.port}`);
  sockets.push(ws);
  return ws;
}

function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function onceMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no message")), 1000);
    ws.once("message", (raw) => {
      clearTimeout(t);
      resolve(JSON.parse(String(raw)) as Record<string, unknown>);
    });
  });
}

describe("FoundryGateway hello", () => {
  it("accepts v13 hello on loopback and returns hello-ok", async () => {
    const g = await listen({});
    const ws = connectClient(g);
    await onceOpen(ws);
    const helloP = g.waitForHello(1000);
    ws.send(
      JSON.stringify({
        type: "hello",
        moduleId: "skeinkeeper",
        foundryVersion: "13.345",
        worldId: "w1",
        pairingSecret: "s3cret",
      }),
    );
    const reply = await onceMessage(ws);
    expect(reply).toEqual({ type: "hello-ok", protocol: 1 });
    const hello = await helloP;
    expect(hello.foundryVersion).toBe("13.345");
    expect(hello.worldId).toBe("w1");
  });

  it("rejects foundryVersion 12 with hello-reject code=version", async () => {
    const g = await listen({});
    const ws = connectClient(g);
    await onceOpen(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        moduleId: "skeinkeeper",
        foundryVersion: "12.331",
        worldId: "w1",
      }),
    );
    const reply = await onceMessage(ws);
    expect(reply["type"]).toBe("hello-reject");
    expect(reply["code"]).toBe("version");
    await expect(g.waitForHello(200)).rejects.toBeInstanceOf(FoundryGatewayError);
  });

  it("rejects a second GM hello as duplicate", async () => {
    const g = await listen({});
    const a = connectClient(g);
    await onceOpen(a);
    a.send(
      JSON.stringify({
        type: "hello",
        moduleId: "skeinkeeper",
        foundryVersion: "14.1",
        worldId: "w1",
        pairingSecret: "s3cret",
      }),
    );
    await onceMessage(a);
    await g.waitForHello(500);

    const b = connectClient(g);
    await onceOpen(b);
    b.send(
      JSON.stringify({
        type: "hello",
        moduleId: "skeinkeeper",
        foundryVersion: "14.1",
        worldId: "w1",
        pairingSecret: "s3cret",
      }),
    );
    const reply = await onceMessage(b);
    expect(reply["code"]).toBe("duplicate");
    expect(g.session?.worldId).toBe("w1");
  });

  it("rejects a loopback hello that omits the configured pairing secret", async () => {
    // A WebSocket ignores same-origin policy, so a page the operator visits can
    // dial the loopback gateway. When a secret is configured it must be presented
    // even from loopback, or the connection is unauthorized (security A1).
    const g = await listen({ secret: "s3cret" });
    const ws = connectClient(g);
    await onceOpen(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        moduleId: "skeinkeeper",
        foundryVersion: "13.345",
        worldId: "w1",
        // no pairingSecret
      }),
    );
    const reply = await onceMessage(ws);
    expect(reply["type"]).toBe("hello-reject");
    expect(reply["code"]).toBe("unauthorized");
    await expect(g.waitForHello(200)).rejects.toBeInstanceOf(FoundryGatewayError);
  });

  it("rejects a loopback hello with the wrong pairing secret", async () => {
    const g = await listen({ secret: "s3cret" });
    const ws = connectClient(g);
    await onceOpen(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        moduleId: "skeinkeeper",
        foundryVersion: "13.345",
        worldId: "w1",
        pairingSecret: "wrong",
      }),
    );
    const reply = await onceMessage(ws);
    expect(reply["code"]).toBe("unauthorized");
  });

  it("admits a loopback hello with no secret only when none is configured (dev)", async () => {
    const g = await listen({ secret: "" });
    const ws = connectClient(g);
    await onceOpen(ws);
    const helloP = g.waitForHello(1000);
    ws.send(
      JSON.stringify({
        type: "hello",
        moduleId: "skeinkeeper",
        foundryVersion: "13.345",
        worldId: "w1",
      }),
    );
    const reply = await onceMessage(ws);
    expect(reply).toEqual({ type: "hello-ok", protocol: 1 });
    await helloP;
  });

  it("refuses lan bind without TLS", async () => {
    const g = new FoundryGateway({
      bind: "lan",
      port: 0,
      pairingSecret: "s3cret",
    });
    await expect(g.listen()).rejects.toMatchObject({ code: "tls-required" });
  });

  it("ignores unknown JSON without throwing", async () => {
    const g = await listen({});
    const ws = connectClient(g);
    await onceOpen(ws);
    ws.send("not-json");
    ws.send(JSON.stringify({ type: "nope" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(g.unknownJsonCount).toBeGreaterThanOrEqual(2);
  });

  it("ignores evt frames from an unauthenticated socket (never sent hello)", async () => {
    // A malicious page can open the loopback socket without the pairing secret;
    // it must not be able to inject forged player input via an evt chat frame.
    const g = await listen({ secret: "s3cret" });
    const seen: string[] = [];
    g.onChat((e) => seen.push(e.text));
    const ws = connectClient(g);
    await onceOpen(ws);
    ws.send(
      JSON.stringify({
        type: "evt",
        event: "chat",
        payload: { foundryUserId: "u1", text: "forged", isWhisper: false, timestamp: "t0" },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([]);
    expect(g.unknownJsonCount).toBeGreaterThanOrEqual(1);
  });

  it("ignores evt gone from a second unauthenticated socket while a session is live", async () => {
    const g = await listen({ secret: "s3cret" });
    let goneFired = false;
    g.onGone(() => {
      goneFired = true;
    });
    const a = connectClient(g);
    await onceOpen(a);
    const helloP = g.waitForHello(1000);
    a.send(
      JSON.stringify({
        type: "hello",
        moduleId: "skeinkeeper",
        foundryVersion: "13.345",
        worldId: "w1",
        pairingSecret: "s3cret",
      }),
    );
    await onceMessage(a);
    await helloP;
    const b = connectClient(g);
    await onceOpen(b);
    b.send(JSON.stringify({ type: "evt", event: "gone" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(goneFired).toBe(false);
  });
});

describe("ModuleFoundryClient", () => {
  async function handshake(): Promise<{ g: FoundryGateway; ws: WebSocket }> {
    const g = await listen({});
    const ws = connectClient(g);
    await onceOpen(ws);
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      if (msg["type"] !== "req") return;
      const method = msg["method"];
      const id = msg["id"];
      if (method === "getWorldInfo") {
        ws.send(
          JSON.stringify({
            type: "res",
            id,
            ok: true,
            result: { connected: true, system: { id: "dnd5e", name: "D&D 5e" }, modules: [] },
          }),
        );
        return;
      }
      if (method === "postChatMessage") {
        ws.send(JSON.stringify({ type: "res", id, ok: true, result: { messageId: "m1" } }));
        return;
      }
      if (method === "getActiveScene") {
        ws.send(
          JSON.stringify({
            type: "res",
            id,
            ok: true,
            result: { id: "s1", name: "Start", active: true, tokens: [] },
          }),
        );
        return;
      }
      ws.send(JSON.stringify({ type: "res", id, ok: true, result: null }));
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        moduleId: "skeinkeeper",
        foundryVersion: "13.345",
        worldId: "w1",
        pairingSecret: "s3cret",
      }),
    );
    await onceMessage(ws);
    return { g, ws };
  }

  it("connects after hello-ok and maps postChatMessage / getActiveScene", async () => {
    const { g } = await handshake();
    const client = await ModuleFoundryClient.connect(g, 1000);
    expect(client.system).toBe("dnd5e");
    const posted = await client.postChatMessage({ content: "X", mode: "public" });
    expect(posted.messageId).toBe("m1");
    const scene = await client.getActiveScene();
    expect(scene?.name).toBe("Start");
  });

  it("times out a hanging req with error.code = timeout", async () => {
    const g = await listen({});
    const ws = connectClient(g);
    await onceOpen(ws);
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      if (msg["type"] === "req" && msg["method"] === "getWorldInfo") {
        ws.send(
          JSON.stringify({
            type: "res",
            id: msg["id"],
            ok: true,
            result: { connected: true, system: { id: "dnd5e", name: "D&D 5e" }, modules: [] },
          }),
        );
      }
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        moduleId: "skeinkeeper",
        foundryVersion: "13.345",
        worldId: "w1",
        pairingSecret: "s3cret",
      }),
    );
    await onceMessage(ws);
    const client = await ModuleFoundryClient.connect(g, 1000);
    await expect(client.listUsers()).rejects.toMatchObject({ code: "timeout" });
  });

  it("forwards evt chat and drops nothing after unsubscribe", async () => {
    const { g, ws } = await handshake();
    const client = await ModuleFoundryClient.connect(g, 1000);
    const seen: string[] = [];
    const unsub = client.subscribeChatEvents((e) => seen.push(e.text));
    ws.send(
      JSON.stringify({
        type: "evt",
        event: "chat",
        payload: {
          foundryUserId: "u1",
          text: "I search the room",
          isWhisper: false,
          timestamp: "t0",
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    unsub();
    ws.send(
      JSON.stringify({
        type: "evt",
        event: "chat",
        payload: { foundryUserId: "u1", text: "ignored", isWhisper: false, timestamp: "t1" },
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual(["I search the room"]);
  });
});
