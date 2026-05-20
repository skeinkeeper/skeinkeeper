// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.js";
import type { DeletionAdapter, ErasureScope } from "./erasure.js";

const dirs: string[] = [];
function tmpEnv(): { dbPath: string; saltPath: string } {
  const d = mkdtempSync(join(tmpdir(), "sk-cli-"));
  dirs.push(d);
  return { dbPath: join(d, "skeinkeeper.db"), saltPath: join(d, ".salt") };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

class RecordingAdapter implements DeletionAdapter {
  readonly name = "recording";
  readonly supportedScopes = ["campaign", "tenant"] as const;
  readonly calls: Array<ErasureScope> = [];
  async delete(scope: ErasureScope): Promise<number> {
    this.calls.push(scope);
    return 7;
  }
}

describe("runCli — injected (extra) deletion adapters", () => {
  it("registers and invokes an injected adapter on campaign:delete", async () => {
    const env = tmpEnv();
    const extra = new RecordingAdapter();
    const code = await runCli(
      ["campaign:delete", "--tenant", "default", "--campaign", "c1", "--yes"],
      env,
      { extraDeletionAdapters: [extra] },
    );
    expect(code).toBe(0);
    expect(extra.calls).toHaveLength(1);
    expect(extra.calls[0]).toEqual({ kind: "campaign", tenantId: "default", campaignId: "c1" });
  });

  it("invokes the injected adapter on tenant:delete too", async () => {
    const env = tmpEnv();
    const extra = new RecordingAdapter();
    const code = await runCli(["tenant:delete", "--tenant", "default", "--yes"], env, {
      extraDeletionAdapters: [extra],
    });
    expect(code).toBe(0);
    expect(extra.calls[0]?.kind).toBe("tenant");
  });

  it("reports a non-zero exit and the error when an adapter fails", async () => {
    const env = tmpEnv();
    const failing: DeletionAdapter = {
      name: "boom",
      supportedScopes: ["tenant"],
      async delete() {
        throw new Error("kaboom");
      },
    };
    const code = await runCli(["tenant:delete", "--tenant", "default", "--yes"], env, {
      extraDeletionAdapters: [failing],
    });
    expect(code).toBe(1);
  });
});
