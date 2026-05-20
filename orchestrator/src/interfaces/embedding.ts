// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * EmbeddingProvider — turns text into vectors for the cold/episodic memory
 * tiers (design doc 0019, ADR-0002). A plugin surface per ADR-0004: the
 * default is a local, in-process model (no key, content stays on-box);
 * hosted providers (Voyage/OpenAI) are optional opt-ins.
 *
 * The embedding model identity + dimensions are recorded with each stored
 * vector so a model switch is detectable (vectors from different models
 * aren't comparable).
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: ReadonlyArray<string>): Promise<number[][]>;
}

/**
 * Deterministic in-memory embedder for unit tests and the eval harness.
 * Hashes tokens into a fixed-dimension bag so cosine similarity reflects
 * word overlap — enough to assert retrieval ordering without a real model.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = "fake";
  constructor(readonly dimensions: number = 16) {}

  async embed(texts: ReadonlyArray<string>): Promise<number[][]> {
    return texts.map((t) => this.vector(t));
  }

  private vector(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      let h = 0;
      for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) >>> 0;
      v[h % this.dimensions]! += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}
