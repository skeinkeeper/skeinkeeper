// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type {
  FoundryActor,
  FoundryClient,
  FoundryCreatureRef,
  FoundryModuleRef,
  FoundryPackRef,
  FoundryScene,
  FoundrySceneRef,
  FoundrySceneToken,
  FoundrySearchHit,
  FoundryTokenDetails,
  FoundryUser,
  FoundryWorldInfo,
  RollResult,
} from "./client.js";

interface MutableToken {
  id: string;
  actorId: string;
  name: string;
  hidden: boolean;
  x: number;
  y: number;
  disposition?: number;
}

export interface MockFoundryClientOptions {
  system: string;
  systemName?: string;
  /** When false, getWorldInfo reports a disconnected world (TDD 0031). */
  connected?: boolean;
  actors?: ReadonlyArray<FoundryActor>;
  scenes?: ReadonlyArray<FoundryScene>;
  partyActorIds?: ReadonlyArray<string>;
  activeSceneId?: string;
  modules?: ReadonlyArray<FoundryModuleRef>;
  users?: ReadonlyArray<FoundryUser>;
  packs?: ReadonlyArray<FoundryPackRef>;
  creatures?: ReadonlyArray<FoundryCreatureRef>;
  compendiumHits?: ReadonlyArray<FoundrySearchHit>;
  journalHits?: ReadonlyArray<FoundrySearchHit>;
}

/**
 * In-memory FoundryClient for unit tests. Holds actors and scenes in
 * plain maps; mutations via applyActorUpdate are recorded; dice rolls
 * are deterministic (always returns 10 unless seeded otherwise).
 */
export class MockFoundryClient implements FoundryClient {
  readonly system: string;
  readonly connected: boolean;
  private readonly systemName: string;
  private readonly actorsById = new Map<string, FoundryActor>();
  private readonly scenesById = new Map<string, FoundryScene>();
  private readonly tokensByScene = new Map<string, MutableToken[]>();
  private tokenSeq = 0;
  private partyActorIds: ReadonlyArray<string>;
  private activeSceneId: string | undefined;
  private modules: ReadonlyArray<FoundryModuleRef>;
  private users: ReadonlyArray<FoundryUser>;
  private packs: ReadonlyArray<FoundryPackRef>;
  private creatures: ReadonlyArray<FoundryCreatureRef>;
  private compendiumHits: ReadonlyArray<FoundrySearchHit>;
  private journalHits: ReadonlyArray<FoundrySearchHit>;
  readonly updates: Array<{ actorId: string; update: Record<string, unknown> }> = [];
  readonly rolls: Array<{ formula: string; speaker?: string; whisperTo?: ReadonlyArray<string> }> =
    [];
  /** setActiveScene invocations (TDD 0032 activateScene idempotency). */
  readonly sceneSwitches: string[] = [];
  /** updateToken invocations (TDD 0033). */
  readonly tokenUpdates: Array<{
    tokenId: string;
    hidden?: boolean;
    x?: number;
    y?: number;
    sceneId?: string;
  }> = [];
  /** Override the deterministic roll result; set by tests. */
  rollResultFor: (formula: string) => RollResult = (formula) => ({
    total: 10,
    rolls: [10],
    formula,
  });

  constructor(opts: MockFoundryClientOptions) {
    this.system = opts.system;
    this.systemName = opts.systemName ?? opts.system;
    this.connected = opts.connected ?? true;
    for (const a of opts.actors ?? []) this.actorsById.set(a.id, a);
    for (const s of opts.scenes ?? []) this.seedScene(s);
    this.partyActorIds = opts.partyActorIds ?? [];
    if (opts.activeSceneId !== undefined) this.activeSceneId = opts.activeSceneId;
    this.modules = opts.modules ?? [];
    this.users = opts.users ?? [];
    this.packs = opts.packs ?? [];
    this.creatures = opts.creatures ?? [];
    this.compendiumHits = opts.compendiumHits ?? [];
    this.journalHits = opts.journalHits ?? [];
  }

  seedModules(modules: ReadonlyArray<FoundryModuleRef>): void {
    this.modules = modules;
  }

  seedUsers(users: ReadonlyArray<FoundryUser>): void {
    this.users = users;
  }

  seedPacks(packs: ReadonlyArray<FoundryPackRef>): void {
    this.packs = packs;
  }

  seedCreatures(creatures: ReadonlyArray<FoundryCreatureRef>): void {
    this.creatures = creatures;
  }

  seedCompendiumHits(hits: ReadonlyArray<FoundrySearchHit>): void {
    this.compendiumHits = hits;
  }

  seedJournalHits(hits: ReadonlyArray<FoundrySearchHit>): void {
    this.journalHits = hits;
  }

  setActor(actor: FoundryActor): void {
    this.actorsById.set(actor.id, actor);
  }

  setScene(scene: FoundryScene): void {
    this.seedScene(scene);
  }

  private seedScene(scene: FoundryScene): void {
    this.scenesById.set(scene.id, scene);
    this.tokensByScene.set(
      scene.id,
      scene.tokens.map((t) => this.toMutableToken(t)),
    );
  }

  private toMutableToken(t: FoundrySceneToken): MutableToken {
    this.tokenSeq += 1;
    const token: MutableToken = {
      id: t.id ?? `tok-${t.actorId}-${this.tokenSeq}`,
      actorId: t.actorId,
      name: t.name,
      hidden: t.hidden === true,
      x: t.x ?? 0,
      y: t.y ?? 0,
    };
    if (t.disposition !== undefined) token.disposition = t.disposition;
    return token;
  }

  private sceneTokens(sceneId: string): FoundrySceneToken[] {
    return (this.tokensByScene.get(sceneId) ?? []).map((t) => this.toSceneToken(t));
  }

  private toSceneToken(t: MutableToken): FoundrySceneToken {
    const token: FoundrySceneToken = {
      id: t.id,
      actorId: t.actorId,
      name: t.name,
      hidden: t.hidden,
      x: t.x,
      y: t.y,
    };
    if (t.disposition !== undefined) token.disposition = t.disposition;
    return token;
  }

  private findToken(tokenId: string): { sceneId: string; token: MutableToken } | undefined {
    for (const [sceneId, tokens] of this.tokensByScene) {
      const token = tokens.find((t) => t.id === tokenId);
      if (token !== undefined) return { sceneId, token };
    }
    return undefined;
  }

  private sceneSnapshot(scene: FoundryScene): FoundryScene {
    const snap: FoundryScene = {
      id: scene.id,
      name: scene.name,
      active: scene.id === this.activeSceneId,
      tokens: this.sceneTokens(scene.id),
    };
    if (scene.description !== undefined) snap.description = scene.description;
    return snap;
  }

  setPartyActorIds(ids: ReadonlyArray<string>): void {
    this.partyActorIds = ids;
  }

  /** Test helper: seed which scene is active (by id), or none. */
  seedActiveScene(sceneId: string | undefined): void {
    this.activeSceneId = sceneId;
  }

  readonly createdFromCompendium: Array<{ packId: string; itemId: string }> = [];
  readonly addedItems: Array<{
    actorId: string;
    items: ReadonlyArray<{ compendiumId?: string; itemId?: string; quantity: number }>;
  }> = [];

  async listWorldActors(): Promise<ReadonlyArray<FoundryActor>> {
    return [...this.actorsById.values()];
  }

  async createActorFromCompendium(args: { packId: string; itemId: string }): Promise<FoundryActor> {
    this.createdFromCompendium.push({ packId: args.packId, itemId: args.itemId });
    const hit = this.compendiumHits.find((h) => h.id === args.itemId);
    const id = `imported-${args.packId}-${args.itemId}`;
    const actor: FoundryActor = {
      id,
      name: hit?.name ?? args.itemId,
      type: hit?.type ?? "npc",
      system: this.system,
      sheet: {},
      flags: { core: { sourceId: `Compendium.${args.packId}.${args.itemId}` } },
    };
    this.actorsById.set(id, actor);
    return actor;
  }

  async listPartyActors(): Promise<ReadonlyArray<FoundryActor>> {
    return this.partyActorIds
      .map((id) => this.actorsById.get(id))
      .filter((a): a is FoundryActor => a !== undefined);
  }

  async listSceneActors(sceneId: string): Promise<ReadonlyArray<FoundryActor>> {
    if (!this.scenesById.has(sceneId)) return [];
    return this.sceneTokens(sceneId)
      .map((t) => this.actorsById.get(t.actorId))
      .filter((a): a is FoundryActor => a !== undefined);
  }

  async getActor(actorId: string): Promise<FoundryActor | null> {
    return this.actorsById.get(actorId) ?? null;
  }

  async getActiveScene(): Promise<FoundryScene | null> {
    if (this.activeSceneId === undefined) return null;
    const scene = this.scenesById.get(this.activeSceneId);
    return scene === undefined ? null : this.sceneSnapshot(scene);
  }

  async listScenes(): Promise<ReadonlyArray<FoundrySceneRef>> {
    return [...this.scenesById.values()].map((s) => ({
      id: s.id,
      name: s.name,
      active: s.id === this.activeSceneId,
    }));
  }

  async getWorldInfo(): Promise<FoundryWorldInfo> {
    const systemId = this.system.trim();
    return {
      connected: this.connected,
      system: systemId.length > 0 ? { id: systemId, name: this.systemName || systemId } : null,
      modules: this.modules,
    };
  }

  async listUsers(): Promise<ReadonlyArray<FoundryUser>> {
    return this.users;
  }

  async listCompendiumPacks(): Promise<ReadonlyArray<FoundryPackRef>> {
    return this.packs;
  }

  async listCreaturesByCriteria(criteria: {
    name?: string;
    type?: string;
  }): Promise<ReadonlyArray<FoundryCreatureRef>> {
    return this.creatures.filter((c) => {
      if (criteria.name !== undefined && c.name.toLowerCase() !== criteria.name.toLowerCase()) {
        return false;
      }
      if (criteria.type !== undefined && c.type !== criteria.type) return false;
      return true;
    });
  }

  async searchCompendium(
    query: string,
    opts?: { packType?: string },
  ): Promise<ReadonlyArray<FoundrySearchHit>> {
    const q = query.toLowerCase();
    return this.compendiumHits.filter((h) => {
      if (!h.name.toLowerCase().includes(q) && !h.id.toLowerCase().includes(q)) return false;
      if (opts?.packType !== undefined && h.type !== opts.packType) return false;
      return true;
    });
  }

  async searchJournals(query: string): Promise<ReadonlyArray<FoundrySearchHit>> {
    const q = query.toLowerCase();
    return this.journalHits.filter(
      (h) => h.name.toLowerCase().includes(q) || h.id.toLowerCase().includes(q),
    );
  }

  /** Activate a scene by id or (case-insensitive) name (ADR-0015). */
  async setActiveScene(sceneIdOrName: string): Promise<void> {
    this.sceneSwitches.push(sceneIdOrName);
    const byId = this.scenesById.get(sceneIdOrName);
    const scene =
      byId ??
      [...this.scenesById.values()].find(
        (s) => s.name.toLowerCase() === sceneIdOrName.toLowerCase(),
      );
    if (scene !== undefined) this.activeSceneId = scene.id;
  }

  async addActorItems(args: {
    actorId: string;
    items: ReadonlyArray<{ compendiumId?: string; itemId?: string; quantity: number }>;
  }): Promise<void> {
    this.addedItems.push({ actorId: args.actorId, items: args.items });
  }

  async updateToken(args: {
    tokenId: string;
    hidden?: boolean;
    x?: number;
    y?: number;
    sceneId?: string;
  }): Promise<void> {
    this.tokenUpdates.push(args);
    const found = this.findToken(args.tokenId);
    if (found === undefined) {
      throw new Error(`token-update-failed: token not found`);
    }
    if (args.hidden !== undefined) found.token.hidden = args.hidden;
    if (args.x !== undefined) found.token.x = args.x;
    if (args.y !== undefined) found.token.y = args.y;
  }

  async getTokenDetails(tokenId: string): Promise<FoundryTokenDetails | null> {
    const found = this.findToken(tokenId);
    if (found === undefined) return null;
    return {
      id: found.token.id,
      actorId: found.token.actorId,
      name: found.token.name,
      hidden: found.token.hidden,
      x: found.token.x,
      y: found.token.y,
      sceneId: found.sceneId,
      ...(found.token.disposition !== undefined ? { disposition: found.token.disposition } : {}),
    };
  }

  async applyActorUpdate(actorId: string, update: Record<string, unknown>): Promise<void> {
    this.updates.push({ actorId, update });
    const existing = this.actorsById.get(actorId);
    if (existing) {
      // Shallow-merge update.system into existing.sheet for test convenience.
      const updateSystem = (update.system as Record<string, unknown> | undefined) ?? {};
      this.actorsById.set(actorId, {
        ...existing,
        sheet: { ...existing.sheet, ...updateSystem },
      });
    }
  }

  async rollDice(
    formula: string,
    opts?: { speaker?: string; whisperTo?: ReadonlyArray<string> },
  ): Promise<RollResult> {
    this.rolls.push({
      formula,
      ...(opts?.speaker !== undefined ? { speaker: opts.speaker } : {}),
      ...(opts?.whisperTo !== undefined ? { whisperTo: opts.whisperTo } : {}),
    });
    return this.rollResultFor(formula);
  }
}
