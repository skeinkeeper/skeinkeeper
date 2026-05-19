// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

// PII brand and helpers re-exported from the shared @skeinkeeper/core package
// per ADR-0010 / design 0002. Re-exporting here keeps the telemetry public
// surface ergonomic while the brand lives in core.
export { asPII, type PII, type NoPII } from "@skeinkeeper/core";

export type EventName = `${string}.${string}`;

export interface EventDef<Props> {
  readonly v: number;
  readonly description: string;
  // Phantom property carrying the type of the event's payload.
  // The runtime value is the empty object; the type is what matters.
  readonly props: Props;
}

export type EventRegistry = Readonly<Record<EventName, EventDef<unknown>>>;
