// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { VERSION } from "./version.js";

describe("VERSION", () => {
  it("matches a semver-shaped string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
