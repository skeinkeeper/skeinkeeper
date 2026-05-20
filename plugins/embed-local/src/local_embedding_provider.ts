// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { EmbeddingModel, FlagEmbedding } from "fastembed";
import type { EmbeddingProvider } from "@skeinkeeper/orchestrator";

/**
 * Local, in-process EmbeddingProvider (design doc 0019) — the default for
 * cold/episodic memory. Runs an ONNX sentence-embedding model via fastembed:
 * no API key, no per-call cost, and player content never leaves the operator's
 * machine (the privacy-preferred path, ADR-0010).
 *
 * The model (a few hundred MB) is downloaded + cached on first use, so the
 * first embed call is slow — hence model load is lazy and memoized. This is a
 * real adapter validated by an operator at runtime; the orchestrator's memory
 * logic is unit-tested against FakeEmbeddingProvider instead.
 */
const MODEL_DIMENSIONS: Partial<Record<EmbeddingModel, number>> = {
  [EmbeddingModel.BGESmallENV15]: 384,
  [EmbeddingModel.BGEBaseENV15]: 768,
  [EmbeddingModel.AllMiniLML6V2]: 384,
};

/** Built-in models (custom-model wiring is out of scope for the default). */
export type StandardEmbeddingModel = Exclude<EmbeddingModel, EmbeddingModel.CUSTOM>;

export interface LocalEmbeddingProviderOptions {
  /** Defaults to BGE-small-en-v1.5 (384-dim, small + fast). */
  model?: StandardEmbeddingModel;
  /** Where ONNX model files are cached. Defaults to fastembed's local cache. */
  cacheDir?: string;
  maxLength?: number;
  batchSize?: number;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  private readonly model: StandardEmbeddingModel;
  private readonly batchSize: number;
  private embedderPromise: Promise<FlagEmbedding> | null = null;

  constructor(private readonly options: LocalEmbeddingProviderOptions = {}) {
    this.model = options.model ?? EmbeddingModel.BGESmallENV15;
    this.dimensions = MODEL_DIMENSIONS[this.model] ?? 384;
    this.name = `local:${String(this.model)}`;
    this.batchSize = options.batchSize ?? 32;
  }

  private ensure(): Promise<FlagEmbedding> {
    if (this.embedderPromise === null) {
      this.embedderPromise = FlagEmbedding.init({
        model: this.model,
        ...(this.options.cacheDir !== undefined ? { cacheDir: this.options.cacheDir } : {}),
        ...(this.options.maxLength !== undefined ? { maxLength: this.options.maxLength } : {}),
      });
    }
    return this.embedderPromise;
  }

  async embed(texts: ReadonlyArray<string>): Promise<number[][]> {
    if (texts.length === 0) return [];
    const embedder = await this.ensure();
    const out: number[][] = [];
    for await (const batch of embedder.embed([...texts], this.batchSize)) {
      for (const vec of batch) out.push(Array.from(vec));
    }
    return out;
  }
}
