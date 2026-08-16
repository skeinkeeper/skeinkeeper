// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize } from "node:path";
import type { App } from "../bootstrap.js";
import type { EventBus } from "./event_bus.js";
import {
  getState,
  resolveIntake,
  resumeSession,
  setDmVoice,
  setEagerness,
  setOperator,
  setOperatorDmConsent,
  setPvp,
  verifyPreflight,
} from "./api.js";
import { mintToken, verifyPassword, verifyToken } from "../auth.js";

/** Optional local-operator auth (design doc 0020 §6). When omitted, the
 *  console is open (localhost dev); when set, the API requires a session
 *  cookie obtained from POST /api/login. */
export interface WebAuth {
  passwordHash: string;
  tokenSecret: string;
}

const SESSION_COOKIE = "sk_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Control-endpoint bodies are tiny JSON; cap to avoid a trivial memory DoS. */
const MAX_BODY_BYTES = 64 * 1024;

class RequestTooLargeError extends Error {}

function cookieToken(req: IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (raw === undefined) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return v.join("=");
  }
  return null;
}

/**
 * The operator web UI server (design doc 0020 §4) — Node's standard-library
 * http only: static panel + JSON control endpoints + an SSE live feed. No web
 * framework, zero new dependencies. Localhost-bound; auth lands in Phase 5c.
 *
 * The handler routing is thin; the control logic (api.ts) and the event fan-out
 * (event_bus.ts) are unit-tested. The live server is operator-validated.
 */
const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "static");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new RequestTooLargeError();
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/**
 * Reject a state-changing request whose Origin doesn't match its Host
 * (defense-in-depth CSRF guard on top of the SameSite=Strict cookie). A
 * same-origin fetch from the console sends a matching Origin; a cross-site
 * forgery sends a foreign one. Requests with no Origin (curl, same-origin
 * navigations) are allowed.
 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function serveStatic(res: ServerResponse, pathname: string): void {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = normalize(join(STATIC_DIR, rel));
  if (!full.startsWith(STATIC_DIR) || !existsSync(full)) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const type = MIME[extname(full)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  res.end(readFileSync(full));
}

function streamEvents(res: ServerResponse, bus: EventBus): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  // Heartbeat so dead connections reaped without a 'close' event don't linger
  // as zombie subscribers; cleared on close.
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      cleanup();
    }
  }, 25_000);
  const unsubscribe = bus.subscribe((event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      cleanup();
    }
  });
  function cleanup(): void {
    clearInterval(heartbeat);
    unsubscribe();
  }
  res.on("close", cleanup);
}

export function createWebServer(app: App, bus: EventBus, auth?: WebAuth): Server {
  return createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (err instanceof RequestTooLargeError) {
        sendJson(res, 413, { error: "request body too large" });
        return;
      }
      // Log the real error server-side; don't leak messages/stack to the client
      // (CLAUDE.md: no leaked internals at the HTTP boundary).
      console.error("[web] request handler error:", err);
      sendJson(res, 500, { error: "internal error" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    // Login: exchange the operator password for a session cookie.
    if (auth !== undefined && method === "POST" && pathname === "/api/login") {
      const body = (await readJsonBody(req)) as { password?: unknown };
      if (typeof body.password === "string" && verifyPassword(body.password, auth.passwordHash)) {
        const token = mintToken(auth.tokenSecret, "operator", Date.now() + SESSION_TTL_MS);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      return sendJson(res, 401, { error: "invalid password" });
    }

    // Gate the API (not static, not login) when auth is configured.
    if (auth !== undefined && pathname.startsWith("/api/")) {
      const token = cookieToken(req);
      if (token === null || !verifyToken(auth.tokenSecret, token)) {
        return sendJson(res, 401, { error: "authentication required" });
      }
    }

    // CSRF defense-in-depth: state-changing requests must be same-origin.
    if (method !== "GET" && method !== "HEAD" && !originAllowed(req)) {
      return sendJson(res, 403, { error: "cross-origin request refused" });
    }

    if (method === "GET" && pathname === "/api/state")
      return sendJson(res, 200, getState(app).body);
    if (method === "GET" && pathname === "/api/events") return streamEvents(res, bus);

    if (method === "POST" && pathname === "/api/eagerness") {
      const r = setEagerness(app, await readJsonBody(req));
      return sendJson(res, r.status, r.body);
    }
    if (method === "POST" && pathname === "/api/dm-voice") {
      const r = setDmVoice(app, await readJsonBody(req));
      return sendJson(res, r.status, r.body);
    }
    if (method === "POST" && pathname === "/api/pvp") {
      const r = setPvp(app, await readJsonBody(req));
      return sendJson(res, r.status, r.body);
    }
    if (method === "POST" && pathname === "/api/operator") {
      const r = await setOperator(app, await readJsonBody(req));
      return sendJson(res, r.status, r.body);
    }
    if (method === "POST" && pathname === "/api/session/start") {
      void app.manager.start().catch(() => undefined);
      return sendJson(res, 202, { started: true });
    }
    if (method === "POST" && pathname === "/api/session/stop") {
      await app.manager.stop();
      return sendJson(res, 200, { stopped: true });
    }
    if (method === "POST" && pathname === "/api/session/resume") {
      const r = await resumeSession(app);
      return sendJson(res, r.status, r.body);
    }
    if (method === "POST" && pathname === "/api/operator/dm-consent") {
      const r = setOperatorDmConsent(app, await readJsonBody(req));
      return sendJson(res, r.status, r.body);
    }
    if (method === "POST" && pathname === "/api/intake/resolve") {
      const r = await resolveIntake(app, await readJsonBody(req));
      return sendJson(res, r.status, r.body);
    }
    if (method === "POST" && pathname === "/api/preflight/verify") {
      const r = await verifyPreflight(app, await readJsonBody(req));
      return sendJson(res, r.status, r.body);
    }

    if (method === "GET") return serveStatic(res, pathname);
    sendJson(res, 404, { error: "not found" });
  }
}
