// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { parseChatConvention } from "./convention.js";

describe("parseChatConvention", () => {
  it("marks !ooc as ooc", () => {
    expect(parseChatConvention("!ooc let's break for snacks")).toBe("ooc");
  });

  it("marks ((parens)) as ooc", () => {
    expect(parseChatConvention("((my player saw that))")).toBe("ooc");
  });

  it("leaves plain IC text untagged", () => {
    expect(parseChatConvention("I open the door")).toBeUndefined();
  });

  it("marks the configured wake phrase as ic", () => {
    expect(parseChatConvention("Hey DM I open the door", { wakePhrase: "Hey DM" })).toBe("ic");
  });
});
