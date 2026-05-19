// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { TranslationError, translateError } from "./translate_error.js";

describe("translateError", () => {
  it("maps RateLimitError to rate_limited", () => {
    const err = new Anthropic.RateLimitError(
      429,
      undefined,
      "rate limited",
      new Headers({ "retry-after": "30" }),
    );
    const info = translateError(err);
    expect(info.kind).toBe("rate_limited");
    expect(info.message).toContain("rate limited");
  });

  it("maps AuthenticationError to auth", () => {
    const err = new Anthropic.AuthenticationError(401, undefined, "bad key", new Headers());
    expect(translateError(err).kind).toBe("auth");
  });

  it("maps PermissionDeniedError to auth", () => {
    const err = new Anthropic.PermissionDeniedError(403, undefined, "forbidden", new Headers());
    expect(translateError(err).kind).toBe("auth");
  });

  it("maps BadRequestError to invalid_request", () => {
    const err = new Anthropic.BadRequestError(400, undefined, "bad params", new Headers());
    expect(translateError(err).kind).toBe("invalid_request");
  });

  it("maps APIConnectionError to network", () => {
    const err = new Anthropic.APIConnectionError({ message: "ECONNREFUSED" });
    expect(translateError(err).kind).toBe("network");
  });

  it("maps a 529 APIError to overloaded", () => {
    const err = new Anthropic.APIError(529, undefined, "overloaded", new Headers());
    expect(translateError(err).kind).toBe("overloaded");
  });

  it("maps APIUserAbortError to cancelled", () => {
    const err = new Anthropic.APIUserAbortError();
    expect(translateError(err).kind).toBe("cancelled");
  });

  it("maps a generic AbortError (Error with name AbortError) to cancelled", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(translateError(err).kind).toBe("cancelled");
  });

  it("maps an unknown Error to unknown", () => {
    expect(translateError(new Error("mystery")).kind).toBe("unknown");
  });

  it("maps a thrown non-Error value to unknown", () => {
    expect(translateError("just a string").kind).toBe("unknown");
    expect(translateError("just a string").message).toContain("just a string");
  });

  it("maps a TranslationError to its declared errorKind (defaults to invalid_request)", () => {
    const info = translateError(new TranslationError("audio without transcript"));
    expect(info.kind).toBe("invalid_request");
    expect(info.message).toContain("audio without transcript");
  });

  it("respects a non-default errorKind on TranslationError", () => {
    const info = translateError(new TranslationError("simulated rate-limit pre-flight", "rate_limited"));
    expect(info.kind).toBe("rate_limited");
  });
});
