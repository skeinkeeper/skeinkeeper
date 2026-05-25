// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSecretsCli } from "./secrets_cli.js";
import { runCli } from "./cli.js";
import { EnvKeySource, loadSealedSecrets } from "./secret_store.js";

describe("runSecretsCli", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sk-secrets-cli-"));
    path = join(dir, "secrets.sealed");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const opened = (pass: string): Record<string, string> =>
    loadSealedSecrets({
      path,
      keySource: new EnvKeySource({ SKEINKEEPER_SECRET_PASSPHRASE: pass }),
    });

  it("seal: seals only sealable secrets from the env into a loadable file", () => {
    const env = {
      SKEINKEEPER_DATA_DIR: dir,
      SKEINKEEPER_SECRET_PASSPHRASE: "pw",
      ANTHROPIC_API_KEY: "sk-ant-zzz",
      DISCORD_BOT_TOKEN: "tok",
      SKEINKEEPER_WEB_PORT: "3000", // not a secret — must not be sealed
    };
    const r = runSecretsCli(["secrets:seal"], env);
    expect(r.code).toBe(0);
    expect(opened("pw")).toEqual({ ANTHROPIC_API_KEY: "sk-ant-zzz", DISCORD_BOT_TOKEN: "tok" });
    expect(r.output).not.toContain("sk-ant-zzz"); // never prints values
  });

  it("seal: errors (non-zero, no file written) without a passphrase", () => {
    const r = runSecretsCli(["secrets:seal"], {
      SKEINKEEPER_DATA_DIR: dir,
      ANTHROPIC_API_KEY: "x",
    });
    expect(r.code).not.toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it("status: reports no file, then lists sealed key names without values", () => {
    const env = { SKEINKEEPER_DATA_DIR: dir, SKEINKEEPER_SECRET_PASSPHRASE: "pw" };
    expect(runSecretsCli(["secrets:status"], env).output).toMatch(/no sealed/i);
    runSecretsCli(["secrets:seal"], { ...env, ANTHROPIC_API_KEY: "sk-status-secret" });
    const r = runSecretsCli(["secrets:status"], env);
    expect(r.code).toBe(0);
    expect(r.output).toContain("ANTHROPIC_API_KEY");
    expect(r.output).not.toContain("sk-status-secret");
  });

  it("rotate: re-seals under a new passphrase (old no longer opens)", () => {
    runSecretsCli(["secrets:seal"], {
      SKEINKEEPER_DATA_DIR: dir,
      SKEINKEEPER_SECRET_PASSPHRASE: "old",
      ANTHROPIC_API_KEY: "sk-rotate",
    });
    const r = runSecretsCli(["secrets:rotate", "--new-passphrase", "new"], {
      SKEINKEEPER_DATA_DIR: dir,
      SKEINKEEPER_SECRET_PASSPHRASE: "old",
    });
    expect(r.code).toBe(0);
    expect(() => opened("old")).toThrow();
    expect(opened("new")).toEqual({ ANTHROPIC_API_KEY: "sk-rotate" });
  });

  it("unseal: prints KEY=value lines and --remove deletes the file", () => {
    runSecretsCli(["secrets:seal"], {
      SKEINKEEPER_DATA_DIR: dir,
      SKEINKEEPER_SECRET_PASSPHRASE: "pw",
      ANTHROPIC_API_KEY: "sk-unseal",
    });
    const r = runSecretsCli(["secrets:unseal", "--remove"], {
      SKEINKEEPER_DATA_DIR: dir,
      SKEINKEEPER_SECRET_PASSPHRASE: "pw",
    });
    expect(r.code).toBe(0);
    expect(r.output).toContain("ANTHROPIC_API_KEY=sk-unseal");
    expect(existsSync(path)).toBe(false);
  });

  it("runCli routes secrets:* commands to the secrets CLI (no DB needed)", async () => {
    const out: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      out.push(typeof s === "string" ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stdout.write;
    const origDataDir = process.env["SKEINKEEPER_DATA_DIR"];
    process.env["SKEINKEEPER_DATA_DIR"] = dir; // temp dir, no sealed file
    try {
      const code = await runCli(["secrets:status"], {}, {});
      expect(code).toBe(0);
      expect(out.join("")).toMatch(/no sealed/i);
    } finally {
      process.stdout.write = origWrite;
      if (origDataDir === undefined) delete process.env["SKEINKEEPER_DATA_DIR"];
      else process.env["SKEINKEEPER_DATA_DIR"] = origDataDir;
    }
  });
});
