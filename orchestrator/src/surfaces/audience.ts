// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Delivery-time audience (TDD 0034 / ADR-0017). Distinct from the stored
 * string audience (`"table" | "gm" | "player:<hash>"`) used by dialogue and
 * memory — this shape is what `SurfaceRouter.emit` fans out on.
 */
export type Audience = { kind: "table" } | { kind: "player"; playerId: string } | { kind: "gm" };

export function audienceKind(audience: Audience): Audience["kind"] {
  return audience.kind;
}
