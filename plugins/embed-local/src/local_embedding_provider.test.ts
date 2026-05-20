// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { LocalEmbeddingProvider } from "./local_embedding_provider.js";

// Construction only — calling embed() downloads a model, so the live embedding
// path is operator-validated, not unit-tested.
describe("LocalEmbeddingProvider", () => {
  it("reports a model-tagged name and dimensions without loading the model", () => {
    const p = new LocalEmbeddingProvider();
    expect(p.name).toMatch(/^local:/);
    expect(p.dimensions).toBe(384);
  });
});
