// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import {
  TranscriptionBuffer,
  renderBuffer,
  utteranceToFragment,
  type BufferFragment,
} from "./buffer.js";

function frag(speaker: string, text: string, ts = 1, final = true): BufferFragment {
  return { speaker, text, startTs: ts, endTs: ts, final };
}

describe("TranscriptionBuffer", () => {
  it("accumulates finalized fragments and drains them", () => {
    const b = new TranscriptionBuffer();
    b.append(frag("alice", "I open the door"));
    b.append(frag("bob", "wait"));
    expect(b.size).toBe(2);
    const drained = b.drain();
    expect(drained.map((f) => f.text)).toEqual(["I open the door", "wait"]);
    expect(b.size).toBe(0);
    expect(b.pending()).toHaveLength(0);
  });

  it("ignores non-final fragments", () => {
    const b = new TranscriptionBuffer();
    b.append(frag("alice", "interim...", 1, false));
    expect(b.size).toBe(0);
  });

  it("pending() returns a copy, not the live array", () => {
    const b = new TranscriptionBuffer();
    b.append(frag("alice", "hi"));
    const snapshot = b.pending();
    b.append(frag("bob", "yo"));
    expect(snapshot).toHaveLength(1);
  });
});

describe("utteranceToFragment", () => {
  it("marks utterance-derived fragments as final and carries displayName", () => {
    const f = utteranceToFragment({
      speaker: "discord:1",
      displayName: "Alice",
      text: "hello",
      timestamp: 42,
    });
    expect(f).toEqual({
      speaker: "discord:1",
      displayName: "Alice",
      text: "hello",
      startTs: 42,
      endTs: 42,
      final: true,
    });
  });
});

describe("renderBuffer", () => {
  it("labels each line by display name (falling back to speaker id)", () => {
    const out = renderBuffer([
      { speaker: "discord:1", displayName: "Alice", text: "I move up", startTs: 1, endTs: 1, final: true },
      { speaker: "discord:2", text: "I follow", startTs: 2, endTs: 2, final: true },
    ]);
    expect(out).toBe("[Alice] I move up\n[discord:2] I follow");
  });
});
