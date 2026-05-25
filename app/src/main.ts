// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Operator-app entrypoint. Loads config + secrets, wires the App, and starts the
 * operator console (web UI) on localhost. The console drives start/stop — the app
 * does NOT auto-join a voice channel on boot.
 *
 *   pnpm app:start            # then open the console URL it logs
 *
 * Foundry connects to the real OSS MCP bridge when FOUNDRY_MCP_COMMAND is set
 * (spawned at session start); otherwise it falls back to a mock.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERSION } from "@skeinkeeper/core";
import { createAnalytics, createCrash } from "@skeinkeeper/telemetry";
import { loadConfig } from "./config.js";
import { createApp } from "./bootstrap.js";
import { loadDotenv } from "./dotenv.js";
import { EventBus } from "./web/event_bus.js";
import { createWebServer } from "./web/server.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Opaque, rotating-by-deletion install token for anonymous telemetry
 *  (ADR-0009/0010) — never derived from operator identity. Persisted per box. */
function loadOrCreateInstallationId(dataDir: string): string {
  const path = join(dataDir, ".installation");
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length >= 16) return raw;
  }
  const id = randomBytes(16).toString("hex");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, id, { mode: 0o600 });
  return id;
}

async function main(): Promise<void> {
  loadDotenv(REPO_ROOT);
  const config = loadConfig(process.env);

  // Telemetry — off unless the operator opted in (ADR-0009). The orchestrator
  // emits events through this client; when disabled it's a no-op.
  const installationId = loadOrCreateInstallationId(config.dataDir);
  const analytics = createAnalytics({
    enabled: process.env["SKEINKEEPER_TELEMETRY_ANALYTICS"] === "1",
    installationId,
    ...(process.env["POSTHOG_PROJECT_API_KEY"] !== undefined
      ? { posthogKey: process.env["POSTHOG_PROJECT_API_KEY"] }
      : {}),
    ...(process.env["POSTHOG_HOST"] !== undefined
      ? { posthogHost: process.env["POSTHOG_HOST"] }
      : {}),
  });
  const crash = createCrash({
    enabled: process.env["SKEINKEEPER_TELEMETRY_CRASH"] === "1",
    installationId,
    ...(process.env["SENTRY_DSN"] !== undefined ? { sentryDsn: process.env["SENTRY_DSN"] } : {}),
  });
  analytics.track("app.started", { version: VERSION, nodeVersion: process.version });

  const bus = new EventBus();
  const app = createApp(config, { onEvent: (e) => bus.emit(e), analytics });

  // Optional local auth: set SKEINKEEPER_OPERATOR_PASSWORD_HASH (from
  // `hashPassword`) to require login; otherwise the localhost console is open.
  const passwordHash = process.env["SKEINKEEPER_OPERATOR_PASSWORD_HASH"];
  const auth =
    passwordHash !== undefined && passwordHash.length > 0
      ? {
          passwordHash,
          tokenSecret: process.env["SKEINKEEPER_SESSION_SECRET"] ?? randomBytes(32).toString("hex"),
        }
      : undefined;

  // The operator console drives start/stop; we don't auto-join on boot.
  // Bind to loopback by default so the console isn't exposed on the network
  // (override with SKEINKEEPER_WEB_HOST=0.0.0.0 only if you understand the risk).
  const host = process.env["SKEINKEEPER_WEB_HOST"] ?? "127.0.0.1";
  const web = createWebServer(app, bus, auth);
  web.listen(config.webPort, host, () => {
    console.log(`Skeinkeeper operator console: http://${host}:${config.webPort}`);
    if (auth === undefined)
      console.log("  (no operator password set — console is unauthenticated)");
    if (host !== "127.0.0.1" && host !== "localhost") {
      console.log(`  (WARNING: bound to ${host} — the console is reachable on the network)`);
    }
  });

  const shutdown = async (): Promise<void> => {
    console.log("\nStopping…");
    await app.manager.stop();
    web.close();
    await Promise.allSettled([analytics.flush(), crash.flush()]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
