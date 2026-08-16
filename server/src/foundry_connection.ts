// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Out-of-session Foundry add-on probe for `player:delete` (TDD 0038).
 * TDD 0041 owns the real hello-ok gateway; until that lands the CLI
 * injects a probe (MCP getWorldInfo, or a test fake). Missing/failed
 * probes are "not connected" so the cascade records addon-unavailable.
 */
export interface FoundryConnectionCheck {
  probe?: () => boolean | Promise<boolean>;
  getWorldInfo?: () => Promise<{ connected: boolean }>;
}

export async function checkFoundryAddonConnected(opts: FoundryConnectionCheck): Promise<boolean> {
  if (opts.probe !== undefined) {
    try {
      return (await opts.probe()) === true;
    } catch {
      return false;
    }
  }
  if (opts.getWorldInfo !== undefined) {
    try {
      return (await opts.getWorldInfo()).connected === true;
    } catch {
      return false;
    }
  }
  return false;
}
