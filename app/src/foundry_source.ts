// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import {
  foundryWorldContentReader,
  MockFoundryClient,
  type FoundryClient,
  type WorldContentReader,
} from "@skeinkeeper/orchestrator";
import { McpFoundryClient, StdioMcpToolCaller } from "@skeinkeeper/vtt-foundry";
import type { AppConfig } from "./config.js";

/**
 * Resolves a FoundryClient at session-start (TDD 0007 / 0020).
 * Production transport is TDD 0041 (`ModuleFoundryClient`). Until that
 * lands, Start still uses the shipped TDD 0014 MCP spawn when
 * FOUNDRY_MCP_COMMAND is set. World-content indexing always goes through
 * FoundryClient (`foundryWorldContentReader`) — not MCP tool names.
 */
export interface FoundrySource {
  connect(): Promise<FoundryClient>;
  worldContent(): WorldContentReader;
  close(): Promise<void>;
}

function envRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

export function createFoundrySource(config: AppConfig, env: NodeJS.ProcessEnv): FoundrySource {
  const cmd = config.foundry.mcpCommand;
  if (cmd === undefined || cmd.length === 0) {
    const mock = new MockFoundryClient({ system: "dnd5e" });
    return {
      connect: () => Promise.resolve(mock),
      worldContent: () => foundryWorldContentReader(mock),
      close: () => Promise.resolve(),
    };
  }

  let caller: StdioMcpToolCaller | null = null;
  let lastClient: FoundryClient | null = null;
  return {
    connect: async () => {
      const c = new StdioMcpToolCaller({
        command: cmd[0]!,
        args: cmd.slice(1),
        env: envRecord(env),
      });
      try {
        const client = await McpFoundryClient.connect(c);
        caller = c;
        lastClient = client;
        return client;
      } catch (err) {
        await c.close().catch(() => undefined);
        caller = null;
        console.warn(
          `Foundry MCP bridge unavailable (${err instanceof Error ? err.message : String(err)}); intake will report FOUNDRY_NOT_CONNECTED.`,
        );
        lastClient = new MockFoundryClient({ system: "", connected: false });
        return lastClient;
      }
    },
    worldContent: () =>
      foundryWorldContentReader(lastClient ?? new MockFoundryClient({ system: "dnd5e" })),
    close: async () => {
      await caller?.close().catch(() => undefined);
      caller = null;
      lastClient = null;
    },
  };
}
