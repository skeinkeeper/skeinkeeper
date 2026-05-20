// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { extractFirstJsonObject } from "./extract_json.js";

describe("extractFirstJsonObject", () => {
  it("parses a bare JSON object", () => {
    expect(extractFirstJsonObject('{"respond": true, "reason": "x"}')).toEqual({
      respond: true,
      reason: "x",
    });
  });

  it("pulls the object out of surrounding prose / fences", () => {
    const text = 'Sure! Here you go:\n```json\n{"voiceId": "v1"}\n```\nHope that helps.';
    expect(extractFirstJsonObject(text)).toEqual({ voiceId: "v1" });
  });

  it("returns null when there's no object", () => {
    expect(extractFirstJsonObject("no json here")).toBeNull();
    expect(extractFirstJsonObject("")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(extractFirstJsonObject('{"respond": tru')).toBeNull();
    expect(extractFirstJsonObject("{not valid}")).toBeNull();
  });

  it("returns null for a JSON value that isn't an object", () => {
    // The regex requires braces, so a bare array/number won't match → null.
    expect(extractFirstJsonObject("[1, 2, 3]")).toBeNull();
    expect(extractFirstJsonObject("42")).toBeNull();
  });
});
