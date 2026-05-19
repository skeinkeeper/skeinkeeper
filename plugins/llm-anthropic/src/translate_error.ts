// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import Anthropic from "@anthropic-ai/sdk";
import type { LLMErrorInfo, LLMErrorKind } from "@skeinkeeper/orchestrator";

/**
 * Pre-flight translation error — thrown by `translateRequest` when the
 * provider-neutral LLMRequest contains content this provider can't render
 * (e.g., audio content with no transcript, since Anthropic doesn't accept
 * audio input). Distinct from runtime SDK errors so callers see a clear
 * `invalid_request` kind rather than a generic `unknown`.
 *
 * Per design doc 0010 § "Provider behavior."
 */
export class TranslationError extends Error {
  constructor(
    message: string,
    readonly errorKind: LLMErrorKind = "invalid_request",
  ) {
    super(message);
    this.name = "TranslationError";
  }
}

/**
 * Map an arbitrary error from the Anthropic SDK (or below) to our structured
 * LLMErrorInfo. Per design doc 0008 § "Errors": no silent retries; the
 * orchestrator's turn loop decides retry policy.
 */
export function translateError(err: unknown): LLMErrorInfo {
  if (err instanceof TranslationError) {
    return { kind: err.errorKind, message: err.message };
  }

  // AbortError from a fetch signal, or our own cancellation path.
  if (err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError")) {
    return { kind: "cancelled", message: err.message };
  }

  if (err instanceof Anthropic.APIUserAbortError) {
    return { kind: "cancelled", message: err.message };
  }

  if (err instanceof Anthropic.RateLimitError) {
    const info: LLMErrorInfo = { kind: "rate_limited", message: err.message };
    const headers = (err as unknown as { headers?: Record<string, string> }).headers;
    const retryAfter = headers?.["retry-after"];
    if (retryAfter) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (!Number.isNaN(seconds)) info.retryAfterMs = seconds * 1000;
    }
    return info;
  }

  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return { kind: "auth", message: err.message };
  }

  if (err instanceof Anthropic.BadRequestError) {
    return { kind: "invalid_request", message: err.message };
  }

  if (err instanceof Anthropic.APIConnectionError) {
    return { kind: "network", message: err.message };
  }

  // 529 = Overloaded; surfaced through several SDK subclasses depending on
  // version. Fall through to status check.
  if (err instanceof Anthropic.APIError) {
    if (err.status === 529) return { kind: "overloaded", message: err.message };
    return { kind: "unknown", message: err.message };
  }

  if (err instanceof Error) {
    return { kind: "unknown", message: err.message };
  }

  return { kind: "unknown", message: String(err) };
}
