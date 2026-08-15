// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type {
  FoundryActor,
  FoundryClient,
  FoundryCreatureRef,
  FoundryPackRef,
  FoundryScene,
  FoundrySceneRef,
  FoundrySceneToken,
  FoundrySearchHit,
  FoundryUser,
  FoundryWorldInfo,
  FoundryModuleRef,
  FoundryRollResult,
} from "@skeinkeeper/orchestrator";
import type { McpToolCaller } from "./mcp_tool_caller.js";
import { asRecord, num, str, toArray, unwrap } from "./mcp_parse.js";

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

  async listScenes(): Promise<ReadonlyArray<FoundrySceneRef>> {
    const res = await this.caller.callTool("list-scenes", {});
    return parseSceneRefs(res);
  }

  async getWorldInfo(): Promise<FoundryWorldInfo> {
    try {
      const info = asRecord(await this.caller.callTool("get-world-info", {}));
      const systemId = str(info?.["system"]) ?? str(info?.["systemId"]) ?? this.system;
      const systemName = str(info?.["systemTitle"]) ?? str(info?.["systemName"]) ?? systemId;
      const modules = parseModules(info);
      const trimmed = systemId.trim();
      return {
        connected: true,
        system:
          trimmed.length > 0 && trimmed !== "unknown" ? { id: trimmed, name: systemName } : null,
        modules,
      };
    } catch {
      return { connected: false, system: null, modules: [] };
    }
  }

  /**
   * The current MCP bridge has no list-users tool (TDD 0041 / TDD 0037).
   * Return empty so intake degrades to RECO_FOUNDRY_OWNERSHIP_UNRESOLVED
   * rather than inventing a transport (ADR-0024).
   */
  async listUsers(): Promise<ReadonlyArray<FoundryUser>> {
    return [];
  }

  async listCompendiumPacks(): Promise<ReadonlyArray<FoundryPackRef>> {
    const res = await this.caller.callTool("list-compendium-packs", {});
    const arr = toArray(res, ["packs", "compendiums", "data", "results"]);
    const packs: FoundryPackRef[] = [];
    for (const item of arr) {
      const rec = asRecord(item);
      if (!rec) continue;
      const id = str(rec["id"]) ?? str(rec["packId"]) ?? str(rec["name"]);
      const label = str(rec["label"]) ?? str(rec["title"]) ?? str(rec["name"]) ?? id;
      if (id === undefined || label === undefined) continue;
      const type = str(rec["type"]) ?? str(rec["packageType"]);
      packs.push(type !== undefined ? { id, label, type } : { id, label });
    }
    return packs;
  }

  async listCreaturesByCriteria(criteria: {
    name?: string;
    type?: string;
  }): Promise<ReadonlyArray<FoundryCreatureRef>> {
    const res = await this.caller.callTool("list-creatures-by-criteria", {
      ...(criteria.name !== undefined ? { name: criteria.name } : {}),
      ...(criteria.type !== undefined ? { type: criteria.type } : {}),
    });
    const arr = toArray(res, ["creatures", "results", "data"]);
    const out: FoundryCreatureRef[] = [];
    for (const item of arr) {
      const rec = asRecord(item);
      if (!rec) continue;
      const id = str(rec["id"]) ?? str(rec["_id"]);
      const name = str(rec["name"]);
      if (id === undefined || name === undefined) continue;
      const pack = asRecord(rec["pack"]);
      const packId = str(rec["packId"]) ?? str(pack?.["id"]) ?? str(rec["pack"]) ?? "";
      const type = str(rec["type"]);
      out.push(type !== undefined ? { id, name, packId, type } : { id, name, packId });
    }
    return out;
  }

  async searchCompendium(
    query: string,
    opts?: { packType?: string },
  ): Promise<ReadonlyArray<FoundrySearchHit>> {
    const res = await this.caller.callTool("search-compendium", {
      query,
      ...(opts?.packType !== undefined ? { packType: opts.packType } : {}),
    });
    return parseSearchHits(res);
  }

  async searchJournals(query: string): Promise<ReadonlyArray<FoundrySearchHit>> {
    const res = await this.caller.callTool("search-journals", { query });
    return parseSearchHits(res);
  }

  // ---- writes ----

  async setActiveScene(sceneIdOrName: string): Promise<void> {
    // ADR-0015: switching the active map is an in-play DM action. The bridge's
    // switch-scene resolves by name or id.
    await this.caller.callTool("switch-scene", { scene_identifier: sceneIdOrName });
  }

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

export function parseSceneRefs(res: unknown): FoundrySceneRef[] {
  const arr = toArray(res, ["scenes", "data", "results"]);
  const refs: FoundrySceneRef[] = [];
  for (const item of arr) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = str(rec["id"]) ?? str(rec["_id"]);
    const name = str(rec["name"]);
    if (id === undefined || name === undefined) continue;
    refs.push({ id, name, active: rec["active"] === true });
  }
  return refs;
}

function unwrapActorRecord(res: unknown): Record<string, unknown> | null {
  return asRecord(unwrap(res, ["character", "actor", "data"]));
}

function parseModules(info: Record<string, unknown> | null): FoundryModuleRef[] {
  if (!info) return [];
  const fromArray = toArray(info, ["modules", "activeModules"]);
  if (fromArray.length > 0) {
    const out: FoundryModuleRef[] = [];
    for (const item of fromArray) {
      if (typeof item === "string") {
        out.push({ id: item, title: item });
        continue;
      }
      const rec = asRecord(item);
      if (!rec) continue;
      const id = str(rec["id"]) ?? str(rec["name"]);
      const title = str(rec["title"]) ?? str(rec["label"]) ?? id;
      if (id === undefined || title === undefined) continue;
      const active = rec["active"] === undefined ? undefined : rec["active"] !== false;
      out.push(active !== undefined ? { id, title, active } : { id, title });
    }
    return out;
  }
  const modulesRec = asRecord(info["modules"]);
  if (!modulesRec) return [];
  return Object.entries(modulesRec).map(([id, raw]) => {
    const rec = asRecord(raw);
    const title = str(rec?.["title"]) ?? str(rec?.["label"]) ?? id;
    const active = rec?.["active"] === undefined ? undefined : rec["active"] !== false;
    return active !== undefined ? { id, title, active } : { id, title };
  });
}

function parseSearchHits(res: unknown): FoundrySearchHit[] {
  const arr = toArray(res, ["results", "journals", "entries", "data"]);
  const out: FoundrySearchHit[] = [];
  for (const item of arr) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = str(rec["id"]) ?? str(rec["_id"]);
    const name = str(rec["name"]);
    if (id === undefined || name === undefined) continue;
    const pack = asRecord(rec["pack"]);
    const packId = str(rec["packId"]) ?? str(pack?.["id"]);
    const type = str(rec["type"]);
    out.push({
      id,
      name,
      ...(packId !== undefined ? { packId } : {}),
      ...(type !== undefined ? { type } : {}),
    });
  }
  return out;
}
