// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { asRecord, nonEmptyStr, num, str, toArray, unwrap } from "./mcp_parse.js";

describe("mcp_parse", () => {
  it("asRecord accepts plain objects, rejects arrays/null/primitives", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1, 2])).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asRecord("x")).toBeNull();
  });

  it("str / nonEmptyStr / num narrow types", () => {
    expect(str("x")).toBe("x");
    expect(str(1)).toBeUndefined();
    expect(nonEmptyStr("x")).toBe("x");
    expect(nonEmptyStr("")).toBeUndefined();
    expect(num(3)).toBe(3);
    expect(num("3")).toBeUndefined();
  });

  it("unwrap returns the first present key's value, else the input", () => {
    expect(unwrap({ actor: { id: 1 } }, ["character", "actor"])).toEqual({ id: 1 });
    expect(unwrap({ other: 1 }, ["character", "actor"])).toEqual({ other: 1 });
    expect(unwrap("scalar", ["actor"])).toBe("scalar");
  });

  it("toArray returns an array directly, the first array key, else []", () => {
    expect(toArray([1, 2], ["items"])).toEqual([1, 2]);
    expect(toArray({ items: [3] }, ["data", "items"])).toEqual([3]);
    expect(toArray({ nope: 1 }, ["items"])).toEqual([]);
  });
});
