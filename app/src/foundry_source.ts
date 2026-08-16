// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  foundryWorldContentReader,
  type FoundryClient,
  type WorldContentReader,
} from "@skeinkeeper/orchestrator";
import { FoundryGateway, ModuleFoundryClient } from "@skeinkeeper/vtt-foundry";
import type { AppConfig } from "./config.js";

/**
 * Production Foundry source (TDD 0041). Starts the gateway, waits for the
 * add-on hello-ok, and never constructs MockFoundryClient.
 * Tests inject a FoundrySource that returns MockFoundryClient.
 */
export interface FoundrySource {
  /** Start the gateway listening and reveal the pairing secret + URL, WITHOUT
   *  waiting for the add-on. Called once at boot so the operator can pair the
   *  add-on BEFORE the first Start (design doc 0041). Idempotent — `connect`
   *  also calls it. Optional so test fakes without a gateway can omit it. */
  startGateway?(): Promise<void>;
  connect(): Promise<FoundryClient>;
  worldContent(): WorldContentReader;
  close(): Promise<void>;
  /** Add-on `evt gone` (TDD 0041) — the load-bearing Foundry-down signal
   *  (design doc 0039 §2a). Returns an unsubscribe. Optional so test fakes
   *  without a gateway can omit it. */
  onGone?(handler: () => void): () => void;
}

/**
 * Resolve the gateway pairing secret. An operator-set secret (required for a
 * `lan` bind) always wins. Otherwise — the loopback default — generate one and
 * persist it under dataDir (0600), so pairing survives restarts instead of
 * regenerating every boot and forcing a re-pair. Mirrors the installation-id /
 * salt dotfiles (main.ts / server). Loopback-only, so plaintext-at-rest next to
 * the DB is acceptable: the secret just stops a local web page from
 * impersonating the add-on; the sensitive provider keys live in the sealed
 * store (design doc 0029).
 */
export function loadOrCreatePairingSecret(dataDir: string, envSecret: string): string {
  const fromEnv = envSecret.trim();
  if (fromEnv.length > 0) return fromEnv;
  const path = join(dataDir, ".foundry-pairing-secret");
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length >= 16) return raw;
  }
  const secret = randomBytes(24).toString("base64url");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}

export function createFoundrySource(config: AppConfig, _env: NodeJS.ProcessEnv): FoundrySource {
  const secret = loadOrCreatePairingSecret(config.dataDir, config.foundry.gateway.pairingSecret);
  const gateway = new FoundryGateway({
    bind: config.foundry.gateway.bind,
    port: config.foundry.gateway.port,
    pairingSecret: secret,
    ...(config.foundry.gateway.tls !== undefined ? { tls: config.foundry.gateway.tls } : {}),
    log: (line) => console.info(line),
  });
  let lastClient: FoundryClient | null = null;
  let listening = false;

  const startGateway = async (): Promise<void> => {
    if (listening) return;
    await gateway.listen();
    listening = true;
    console.info(`Foundry add-on pairing secret: ${secret}`);
    console.info(`Foundry gateway: ${gateway.listenUrl}`);
    console.info(
      "Enable the Skeinkeeper add-on in your Foundry world, paste that secret into its " +
        "settings, then Start a session from the console.",
    );
  };

  return {
    startGateway,
    connect: async () => {
      await startGateway();
      try {
        const client = await ModuleFoundryClient.connect(gateway, 5000);
        lastClient = client;
        return client;
      } catch (err) {
        lastClient = null;
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Foundry add-on did not connect: ${reason}. Enable the Skeinkeeper add-on in your Foundry world and point it at ${gateway.listenUrl}.`,
        );
      }
    },
    worldContent: () => {
      if (lastClient === null) {
        throw new Error("Foundry add-on is not connected.");
      }
      return foundryWorldContentReader(lastClient);
    },
    close: async () => {
      lastClient = null;
      if (listening) {
        await gateway.close();
        listening = false;
      }
    },
    onGone: (handler) => gateway.onGone(handler),
  };
}
