// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { parseArgs } from "node:util";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  EnvKeySource,
  SEALABLE_KEYS,
  SecretStoreError,
  loadSealedSecrets,
  sealSecrets,
  sealedKeyNames,
} from "./secret_store.js";

/**
 * `secrets:*` CLI (design doc 0029): seal / status / rotate / unseal for the
 * sealed credential store. Pure-ish — returns a code + output string so it's
 * testable without capturing stdout; cli.ts writes the output and exits.
 */
type Env = Record<string, string | undefined>;
export interface SecretsCliResult {
  code: number;
  output: string;
}

function sealedPath(env: Env): string {
  return join(env["SKEINKEEPER_DATA_DIR"] ?? "./data", "secrets.sealed");
}

export function runSecretsCli(argv: ReadonlyArray<string>, env: Env): SecretsCliResult {
  const command = argv[0];
  let values: { "new-passphrase"?: string; remove?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv.slice(1)],
      options: {
        "new-passphrase": { type: "string" },
        remove: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return { code: 2, output: `${err instanceof Error ? err.message : "invalid arguments"}\n` };
  }

  const path = sealedPath(env);
  const keySource = new EnvKeySource(env);

  switch (command) {
    case "secrets:seal":
      return sealCmd(env, path);
    case "secrets:status":
      return statusCmd(path, keySource);
    case "secrets:rotate":
      return rotateCmd(env, path, keySource, values["new-passphrase"]);
    case "secrets:unseal":
      return unsealCmd(path, keySource, values.remove === true);
    default:
      return { code: 2, output: `Unknown secrets command: ${command ?? "(none)"}\n` };
  }
}

function sealCmd(env: Env, path: string): SecretsCliResult {
  const passphrase = env["SKEINKEEPER_SECRET_PASSPHRASE"];
  if (passphrase === undefined || passphrase.trim().length === 0) {
    return { code: 2, output: "Set SKEINKEEPER_SECRET_PASSPHRASE before sealing.\n" };
  }
  const secrets: Record<string, string> = {};
  for (const k of SEALABLE_KEYS) {
    const v = env[k];
    if (v !== undefined && v.trim().length > 0) secrets[k] = v;
  }
  const keys = Object.keys(secrets);
  if (keys.length === 0) {
    return { code: 2, output: "No sealable secrets found in the environment; nothing to seal.\n" };
  }
  sealSecrets({ path, passphrase, secrets });
  return {
    code: 0,
    output:
      `Sealed ${keys.length} secret(s) → ${path}\n  ${keys.join(", ")}\n` +
      `Now remove these keys from your .env (the sealed file is authoritative).\n`,
  };
}

function statusCmd(path: string, keySource: EnvKeySource): SecretsCliResult {
  if (!existsSync(path)) return { code: 0, output: `No sealed secrets file at ${path}.\n` };
  if (keySource.getPassphrase() === undefined) {
    return {
      code: 0,
      output: `Sealed file present at ${path}; set SKEINKEEPER_SECRET_PASSPHRASE to inspect it.\n`,
    };
  }
  try {
    const names = sealedKeyNames({ path, keySource }).sort();
    return { code: 0, output: `Sealed keys (${names.length}): ${names.join(", ")}\n` };
  } catch (err) {
    if (err instanceof SecretStoreError) return { code: 1, output: `${err.message}\n` };
    throw err;
  }
}

function rotateCmd(
  env: Env,
  path: string,
  keySource: EnvKeySource,
  newPass: string | undefined,
): SecretsCliResult {
  const next = newPass ?? env["SKEINKEEPER_SECRET_PASSPHRASE_NEW"];
  if (next === undefined || next.trim().length === 0) {
    return {
      code: 2,
      output:
        "Provide the new passphrase via --new-passphrase or SKEINKEEPER_SECRET_PASSPHRASE_NEW.\n",
    };
  }
  if (!existsSync(path)) return { code: 1, output: `No sealed secrets file at ${path}.\n` };
  try {
    const secrets = loadSealedSecrets({ path, keySource });
    sealSecrets({ path, passphrase: next, secrets });
    return {
      code: 0,
      output: `Rotated the passphrase for ${path} (${Object.keys(secrets).length} secret(s)).\n`,
    };
  } catch (err) {
    if (err instanceof SecretStoreError) return { code: 1, output: `${err.message}\n` };
    throw err;
  }
}

function unsealCmd(path: string, keySource: EnvKeySource, remove: boolean): SecretsCliResult {
  if (!existsSync(path)) return { code: 1, output: `No sealed secrets file at ${path}.\n` };
  try {
    const secrets = loadSealedSecrets({ path, keySource });
    const lines = Object.entries(secrets)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    let out =
      `# WARNING: plaintext secrets below. Paste into .env, then clear your shell history.\n` +
      `${lines}\n`;
    if (remove) {
      rmSync(path);
      out += `Removed ${path}.\n`;
    }
    return { code: 0, output: out };
  } catch (err) {
    if (err instanceof SecretStoreError) return { code: 1, output: `${err.message}\n` };
    throw err;
  }
}
