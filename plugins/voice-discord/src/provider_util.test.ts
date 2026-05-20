// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import type { STTOptions } from "@skeinkeeper/orchestrator";
import { assertOk, buildUtterance, drainBlob, drainBytes } from "./provider_util.js";

async function* chunks(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const p of parts) yield p;
}

describe("assertOk", () => {
  it("passes through an ok response", () => {
    expect(() => assertOk(new Response("x", { status: 200 }), "X request")).not.toThrow();
  });
  it("throws a labeled error on a non-ok response", () => {
    expect(() => assertOk(new Response("nope", { status: 401 }), "Deepgram listen request")).toThrow(
      /Deepgram listen request failed: 401/,
    );
  });
});

describe("drainBytes", () => {
  it("concatenates chunks into one buffer", async () => {
    const out = await drainBytes(chunks(new Uint8Array([1, 2]), new Uint8Array([3])));
    expect([...out]).toEqual([1, 2, 3]);
  });
  it("returns an empty buffer for an empty stream", async () => {
    expect((await drainBytes(chunks())).length).toBe(0);
  });
});

describe("drainBlob", () => {
  it("concatenates chunks into a blob of the right size", async () => {
    const blob = await drainBlob(chunks(new Uint8Array([1, 2, 3]), new Uint8Array([4])));
    expect(blob.size).toBe(4);
  });
});

describe("buildUtterance", () => {
  const opts: STTOptions = { speaker: "discord:1", displayName: "Alice", language: "en" };

  it("assembles speaker + displayName + text + confidence + timestamp", () => {
    const u = buildUtterance(opts, "hello", 0.9);
    expect(u.speaker).toBe("discord:1");
    expect(u.displayName).toBe("Alice");
    expect(u.text).toBe("hello");
    expect(u.confidence).toBe(0.9);
    expect(typeof u.timestamp).toBe("number");
  });

  it("omits displayName + confidence when absent", () => {
    const u = buildUtterance({ speaker: "discord:2" }, "hi");
    expect("displayName" in u).toBe(false);
    expect("confidence" in u).toBe(false);
  });
});
