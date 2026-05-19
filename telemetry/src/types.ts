// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

// PII brand: any data the operator treats as personally identifying carries
// this marker. Code that handles PII<T> values is statically distinguishable.
// Per ADR-0010, this lives in the shared types package long-term; the
// telemetry package re-declares it here so the type-level rejection in
// analytics works without circular workspace dependencies during alpha.
declare const piiBrand: unique symbol;
export type PII<T> = T & { readonly [piiBrand]: true };

// Helper to brand a value as PII for use in tests and at trust boundaries.
// Runtime is a no-op cast; the brand only exists at the type level.
export function asPII<T>(value: T): PII<T> {
  return value as PII<T>;
}

// NoPII<T> rejects any value that carries the PII brand, recursively.
// A property typed as PII<string> in T turns into `never` in NoPII<T>,
// which makes the surrounding object un-assignable.
export type NoPII<T> =
  T extends PII<unknown>
    ? never
    : T extends ReadonlyArray<infer U>
      ? ReadonlyArray<NoPII<U>>
      : T extends object
        ? { [K in keyof T]: NoPII<T[K]> }
        : T;

export type EventName = `${string}.${string}`;

export interface EventDef<Props> {
  readonly v: number;
  readonly description: string;
  // Phantom property carrying the type of the event's payload.
  // The runtime value is the empty object; the type is what matters.
  readonly props: Props;
}

export type EventRegistry = Readonly<Record<EventName, EventDef<unknown>>>;
