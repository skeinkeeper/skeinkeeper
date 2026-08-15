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
  FoundrySearchHit,
  FoundryUser,
  FoundryWorldInfo,
  RollResult,
} from "./client.js";

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
    for (const s of opts.scenes ?? []) this.scenesById.set(s.id, s);
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
    this.scenesById.set(scene.id, scene);
  }

  setPartyActorIds(ids: ReadonlyArray<string>): void {
    this.partyActorIds = ids;
  }

  /** Test helper: seed which scene is active (by id), or none. */
  seedActiveScene(sceneId: string | undefined): void {
    this.activeSceneId = sceneId;
  }

  readonly createdFromCompendium: Array<{ packId: string; itemId: string }> = [];

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
    const scene = this.scenesById.get(sceneId);
    if (!scene) return [];
    return scene.tokens
      .map((t) => this.actorsById.get(t.actorId))
      .filter((a): a is FoundryActor => a !== undefined);
  }

  async getActor(actorId: string): Promise<FoundryActor | null> {
    return this.actorsById.get(actorId) ?? null;
  }

  async getActiveScene(): Promise<FoundryScene | null> {
    if (this.activeSceneId === undefined) return null;
    return this.scenesById.get(this.activeSceneId) ?? null;
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
