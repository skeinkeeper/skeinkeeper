// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { FoundryChatEvent } from "@skeinkeeper/orchestrator";

export type GatewayBind = "loopback" | "lan";

export interface FoundryGatewayTls {
  cert: string;
  key: string;
}

export interface FoundryGatewayOptions {
  bind: GatewayBind;
  port: number;
  pairingSecret: string;
  tls?: FoundryGatewayTls;
  requestTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface FoundryHello {
  moduleId: string;
  foundryVersion: string;
  worldId: string;
}

export class FoundryGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FoundryGatewayError";
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * WebSocket listener the first-party Foundry add-on dials (TDD 0041).
 * One live GM session. JSON text frames, protocol 1.
 */
export class FoundryGateway {
  private http: HttpServer | undefined;
  private wss: WebSocketServer | undefined;
  private socket: WebSocket | undefined;
  private hello: FoundryHello | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly chatHandlers = new Set<(event: FoundryChatEvent) => void>();
  private readonly goneHandlers = new Set<() => void>();
  private waiters: Array<(hello: FoundryHello) => void> = [];
  unknownJsonCount = 0;
  readonly pairingSecret: string;

  constructor(private readonly opts: FoundryGatewayOptions) {
    this.pairingSecret = opts.pairingSecret;
  }

  get bindHost(): string {
    return this.opts.bind === "lan" ? "0.0.0.0" : "127.0.0.1";
  }

  get port(): number {
    const addr = this.http?.address();
    if (addr && typeof addr === "object") return addr.port;
    return this.opts.port;
  }

  get listenUrl(): string {
    const scheme = this.opts.tls !== undefined ? "wss" : "ws";
    const host = this.opts.bind === "lan" ? "0.0.0.0" : "127.0.0.1";
    return `${scheme}://${host}:${this.port}`;
  }

  get session(): FoundryHello | undefined {
    return this.hello;
  }

  async listen(): Promise<void> {
    if (this.opts.bind === "lan") {
      if (this.pairingSecret.trim().length === 0) {
        throw new FoundryGatewayError(
          "tls-required",
          "FOUNDRY_GATEWAY_BIND=lan requires a non-empty pairing secret and TLS.",
        );
      }
      if (this.opts.tls === undefined) {
        throw new FoundryGatewayError(
          "tls-required",
          "FOUNDRY_GATEWAY_BIND=lan requires FOUNDRY_GATEWAY_TLS_CERT and FOUNDRY_GATEWAY_TLS_KEY.",
        );
      }
    }

    const tls = this.opts.tls;
    this.http =
      tls !== undefined ? createHttpsServer({ cert: tls.cert, key: tls.key }) : createHttpServer();
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req.socket.remoteAddress ?? ""));

    await new Promise<void>((resolve, reject) => {
      this.http!.once("error", reject);
      this.http!.listen(this.opts.port, this.bindHost, () => resolve());
    });
    this.opts.log?.(`Foundry gateway listening on ${this.listenUrl}`);
  }

  async close(): Promise<void> {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new FoundryGatewayError("closed", "gateway closed"));
    }
    this.pending.clear();
    this.socket?.close();
    this.socket = undefined;
    this.hello = undefined;
    await new Promise<void>((resolve) => {
      this.wss?.close(() => resolve());
      if (this.wss === undefined) resolve();
    });
    await new Promise<void>((resolve) => {
      this.http?.close(() => resolve());
      if (this.http === undefined) resolve();
    });
    this.wss = undefined;
    this.http = undefined;
  }

  waitForHello(timeoutMs = 5000): Promise<FoundryHello> {
    if (this.hello !== undefined) return Promise.resolve(this.hello);
    return new Promise<FoundryHello>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== onHello);
        reject(
          new FoundryGatewayError(
            "timeout",
            "Foundry add-on did not connect within 5s. Enable the Skeinkeeper add-on in your world and point it at this gateway.",
          ),
        );
      }, timeoutMs);
      const onHello = (hello: FoundryHello) => {
        clearTimeout(timer);
        resolve(hello);
      };
      this.waiters.push(onHello);
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const ws = this.socket;
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new FoundryGatewayError("timeout", "Foundry add-on is not connected."));
    }
    const id = randomUUID();
    const timeoutMs = this.opts.requestTimeoutMs ?? 5000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new FoundryGatewayError(
            "timeout",
            `Foundry req ${method} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  onChat(handler: (event: FoundryChatEvent) => void): () => void {
    this.chatHandlers.add(handler);
    return () => {
      this.chatHandlers.delete(handler);
    };
  }

  onGone(handler: () => void): () => void {
    this.goneHandlers.add(handler);
    return () => {
      this.goneHandlers.delete(handler);
    };
  }

  private onConnection(ws: WebSocket, remote: string): void {
    ws.on("message", (raw) => this.onMessage(ws, raw.toString(), remote));
    ws.on("close", () => this.onSocketClose(ws));
  }

  private onSocketClose(ws: WebSocket): void {
    if (this.socket !== ws) return;
    this.socket = undefined;
    this.hello = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new FoundryGatewayError("gone", "Foundry add-on disconnected"));
    }
    this.pending.clear();
    for (const h of this.goneHandlers) h();
  }

  private onMessage(ws: WebSocket, text: string, remote: string): void {
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.unknownJsonCount += 1;
        this.opts.log?.("ignored non-object JSON frame");
        return;
      }
      msg = parsed as Record<string, unknown>;
    } catch {
      this.unknownJsonCount += 1;
      this.opts.log?.("ignored invalid JSON frame");
      return;
    }

    const type = msg["type"];
    if (type === "hello") {
      this.handleHello(ws, msg, remote);
      return;
    }
    if (type === "res") {
      this.handleRes(msg);
      return;
    }
    if (type === "evt") {
      this.handleEvt(msg);
      return;
    }
    this.unknownJsonCount += 1;
    this.opts.log?.(`ignored unknown frame type ${String(type)}`);
  }

  private handleHello(ws: WebSocket, msg: Record<string, unknown>, remote: string): void {
    const version = typeof msg["foundryVersion"] === "string" ? msg["foundryVersion"] : "";
    if (!version.startsWith("13.") && !version.startsWith("14.")) {
      ws.send(
        JSON.stringify({
          type: "hello-reject",
          code: "version",
          message: `Foundry ${version || "(missing)"} is not supported; need v13 or v14.`,
        }),
      );
      ws.close();
      return;
    }

    // Pairing secret is the gateway's authorization. Require it on EVERY
    // connection when one is configured — loopback included. A WebSocket is not
    // bound by the browser same-origin policy, so a page the operator merely
    // visits can open ws://127.0.0.1:<port> and would otherwise impersonate the
    // add-on: read the `req` traffic (whisper text, gm secrets, user lists) and
    // inject `evt chat` frames (fake player input, fake operator commands). The
    // real add-on supplies the secret from its world settings; a web page cannot.
    // Production always has a secret (createFoundrySource generates one), so this
    // closes the vector there. An empty configured secret still admits loopback
    // only, for local dev/tests — an unknown/empty peer address is NOT loopback.
    const secret = typeof msg["pairingSecret"] === "string" ? msg["pairingSecret"] : "";
    const secretConfigured = this.pairingSecret.trim().length > 0;
    const peerIsLoopback = isLoopback(remote);
    const authorized = secretConfigured ? secret === this.pairingSecret : peerIsLoopback;
    if (!authorized) {
      ws.send(
        JSON.stringify({
          type: "hello-reject",
          code: "unauthorized",
          message: secretConfigured
            ? "pairing secret does not match"
            : "gateway requires a loopback peer or a configured pairing secret",
        }),
      );
      ws.close();
      return;
    }

    if (
      this.socket !== undefined &&
      this.socket !== ws &&
      this.socket.readyState === WebSocket.OPEN
    ) {
      ws.send(
        JSON.stringify({
          type: "hello-reject",
          code: "duplicate",
          message: "a GM add-on session is already connected",
        }),
      );
      ws.close();
      return;
    }

    this.socket = ws;
    this.hello = {
      moduleId: typeof msg["moduleId"] === "string" ? msg["moduleId"] : "skeinkeeper",
      foundryVersion: version,
      worldId: typeof msg["worldId"] === "string" ? msg["worldId"] : "",
    };
    ws.send(JSON.stringify({ type: "hello-ok", protocol: 1 }));
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(this.hello);
  }

  private handleRes(msg: Record<string, unknown>): void {
    const id = typeof msg["id"] === "string" ? msg["id"] : "";
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (msg["ok"] === false) {
      const err = msg["error"];
      const rec = err !== null && typeof err === "object" ? (err as Record<string, unknown>) : {};
      pending.reject(
        new FoundryGatewayError(
          typeof rec["code"] === "string" ? rec["code"] : "error",
          typeof rec["message"] === "string" ? rec["message"] : "Foundry request failed",
        ),
      );
      return;
    }
    pending.resolve(msg["result"]);
  }

  private handleEvt(msg: Record<string, unknown>): void {
    if (msg["event"] === "gone") {
      for (const h of this.goneHandlers) h();
      return;
    }
    if (msg["event"] !== "chat") return;
    const payload = msg["payload"];
    if (payload === null || typeof payload !== "object") return;
    const rec = payload as Record<string, unknown>;
    const foundryUserId = typeof rec["foundryUserId"] === "string" ? rec["foundryUserId"] : "";
    const text = typeof rec["text"] === "string" ? rec["text"] : "";
    if (foundryUserId.length === 0 || text.length === 0) return;
    const event: FoundryChatEvent = {
      foundryUserId,
      text,
      isWhisper: rec["isWhisper"] === true,
      timestamp: typeof rec["timestamp"] === "string" ? rec["timestamp"] : "",
    };
    if (Array.isArray(rec["recipients"])) {
      const recipients = rec["recipients"].filter((r): r is string => typeof r === "string");
      for (const h of this.chatHandlers) h({ ...event, recipients });
      return;
    }
    for (const h of this.chatHandlers) h(event);
  }
}

function isLoopback(remote: string): boolean {
  const host = remote.replace(/^::ffff:/, "");
  // An empty/unknown remote address is treated as NON-loopback (fail closed):
  // it must not bypass the pairing check on a secret-less dev gateway.
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
