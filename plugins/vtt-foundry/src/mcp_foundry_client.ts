// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type {
  FoundryActor,
  FoundryClient,
  FoundryScene,
  FoundrySceneToken,
  FoundryRollResult,
} from "@skeinkeeper/orchestrator";
import type { McpToolCaller } from "./mcp_tool_caller.js";

/**
 * FoundryClient backed by the adambdooley/foundry-vtt-mcp bridge (per
 * ADR-0011, design doc 0014). Reads map cleanly to the bridge's
 * list-characters / get-character / get-current-scene / get-token-details
 * tools. Writes are partial: the bridge has no generic actor-update or
 * direct HP/damage tool, so applyActorUpdate supports only the mutations
 * the bridge exposes (conditions, token moves) and rolls are not
 * server-side. See design doc 0014 § "The mutation gap."
 *
 * The response field-mappings below encode the bridge's payload shape and
 * MUST be validated against a live Foundry + bridge (Phase 3-live); the
 * parsers are written defensively and unit-tested against the assumed
 * shape so the mapping logic is provably correct for that shape.
 */
export class McpFoundryClient implements FoundryClient {
  readonly system: string;

  constructor(
    private readonly caller: McpToolCaller,
    system: string,
  ) {
    this.system = system;
  }

  /** Discover the active Foundry system from the bridge (get-world-info). */
  static async connect(caller: McpToolCaller): Promise<McpFoundryClient> {
    const info = asRecord(await caller.callTool("get-world-info", {}));
    const system = str(info?.["system"]) ?? str(info?.["systemId"]) ?? "unknown";
    return new McpFoundryClient(caller, system);
  }

  async listPartyActors(): Promise<ReadonlyArray<FoundryActor>> {
    const res = await this.caller.callTool("list-characters", {});
    return this.parseActorList(res);
  }

  async listSceneActors(sceneId: string): Promise<ReadonlyArray<FoundryActor>> {
    const res = await this.caller.callTool("get-token-details", { sceneId });
    return this.parseActorList(res);
  }

  async getActor(actorId: string): Promise<FoundryActor | null> {
    const res = await this.caller.callTool("get-character", { id: actorId });
    const rec = unwrapActorRecord(res);
    return rec ? this.parseActor(rec) : null;
  }

  async getActiveScene(): Promise<FoundryScene | null> {
    const res = await this.caller.callTool("get-current-scene", {});
    return parseScene(res);
  }

  // ---- writes ----

  async applyActorUpdate(actorId: string, update: Record<string, unknown>): Promise<void> {
    // The bridge has no generic actor-update tool. Map the mutations it
    // *does* expose; reject the rest with a clear, actionable error.
    if ("condition" in update && typeof update["condition"] === "string") {
      await this.caller.callTool("toggle-token-condition", {
        actorId,
        condition: update["condition"],
        active: update["active"] !== false,
      });
      return;
    }
    if ("position" in update) {
      await this.caller.callTool("update-token", { actorId, ...update });
      return;
    }
    throw new Error(
      `McpFoundryClient.applyActorUpdate: the Foundry MCP bridge has no generic ` +
        `actor-update tool, so this update (${Object.keys(update).join(", ")}) isn't ` +
        `supported. Direct HP/damage mutation in particular has no bridge tool — ` +
        `apply damage via a Foundry item (use-item) or fork the bridge to add an ` +
        `update-actor tool. See design doc 0014 § "The mutation gap."`,
    );
  }

  async rollDice(): Promise<FoundryRollResult> {
    // The bridge only exposes interactive rolls (request-player-rolls),
    // which prompt a human in Foundry — not a server-side roll returning a
    // total. The orchestrator's `roll` tool should keep using its local
    // crypto roller until the bridge gains (or is forked to add) a
    // server-side roll tool. See design doc 0014 § "The mutation gap."
    throw new Error(
      "McpFoundryClient.rollDice: the Foundry MCP bridge has no server-side roll " +
        "tool (only interactive request-player-rolls). Use the orchestrator's local " +
        "roll tool, or fork the bridge to add a server-side roll.",
    );
  }

  // ---- parsing (validate field names against a live bridge — design doc 0014) ----

  private parseActorList(res: unknown): FoundryActor[] {
    const arr = toArray(res, ["characters", "actors", "tokens", "data"]);
    return arr.map((a) => this.parseActor(asRecord(a) ?? {}));
  }

  private parseActor(rec: Record<string, unknown>): FoundryActor {
    const sheet = (asRecord(rec["system"]) ?? asRecord(rec["sheet"]) ?? {}) as Readonly<
      Record<string, unknown>
    >;
    const actor: FoundryActor = {
      id: str(rec["id"]) ?? str(rec["_id"]) ?? "",
      name: str(rec["name"]) ?? "(unnamed)",
      type: str(rec["type"]) ?? "character",
      system: this.system,
      sheet,
    };
    const flags = asRecord(rec["flags"]);
    return flags ? { ...actor, flags } : actor;
  }
}

// ---- module-level pure parsers ----

export function parseScene(res: unknown): FoundryScene | null {
  const rec = asRecord(unwrap(res, ["scene", "data"]));
  if (!rec) return null;
  const id = str(rec["id"]) ?? str(rec["_id"]);
  const name = str(rec["name"]);
  if (id === undefined || name === undefined) return null;

  const tokenArr = toArray(rec["tokens"], []);
  const tokens: FoundrySceneToken[] = tokenArr.map((t) => {
    const tr = asRecord(t) ?? {};
    const token: FoundrySceneToken = {
      actorId: str(tr["actorId"]) ?? str(tr["actor_id"]) ?? str(tr["id"]) ?? "",
      name: str(tr["name"]) ?? "(token)",
    };
    const disp = num(tr["disposition"]);
    return disp !== undefined ? { ...token, disposition: disp } : token;
  });

  const scene: FoundryScene = {
    id,
    name,
    active: rec["active"] !== false,
    tokens,
  };
  const description = str(rec["description"]);
  return description !== undefined ? { ...scene, description } : scene;
}

function unwrap(res: unknown, keys: string[]): unknown {
  const rec = asRecord(res);
  if (!rec) return res;
  for (const k of keys) {
    if (k in rec) return rec[k];
  }
  return res;
}

function unwrapActorRecord(res: unknown): Record<string, unknown> | null {
  const unwrapped = unwrap(res, ["character", "actor", "data"]);
  return asRecord(unwrapped);
}

function toArray(res: unknown, keys: string[]): unknown[] {
  if (Array.isArray(res)) return res;
  const rec = asRecord(res);
  if (rec) {
    for (const k of keys) {
      if (Array.isArray(rec[k])) return rec[k] as unknown[];
    }
  }
  return [];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
