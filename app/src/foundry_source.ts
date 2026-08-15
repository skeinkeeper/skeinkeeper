// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { MockFoundryClient, type FoundryClient } from "@skeinkeeper/orchestrator";
import { McpFoundryClient, StdioMcpToolCaller } from "@skeinkeeper/vtt-foundry";
import type { AppConfig } from "./config.js";

/**
 * Resolves a FoundryClient at session-start (design doc 0020 §2, doc 0014).
 * When FOUNDRY_MCP_COMMAND is configured, connects the real OSS bridge over
 * stdio; otherwise (or if the bridge is unreachable) falls back to a mock so a
 * session can still run. Connecting lazily means the operator can boot the app
 * before Foundry is up and start the session once it is.
 */
export interface FoundrySource {
  connect(): Promise<FoundryClient>;
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
    return { connect: () => Promise.resolve(mock), close: () => Promise.resolve() };
  }

  let caller: StdioMcpToolCaller | null = null;
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
        return client;
      } catch (err) {
        await c.close().catch(() => undefined);
        console.warn(
          `Foundry MCP bridge unavailable (${err instanceof Error ? err.message : String(err)}); intake will report FOUNDRY_NOT_CONNECTED.`,
        );
        return new MockFoundryClient({ system: "", connected: false });
      }
    },
    close: async () => {
      await caller?.close().catch(() => undefined);
      caller = null;
    },
  };
}
