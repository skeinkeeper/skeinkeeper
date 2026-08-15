// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { DM_ONLY_MARKER } from "./summary.js";
import type { FindingKind, IntakeFinding, IntakeOperatorPayload } from "./types.js";

const SECTION_TITLE: Record<FindingKind, string> = {
  "critical-gap": "Critical",
  ambiguity: "I need a decision",
  recommendation: "For your info",
};

const SECTION_ORDER: FindingKind[] = ["critical-gap", "ambiguity", "recommendation"];

export function formatIntakeReportForOperator(
  findings: ReadonlyArray<IntakeFinding>,
): IntakeOperatorPayload {
  if (findings.length === 0) {
    return { text: "", findings: [], delivery: "notify_operator", dmOnly: false };
  }

  const groups = new Map<FindingKind, IntakeFinding[]>();
  for (const f of findings) {
    const list = groups.get(f.kind) ?? [];
    list.push(f);
    groups.set(f.kind, list);
  }

  const parts: string[] = ["Intake report"];
  for (const kind of SECTION_ORDER) {
    const list = groups.get(kind);
    if (list === undefined || list.length === 0) continue;
    parts.push("", `## ${SECTION_TITLE[kind]}`);
    for (const f of list) parts.push(renderFinding(f));
  }

  return {
    text: parts.join("\n").trim(),
    findings: [...findings],
    delivery: "notify_operator",
    dmOnly: findings.some((f) => f.dmOnly),
  };
}

function renderFinding(f: IntakeFinding): string {
  const lines: string[] = [`- ${f.summary}`];
  if (f.detail !== undefined && f.detail.length > 0) {
    if (f.dmOnly) lines.push(`  ${DM_ONLY_MARKER}`);
    lines.push(`  ${f.detail}`);
  } else if (f.dmOnly) {
    lines.push(`  ${DM_ONLY_MARKER}`);
  }
  if (f.resolution !== undefined && f.resolution.options.length > 0) {
    f.resolution.options.forEach((opt, i) => {
      lines.push(`  ${i + 1}. ${opt.label}`);
    });
    if (f.id !== undefined) {
      const first = f.resolution.options[0]!;
      lines.push(`  Resolve: /skeinkeeper intake resolve ${f.id} <option-id>`);
      // Include a concrete example using the first option so operators can copy it.
      lines.push(`  e.g. /skeinkeeper intake resolve ${f.id} ${first.id}`);
    }
  }
  return lines.join("\n");
}
