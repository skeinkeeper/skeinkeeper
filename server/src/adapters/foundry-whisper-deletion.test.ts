// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { ErasureService, type DeletionAdapter, type ErasureScope } from "../erasure.js";
import {
  FoundryWhisperDeletionAdapter,
  type FoundryChatDeletionClient,
  type PlayerCharacterMapStore,
} from "./foundry-whisper-deletion.js";

class FakeFoundry implements FoundryChatDeletionClient {
  readonly calls: Array<{
    scope: "by-author" | "by-recipient" | "by-time-range";
    authorFoundryUserId?: string;
    recipientFoundryUserId?: string;
  }> = [];
  throwWith: string | undefined;
  async deleteChatMessages(args: {
    scope: "by-author" | "by-recipient" | "by-time-range";
    authorFoundryUserId?: string;
    recipientFoundryUserId?: string;
  }): Promise<{ deletedCount: number }> {
    this.calls.push(args);
    if (this.throwWith !== undefined) throw new Error(this.throwWith);
    if (args.scope === "by-recipient") return { deletedCount: 7 };
    if (args.scope === "by-author") return { deletedCount: 3 };
    return { deletedCount: 0 };
  }
}

class FakeIdentityMap implements PlayerCharacterMapStore {
  constructor(private readonly row: { foundryUserId: string | null } | undefined) {}
  currentForPlayer(): { foundryUserId: string | null } | undefined {
    return this.row;
  }
}

const playerScope: ErasureScope = { kind: "player", tenantId: "t1", subjectId: "d1" };

describe("FoundryWhisperDeletionAdapter", () => {
  it("deletes by-recipient and by-author and sums the counts", async () => {
    const foundry = new FakeFoundry();
    const adapter = new FoundryWhisperDeletionAdapter(
      foundry,
      new FakeIdentityMap({ foundryUserId: "u1" }),
      true,
    );
    const result = await adapter.delete(playerScope);
    expect(result).toEqual({ recordsDeleted: 10 });
    expect(foundry.calls).toEqual([
      { scope: "by-recipient", recipientFoundryUserId: "u1" },
      { scope: "by-author", authorFoundryUserId: "u1" },
    ]);
  });

  it("reports no-foundry-user-mapped when the identity row has a null Foundry user", async () => {
    const foundry = new FakeFoundry();
    const adapter = new FoundryWhisperDeletionAdapter(
      foundry,
      new FakeIdentityMap({ foundryUserId: null }),
      true,
    );
    const result = await adapter.delete(playerScope);
    expect(result.recordsDeleted).toBe(0);
    expect(result.manualRemainder?.reason).toBe("no-foundry-user-mapped");
    expect(result.manualRemainder?.message).toContain("d1");
    expect(foundry.calls).toEqual([]);
  });

  it("reports no-foundry-user-mapped when no identity row exists", async () => {
    const adapter = new FoundryWhisperDeletionAdapter(
      new FakeFoundry(),
      new FakeIdentityMap(undefined),
      true,
    );
    const result = await adapter.delete(playerScope);
    expect(result.manualRemainder?.reason).toBe("no-foundry-user-mapped");
  });

  it("reports addon-unavailable without calling Foundry when disconnected", async () => {
    const foundry = new FakeFoundry();
    const adapter = new FoundryWhisperDeletionAdapter(
      foundry,
      new FakeIdentityMap({ foundryUserId: "u1" }),
      false,
    );
    const result = await adapter.delete(playerScope);
    expect(result.recordsDeleted).toBe(0);
    expect(result.manualRemainder?.reason).toBe("addon-unavailable");
    expect(result.manualRemainder?.foundryUserId).toBe("u1");
    expect(foundry.calls).toEqual([]);
  });

  it("reports foundry-call-failed when deleteChatMessages throws", async () => {
    const foundry = new FakeFoundry();
    foundry.throwWith = "bridge down";
    const adapter = new FoundryWhisperDeletionAdapter(
      foundry,
      new FakeIdentityMap({ foundryUserId: "u1" }),
      true,
    );
    const result = await adapter.delete(playerScope);
    expect(result.recordsDeleted).toBe(0);
    expect(result.manualRemainder?.reason).toBe("foundry-call-failed");
    expect(result.manualRemainder?.message).toContain("bridge down");
    expect(result.manualRemainder?.message).toContain("player:delete");
  });

  it("is a no-op on non-player scopes", async () => {
    const foundry = new FakeFoundry();
    const adapter = new FoundryWhisperDeletionAdapter(
      foundry,
      new FakeIdentityMap({ foundryUserId: "u1" }),
      true,
    );
    expect(adapter.supportedScopes).toEqual(["player"]);
    expect(await adapter.delete({ kind: "campaign", tenantId: "t1", campaignId: "c1" })).toEqual({
      recordsDeleted: 0,
    });
    expect(foundry.calls).toEqual([]);
  });
});

describe("FoundryWhisperDeletionAdapter via ErasureService", () => {
  it("reports success on the ErasureReport (verification: cascade success)", async () => {
    const db = openDb({ path: ":memory:", runMigrations: true });
    const foundry = new FakeFoundry();
    const erasure = new ErasureService({ db, salt: "test-salt-32-chars-aaaaaaaaaaaaaa" });
    erasure.register(
      new FoundryWhisperDeletionAdapter(
        foundry,
        new FakeIdentityMap({ foundryUserId: "u1" }),
        true,
      ),
    );
    const report = await erasure.erase(playerScope);
    expect(report.perAdapter).toEqual([{ adapter: "foundry-whisper", recordsDeleted: 10 }]);
    expect(report.partialSuccess).toBe(false);
    expect(report.manualRemainders).toEqual([]);
  });

  it("snapshots the identity map before another adapter can erase it", async () => {
    const db = openDb({ path: ":memory:", runMigrations: true });
    const foundry = new FakeFoundry();
    const map: { row: { foundryUserId: string | null } | undefined } = {
      row: { foundryUserId: "u1" },
    };
    const identity: PlayerCharacterMapStore = {
      currentForPlayer: () => map.row,
    };
    const clearing: DeletionAdapter = {
      name: "player_character_map",
      supportedScopes: ["player"],
      async delete() {
        map.row = undefined;
        return { recordsDeleted: 1 };
      },
    };
    const whisper = new FoundryWhisperDeletionAdapter(foundry, identity, true);
    const erasure = new ErasureService({ db, salt: "test-salt-32-chars-aaaaaaaaaaaaaa" });
    erasure.register(clearing);
    erasure.register(whisper);
    const report = await erasure.erase(playerScope);
    expect(foundry.calls.map((c) => c.scope)).toEqual(["by-recipient", "by-author"]);
    expect(report.perAdapter.find((p) => p.adapter === "foundry-whisper")?.recordsDeleted).toBe(10);
    expect(report.partialSuccess).toBe(false);
  });
});
