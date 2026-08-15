// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { z } from "zod";
import type { AnalyticsClient } from "@skeinkeeper/telemetry";
import type { FoundryClient } from "../foundry/client.js";
import { defineTool, type ToolHandlerContext } from "../registry.js";

export class TriggeredActionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "TriggeredActionError";
    this.code = code;
  }
}

export function requireFoundry(ctx: ToolHandlerContext): FoundryClient {
  if (ctx.foundry === undefined) {
    throw new TriggeredActionError("foundry-unavailable", "no Foundry client on this turn");
  }
  return ctx.foundry;
}

export function campaignIdOf(ctx: ToolHandlerContext): string {
  return ctx.campaignId ?? ctx.tenantDb.sessions.get(ctx.sessionId)?.campaignId ?? "unknown";
}

export function trackAction(
  ctx: ToolHandlerContext,
  name: keyof import("@skeinkeeper/telemetry").Events,
  props: Record<string, unknown>,
): void {
  const analytics: AnalyticsClient | undefined = ctx.analytics;
  analytics?.track(name, props as never);
}

export const revealTokenDef = defineTool({
  name: "reveal_token",
  description: "Reveal an existing hidden token to the table (Foundry token hidden flag → false).",
  mutatesWorld: true,
  inputSchema: z.object({ tokenId: z.string().min(1) }),
  outputSchema: z.object({ tokenId: z.string(), hidden: z.literal(false) }),
  async handle(input, ctx) {
    const campaignId = campaignIdOf(ctx);
    try {
      const foundry = requireFoundry(ctx);
      await foundry.updateToken({ tokenId: input.tokenId, hidden: false });
      trackAction(ctx, "action.reveal_token", { campaignId, success: true });
      return { tokenId: input.tokenId, hidden: false as const };
    } catch (err) {
      trackAction(ctx, "action.reveal_token", { campaignId, success: false });
      if (err instanceof TriggeredActionError) throw err;
      throw new TriggeredActionError(
        "token-update-failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  },
});

export const hideTokenDef = defineTool({
  name: "hide_token",
  description: "Hide an existing visible token (Foundry token hidden flag → true).",
  mutatesWorld: true,
  inputSchema: z.object({ tokenId: z.string().min(1) }),
  outputSchema: z.object({ tokenId: z.string(), hidden: z.literal(true) }),
  async handle(input, ctx) {
    const campaignId = campaignIdOf(ctx);
    try {
      const foundry = requireFoundry(ctx);
      await foundry.updateToken({ tokenId: input.tokenId, hidden: true });
      trackAction(ctx, "action.hide_token", { campaignId, success: true });
      return { tokenId: input.tokenId, hidden: true as const };
    } catch (err) {
      trackAction(ctx, "action.hide_token", { campaignId, success: false });
      if (err instanceof TriggeredActionError) throw err;
      throw new TriggeredActionError(
        "token-update-failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  },
});
