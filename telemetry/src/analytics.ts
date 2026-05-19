// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { PostHog } from "posthog-node";
import type { Events } from "./events.js";
import type { NoPII } from "./types.js";

export interface AnalyticsConfig {
  /** True only if the operator has explicitly enabled analytics. */
  enabled: boolean;
  /** Opaque rotating token; never derived from operator identity. */
  installationId: string;
  posthogKey?: string;
  posthogHost?: string;
}

export interface AnalyticsClient {
  track<N extends keyof Events>(name: N, props: NoPII<Events[N]["props"]>): void;
  flush(): Promise<void>;
}

class NoopAnalytics implements AnalyticsClient {
  track<N extends keyof Events>(_name: N, _props: NoPII<Events[N]["props"]>): void {
    // Intentional no-op: telemetry is off.
  }
  async flush(): Promise<void> {
    // No client to flush.
  }
}

class PostHogAnalytics implements AnalyticsClient {
  constructor(
    private readonly client: PostHog,
    private readonly installationId: string,
  ) {}

  track<N extends keyof Events>(name: N, props: NoPII<Events[N]["props"]>): void {
    this.client.capture({
      distinctId: this.installationId,
      event: name as string,
      properties: props as Record<string, unknown>,
    });
  }

  async flush(): Promise<void> {
    await this.client.shutdown();
  }
}

export function createAnalytics(config: AnalyticsConfig): AnalyticsClient {
  if (!config.enabled || !config.posthogKey) return new NoopAnalytics();
  const client = new PostHog(config.posthogKey, {
    host: config.posthogHost ?? "https://us.i.posthog.com",
    flushAt: 20,
    flushInterval: 10_000,
  });
  return new PostHogAnalytics(client, config.installationId);
}
