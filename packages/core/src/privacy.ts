// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

// PII brand: any data the operator treats as personally identifying carries
// this marker. Code that handles PII<T> values is statically distinguishable
// from code that doesn't. Per ADR-0010.

declare const piiBrand: unique symbol;
export type PII<T> = T & { readonly [piiBrand]: true };

// Brand a value as PII. Runtime is a no-op cast; the brand only exists at
// the type level.
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
