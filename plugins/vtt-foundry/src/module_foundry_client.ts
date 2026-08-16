// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type {
  DeleteChatMessagesArgs,
  FoundryActor,
  FoundryChatEvent,
  FoundryClient,
  FoundryCreatureRef,
  FoundryJournal,
  FoundryPackRef,
  FoundryScene,
  FoundrySceneRef,
  FoundryTokenDetails,
  FoundryUser,
  FoundryWorldInfo,
  PostChatMessageArgs,
  RollResult,
} from "@skeinkeeper/orchestrator";
import { FoundryGateway, FoundryGatewayError } from "./foundry_gateway.js";

/**
 * FoundryClient over the first-party add-on gateway (TDD 0041).
 * Ready only after hello-ok. Each method is req/res with a 5s timeout.
 */
export class ModuleFoundryClient implements FoundryClient {
  readonly system: string;

  private constructor(
    private readonly gateway: FoundryGateway,
    system: string,
  ) {
    this.system = system;
  }

  static async connect(gateway: FoundryGateway, timeoutMs = 5000): Promise<ModuleFoundryClient> {
    await gateway.waitForHello(timeoutMs);
    const client = new ModuleFoundryClient(gateway, "");
    const info = await client.getWorldInfo();
    const system = info.system?.id ?? "";
    return new ModuleFoundryClient(gateway, system);
  }

  subscribeChatEvents(handler: (event: FoundryChatEvent) => void): () => void {
    return this.gateway.onChat(handler);
  }

  async listPartyActors(): Promise<ReadonlyArray<FoundryActor>> {
    return asArray(await this.call("listPartyActors"));
  }
  async listSceneActors(sceneId: string): Promise<ReadonlyArray<FoundryActor>> {
    return asArray(await this.call("listSceneActors", { sceneId }));
  }
  async getActor(actorId: string): Promise<FoundryActor | null> {
    return (await this.call("getActor", { actorId })) as FoundryActor | null;
  }
  async getActiveScene(): Promise<FoundryScene | null> {
    return (await this.call("getActiveScene")) as FoundryScene | null;
  }
  async listScenes(): Promise<ReadonlyArray<FoundrySceneRef>> {
    return asArray(await this.call("listScenes"));
  }
  async getWorldInfo(): Promise<FoundryWorldInfo> {
    return (await this.call("getWorldInfo")) as FoundryWorldInfo;
  }
  async listUsers(): Promise<ReadonlyArray<FoundryUser>> {
    return asArray(await this.call("listUsers"));
  }
  async listCompendiumPacks(): Promise<ReadonlyArray<FoundryPackRef>> {
    return asArray(await this.call("listCompendiumPacks"));
  }
  async listCreaturesByCriteria(criteria: {
    name?: string;
    type?: string;
  }): Promise<ReadonlyArray<FoundryCreatureRef>> {
    return asArray(await this.call("listCreaturesByCriteria", { ...criteria }));
  }
  async searchCompendium(
    query: string,
    opts?: { packType?: string },
  ): Promise<ReadonlyArray<{ id: string; name: string; packId?: string; type?: string }>> {
    return asArray(await this.call("searchCompendium", { query, ...opts }));
  }
  async searchJournals(query: string): Promise<ReadonlyArray<{ id: string; name: string }>> {
    return asArray(await this.call("searchJournals", { query }));
  }
  async getJournal(journalId: string): Promise<FoundryJournal | null> {
    return (await this.call("getJournal", { journalId })) as FoundryJournal | null;
  }
  async listWorldActors(): Promise<ReadonlyArray<FoundryActor>> {
    return asArray(await this.call("listWorldActors"));
  }
  async applyActorUpdate(actorId: string, update: Record<string, unknown>): Promise<void> {
    await this.call("applyActorUpdate", { actorId, update });
  }
  async createActorFromCompendium(args: { packId: string; itemId: string }): Promise<FoundryActor> {
    return (await this.call("createActorFromCompendium", { ...args })) as FoundryActor;
  }
  async rollDice(
    formula: string,
    opts?: {
      speaker?: string;
      whisperTo?: ReadonlyArray<string>;
      mode?: "public" | "gm" | "blind" | "whisperTo";
    },
  ): Promise<RollResult> {
    return (await this.call("rollDice", {
      formula,
      ...(opts ?? {}),
    })) as RollResult;
  }
  async setActiveScene(sceneIdOrName: string): Promise<void> {
    await this.call("setActiveScene", { sceneIdOrName });
  }
  async updateToken(args: {
    tokenId: string;
    hidden?: boolean;
    x?: number;
    y?: number;
    sceneId?: string;
  }): Promise<void> {
    await this.call("updateToken", { ...args });
  }
  async getTokenDetails(tokenId: string): Promise<FoundryTokenDetails | null> {
    return (await this.call("getTokenDetails", { tokenId })) as FoundryTokenDetails | null;
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
    return (await this.call("createToken", { ...args })) as { tokenId: string; actorId: string };
  }
  async moveToken(args: { tokenId: string; x: number; y: number }): Promise<void> {
    await this.call("moveToken", { ...args });
  }
  async addActorItems(args: {
    actorId: string;
    items: ReadonlyArray<{ compendiumId?: string; itemId?: string; quantity: number }>;
  }): Promise<void> {
    await this.call("addActorItems", { ...args });
  }
  async postChatMessage(args: PostChatMessageArgs): Promise<{ messageId: string }> {
    return (await this.call("postChatMessage", { ...args })) as { messageId: string };
  }
  async deleteChatMessages(args: DeleteChatMessagesArgs): Promise<{ deletedCount: number }> {
    return (await this.call("deleteChatMessages", { ...args })) as { deletedCount: number };
  }

  private async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    try {
      return await this.gateway.request(method, params);
    } catch (err) {
      if (err instanceof FoundryGatewayError) throw err;
      throw err;
    }
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
