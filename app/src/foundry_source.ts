// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { randomBytes } from "node:crypto";
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
  connect(): Promise<FoundryClient>;
  worldContent(): WorldContentReader;
  close(): Promise<void>;
  /** Add-on `evt gone` (TDD 0041) — the load-bearing Foundry-down signal
   *  (design doc 0039 §2a). Returns an unsubscribe. Optional so test fakes
   *  without a gateway can omit it. */
  onGone?(handler: () => void): () => void;
}

export function createFoundrySource(config: AppConfig, _env: NodeJS.ProcessEnv): FoundrySource {
  const secret =
    config.foundry.gateway.pairingSecret.trim().length > 0
      ? config.foundry.gateway.pairingSecret
      : randomBytes(24).toString("base64url");
  const gateway = new FoundryGateway({
    bind: config.foundry.gateway.bind,
    port: config.foundry.gateway.port,
    pairingSecret: secret,
    ...(config.foundry.gateway.tls !== undefined ? { tls: config.foundry.gateway.tls } : {}),
    log: (line) => console.info(line),
  });
  let lastClient: FoundryClient | null = null;
  let listening = false;

  return {
    connect: async () => {
      if (!listening) {
        await gateway.listen();
        listening = true;
        console.info(`Foundry add-on pairing secret: ${secret}`);
        console.info(`Foundry gateway: ${gateway.listenUrl}`);
      }
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
