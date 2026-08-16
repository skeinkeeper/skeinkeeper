// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Operator-app entrypoint. Loads config + secrets, wires the App, and starts the
 * operator console (web UI) on localhost. The console drives start/stop — the app
 * does NOT auto-join a voice channel on boot.
 *
 *   pnpm app:start            # then open the console URL it logs
 *
 * Foundry connects via the first-party add-on (TDD 0041).
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
import { EnvKeySource, loadEffectiveEnv } from "@skeinkeeper/server";
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
  // Overlay sealed credentials onto the env before building config (design doc
  // 0029) so secrets live encrypted at rest, not in plaintext .env — and stay out
  // of the global process.env (so spawned subprocesses don't inherit them). Fail
  // closed: a present-but-unopenable sealed file throws here and aborts boot.
  const baseEnv = process.env;
  const dataDir = baseEnv["SKEINKEEPER_DATA_DIR"] ?? "./data";
  const env = loadEffectiveEnv(baseEnv, {
    path: join(dataDir, "secrets.sealed"),
    keySource: new EnvKeySource(baseEnv),
  });
  const config = loadConfig(env);

  // Telemetry — off unless the operator opted in (ADR-0009). The orchestrator
  // emits events through this client; when disabled it's a no-op.
  const installationId = loadOrCreateInstallationId(config.dataDir);
  const analytics = createAnalytics({
    enabled: env["SKEINKEEPER_TELEMETRY_ANALYTICS"] === "1",
    installationId,
    ...(env["POSTHOG_PROJECT_API_KEY"] !== undefined
      ? { posthogKey: env["POSTHOG_PROJECT_API_KEY"] }
      : {}),
    ...(env["POSTHOG_HOST"] !== undefined ? { posthogHost: env["POSTHOG_HOST"] } : {}),
  });
  const crash = createCrash({
    enabled: env["SKEINKEEPER_TELEMETRY_CRASH"] === "1",
    installationId,
    ...(env["SENTRY_DSN"] !== undefined ? { sentryDsn: env["SENTRY_DSN"] } : {}),
  });
  analytics.track("app.started", { version: VERSION, nodeVersion: process.version });

  const bus = new EventBus();
  const app = createApp(config, { onEvent: (e) => bus.emit(e), analytics });

  // Optional local auth: set SKEINKEEPER_OPERATOR_PASSWORD_HASH (from
  // `hashPassword`) to require login; otherwise the localhost console is open.
  const passwordHash = env["SKEINKEEPER_OPERATOR_PASSWORD_HASH"];
  const auth =
    passwordHash !== undefined && passwordHash.length > 0
      ? {
          passwordHash,
          tokenSecret: env["SKEINKEEPER_SESSION_SECRET"] ?? randomBytes(32).toString("hex"),
        }
      : undefined;

  // The operator console drives start/stop; we don't auto-join on boot.
  // Bind to loopback by default so the console isn't exposed on the network
  // (override with SKEINKEEPER_WEB_HOST=0.0.0.0 only if you understand the risk).
  const host = env["SKEINKEEPER_WEB_HOST"] ?? "127.0.0.1";
  const hostIsLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  // Fail closed: never expose an unauthenticated console off-box. A non-loopback
  // bind without an operator password would put start/stop, state overrides, and
  // transcripts on the network with no auth. Require the password hash first.
  if (!hostIsLoopback && auth === undefined) {
    throw new Error(
      `Refusing to bind the operator console to ${host} without a password. ` +
        `Set SKEINKEEPER_OPERATOR_PASSWORD_HASH (see hashPassword) before exposing it off-box, ` +
        `or bind to 127.0.0.1.`,
    );
  }
  const web = createWebServer(app, bus, auth);
  web.listen(config.webPort, host, () => {
    console.log(`Skeinkeeper operator console: http://${host}:${config.webPort}`);
    if (auth === undefined)
      console.log(
        "  (no operator password set — console is unauthenticated; loopback-only. " +
          "Set SKEINKEEPER_OPERATOR_PASSWORD_HASH to require login.)",
      );
    if (!hostIsLoopback) {
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
