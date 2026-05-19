// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { ErasureScope } from "./erasure.js";

export interface ExportAdapter {
  readonly name: string;
  readonly supportedScopes: ReadonlyArray<ErasureScope["kind"]>;
  export(scope: ErasureScope): Promise<ExportPayload>;
}

export interface ExportPayload {
  /** Structured data destined for the JSON archive. Plain serializable objects only. */
  data: unknown;
  /** Optional human-readable summary lines surfaced in the HTML summary page. */
  summary?: ReadonlyArray<string>;
}

export interface ExportBundle {
  scope: ErasureScope;
  generatedAt: number;
  perAdapter: Record<string, unknown>;
  summary: ReadonlyArray<{ adapter: string; lines: ReadonlyArray<string> }>;
}

export class ExportService {
  private readonly adapters: ExportAdapter[] = [];

  register(adapter: ExportAdapter): void {
    this.adapters.push(adapter);
  }

  async export(scope: ErasureScope): Promise<ExportBundle> {
    const applicable = this.adapters.filter((a) => a.supportedScopes.includes(scope.kind));
    const perAdapter: Record<string, unknown> = {};
    const summary: Array<{ adapter: string; lines: ReadonlyArray<string> }> = [];

    for (const adapter of applicable) {
      const payload = await adapter.export(scope);
      perAdapter[adapter.name] = payload.data;
      summary.push({ adapter: adapter.name, lines: payload.summary ?? [] });
    }

    return { scope, generatedAt: Date.now(), perAdapter, summary };
  }

  renderHtml(bundle: ExportBundle): string {
    const scopeLabel =
      bundle.scope.kind === "player"
        ? `Player ${bundle.scope.subjectId}`
        : bundle.scope.kind === "campaign"
          ? `Campaign ${bundle.scope.campaignId}`
          : `Tenant ${bundle.scope.tenantId}`;
    const generated = new Date(bundle.generatedAt).toISOString();
    const summaryHtml = bundle.summary
      .map(
        (s) =>
          `<section><h2>${escapeHtml(s.adapter)}</h2><ul>${s.lines
            .map((l) => `<li>${escapeHtml(l)}</li>`)
            .join("")}</ul></section>`,
      )
      .join("");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Skeinkeeper export — ${escapeHtml(scopeLabel)}</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.6rem; }
  h2 { font-size: 1.1rem; margin-top: 1.5rem; border-bottom: 1px solid #ccc; padding-bottom: .25rem; }
  pre { background: #f5f5f5; padding: 1rem; overflow: auto; }
  .meta { color: #666; }
</style>
</head>
<body>
<h1>Skeinkeeper export — ${escapeHtml(scopeLabel)}</h1>
<p class="meta">Generated ${escapeHtml(generated)}. Tenant: ${escapeHtml(bundle.scope.tenantId)}.</p>
${summaryHtml || "<p>No data to export.</p>"}
<h2>Full JSON archive</h2>
<pre>${escapeHtml(JSON.stringify(bundle.perAdapter, null, 2))}</pre>
</body>
</html>
`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
