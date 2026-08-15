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
  FoundryJournal,
  FoundryTokenDetails,
  FoundryUser,
  FoundryWorldInfo,
  FoundryModuleRef,
  FoundryRollResult,
  FoundryChatEvent,
  PostChatMessageArgs,
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

  async getJournal(journalId: string): Promise<FoundryJournal | null> {
    try {
      const res = await this.caller.callTool("get-quest-journal", { journalId });
      const parsed = parseJournal(res, journalId);
      if (parsed !== null) return parsed;
    } catch {
      // fall through to list-journals
    }
    try {
      const listed = await this.caller.callTool("list-journals", {});
      for (const item of toArray(listed, ["journals", "results", "data"])) {
        const parsed = parseJournal(item, journalId);
        if (parsed?.id === journalId) return parsed;
      }
    } catch {
      return null;
    }
    return null;
  }

  async listWorldActors(): Promise<ReadonlyArray<FoundryActor>> {
    const res = await this.caller.callTool("list-characters", {});
    return this.parseActorList(res);
  }

  async createActorFromCompendium(args: { packId: string; itemId: string }): Promise<FoundryActor> {
    const res = await this.caller.callTool("create-actor-from-compendium", {
      packId: args.packId,
      itemId: args.itemId,
    });
    const rec = asRecord(unwrap(res, ["actor", "character", "data"]));
    if (rec) return this.parseActor(rec);
    return {
      id: args.itemId,
      name: args.itemId,
      type: "npc",
      system: this.system,
      sheet: {},
      flags: { core: { sourceId: `Compendium.${args.packId}.${args.itemId}` } },
    };
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

  async createToken(args: {
    actorId?: string;
    compendiumRef?: string;
    sceneId?: string;
    x: number;
    y: number;
    hidden?: boolean;
    disposition?: "hostile" | "neutral" | "friendly";
  }): Promise<{ tokenId: string; actorId: string }> {
    const res = await this.caller.callTool("create-token", {
      ...(args.actorId !== undefined ? { actorId: args.actorId } : {}),
      ...(args.compendiumRef !== undefined ? { compendiumRef: args.compendiumRef } : {}),
      ...(args.sceneId !== undefined ? { sceneId: args.sceneId } : {}),
      x: args.x,
      y: args.y,
      ...(args.hidden !== undefined ? { hidden: args.hidden } : {}),
      ...(args.disposition !== undefined ? { disposition: args.disposition } : {}),
    });
    const rec = asRecord(unwrap(res, ["token", "data"])) ?? asRecord(res);
    const tokenId = str(rec?.["tokenId"]) ?? str(rec?.["id"]) ?? "";
    const actorId = str(rec?.["actorId"]) ?? args.actorId ?? "";
    return { tokenId, actorId };
  }

  async moveToken(args: { tokenId: string; x: number; y: number }): Promise<void> {
    await this.caller.callTool("move-token", { tokenId: args.tokenId, x: args.x, y: args.y });
  }

  async addActorItems(args: {
    actorId: string;
    items: ReadonlyArray<{ compendiumId?: string; itemId?: string; quantity: number }>;
  }): Promise<void> {
    await this.caller.callTool("add-actor-items", {
      actorId: args.actorId,
      items: args.items.map((item) => ({
        ...(item.compendiumId !== undefined ? { uuid: item.compendiumId } : {}),
        ...(item.itemId !== undefined ? { itemId: item.itemId } : {}),
        quantity: item.quantity,
      })),
    });
  }

  async updateToken(args: {
    tokenId: string;
    hidden?: boolean;
    x?: number;
    y?: number;
    sceneId?: string;
  }): Promise<void> {
    await this.caller.callTool("update-token", {
      tokenId: args.tokenId,
      ...(args.hidden !== undefined ? { hidden: args.hidden } : {}),
      ...(args.x !== undefined ? { x: args.x } : {}),
      ...(args.y !== undefined ? { y: args.y } : {}),
      ...(args.sceneId !== undefined ? { sceneId: args.sceneId } : {}),
    });
  }

  async getTokenDetails(tokenId: string): Promise<FoundryTokenDetails | null> {
    const res = await this.caller.callTool("get-token-details", { tokenId });
    return parseTokenDetails(res, tokenId);
  }

  async postChatMessage(args: PostChatMessageArgs): Promise<{ messageId: string }> {
    const res = await this.caller.callTool("post-chat-message", {
      content: args.content,
      mode: args.mode,
      ...(args.whisperTo !== undefined ? { whisperTo: [...args.whisperTo] } : {}),
      ...(args.speaker !== undefined ? { speaker: args.speaker } : {}),
    });
    const rec = asRecord(res);
    return { messageId: str(rec?.["messageId"]) ?? str(rec?.["id"]) ?? "" };
  }

  subscribeChatEvents(handler: (event: FoundryChatEvent) => void): () => void {
    if (this.caller.subscribe === undefined) return () => {};
    return this.caller.subscribe("chat", (payload) => {
      const rec = asRecord(payload);
      if (!rec) return;
      const foundryUserId = str(rec["foundryUserId"]);
      const text = str(rec["text"]);
      if (foundryUserId === undefined || text === undefined) return;
      const event: FoundryChatEvent = {
        foundryUserId,
        text,
        isWhisper: rec["isWhisper"] === true,
        timestamp: str(rec["timestamp"]) ?? "",
      };
      const recipientsRaw = rec["recipients"];
      if (Array.isArray(recipientsRaw)) {
        const recipients = recipientsRaw.filter((r): r is string => typeof r === "string");
        handler({ ...event, recipients });
        return;
      }
      handler(event);
    });
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
      actorId: str(tr["actorId"]) ?? str(tr["actor_id"]) ?? "",
      name: str(tr["name"]) ?? "(token)",
    };
    const id = str(tr["id"]) ?? str(tr["_id"]);
    const hidden = tr["hidden"];
    const x = num(tr["x"]);
    const y = num(tr["y"]);
    const disp = num(tr["disposition"]);
    return {
      ...token,
      ...(id !== undefined ? { id } : {}),
      ...(typeof hidden === "boolean" ? { hidden } : {}),
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
      ...(disp !== undefined ? { disposition: disp } : {}),
    };
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

function parseTokenDetails(res: unknown, fallbackId: string): FoundryTokenDetails | null {
  const rec = asRecord(unwrap(res, ["token", "data"])) ?? asRecord(res);
  if (!rec) return null;
  const id = str(rec["id"]) ?? str(rec["_id"]) ?? fallbackId;
  const actorId = str(rec["actorId"]) ?? str(rec["actor_id"]) ?? "";
  const name = str(rec["name"]) ?? "(token)";
  const hidden = rec["hidden"] === true;
  const details: FoundryTokenDetails = { id, actorId, name, hidden };
  const x = num(rec["x"]);
  const y = num(rec["y"]);
  const sceneId = str(rec["sceneId"]) ?? str(rec["scene_id"]);
  const disp = num(rec["disposition"]);
  return {
    ...details,
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
    ...(sceneId !== undefined ? { sceneId } : {}),
    ...(disp !== undefined ? { disposition: disp } : {}),
  };
}

function parseJournal(res: unknown, fallbackId: string): FoundryJournal | null {
  const rec = asRecord(unwrap(res, ["journal", "entry", "data"])) ?? asRecord(res);
  if (!rec) return null;
  const id = str(rec["id"]) ?? str(rec["_id"]) ?? fallbackId;
  const name = str(rec["name"]);
  if (name === undefined) return null;
  const text = str(rec["text"]) ?? str(rec["content"]) ?? "";
  const pagesRaw = toArray(rec["pages"], []);
  const pages: Array<{ id: string; name?: string; text: string }> = [];
  for (const p of pagesRaw) {
    const pr = asRecord(p);
    if (!pr) continue;
    const pid = str(pr["id"]) ?? str(pr["_id"]);
    const ptext = str(pr["text"]) ?? str(pr["content"]) ?? "";
    if (pid === undefined) continue;
    const pname = str(pr["name"]);
    pages.push(
      pname !== undefined ? { id: pid, name: pname, text: ptext } : { id: pid, text: ptext },
    );
  }
  return pages.length > 0 ? { id, name, text, pages } : { id, name, text };
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
