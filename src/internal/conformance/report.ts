/**
 * The report formatter.
 *
 * A conformance kit that says "OK" manufactures false confidence, so the
 * rendered report always states three things: what was checked and passed, what
 * failed (with the rule text, the spec citation and the request that decided
 * it), and what was *not* checked — rule by rule for skips, area by area for
 * the coverage gaps the kit declares up front.
 *
 * @since 0.15.0
 * @internal
 */
import type { Disposal, Gap, Outcome, Rule, Tier, WriteRecord } from "./core.js";

/** @internal */
export interface Summary {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly findings: number;
  readonly probes: number;
}

/** @internal */
export const summarise = (outcomes: ReadonlyArray<Outcome>): Summary => {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let findings = 0;
  let probes = 0;
  for (const outcome of outcomes) {
    switch (outcome._tag) {
      case "Passed":
        passed += 1;
        probes += outcome.probes;
        break;
      case "Failed":
        failed += 1;
        findings += outcome.findings.length;
        probes += outcome.probes;
        break;
      case "Skipped":
        skipped += 1;
        break;
    }
  }
  return { passed, failed, skipped, findings, probes };
};

const MARK = { Passed: "PASS", Failed: "FAIL", Skipped: "SKIP" } as const;

const TIER_TITLE: Readonly<Record<Tier, string>> = {
  spec: "JSON:API v1.1 — the specification",
  profile: "This package's profile — the filter grammar and library conventions",
};

const indent = (text: string, by: string): string =>
  text
    .split("\n")
    .map((line) => `${by}${line}`)
    .join("\n");

/**
 * Hard-wraps prose at `width`, preserving the leading indent. Rule text is the
 * part of a report a reader actually has to read, so it must not run off the
 * terminal.
 */
const wrap = (text: string, width: number): ReadonlyArray<string> => {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const lines: Array<string> = [];
  let line = "";
  for (const word of words) {
    if (line === "") line = word;
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
};

const header = (rule: Rule, mark: string): string => `${mark}  ${rule.id}`;

const meta = (rule: Rule): string => `${rule.level} · ${rule.section}`;

const renderOutcome = (outcome: Outcome, width: number): string => {
  const lines: Array<string> = [
    header(outcome.rule, MARK[outcome._tag]),
    indent(meta(outcome.rule), "      "),
  ];
  switch (outcome._tag) {
    case "Passed":
      lines.push(indent(`${outcome.probes} probe${outcome.probes === 1 ? "" : "s"}`, "      "));
      if (outcome.note !== undefined) lines.push(indent(outcome.note, "      "));
      break;
    case "Skipped":
      lines.push(indent(`not checked: ${outcome.reason}`, "      "));
      break;
    case "Failed": {
      for (const line of wrap(outcome.rule.requirement, width - 6))
        lines.push(indent(line, "      "));
      lines.push(indent(outcome.rule.reference, "      "));
      for (const found of outcome.findings) {
        lines.push(indent(found.detail, "      · "));
        if (found.probe !== undefined) {
          const headers = Object.entries(found.probe.headers)
            .map(([name, value]) => `${name}: ${value}`)
            .join(", ");
          lines.push(
            indent(
              `${found.probe.method} ${found.probe.url}${headers === "" ? "" : `  [${headers}]`}`,
              "        ",
            ),
          );
          if (found.probe.body !== undefined) {
            lines.push(indent(`body: ${JSON.stringify(found.probe.body)}`, "        "));
          }
        }
        lines.push(indent(`expected: ${found.expected}`, "        "));
        lines.push(indent(`observed: ${found.observed}`, "        "));
      }
      break;
    }
  }
  return lines.join("\n");
};

const DISPOSAL: Readonly<Record<Disposal, string>> = {
  deleted: "deleted by the kit's DELETE probe",
  "cleaned-up": "removed by cleanup",
  "cleanup-failed": "CLEANUP FAILED",
  left: "LEFT IN PLACE",
};

/**
 * The audit trail of a run that wrote: every resource the kit created and what
 * became of it, with what is still there called out first. Nothing at all when
 * no write rule ran, so a read-only run's report is unchanged.
 */
const renderWrites = (writes: ReadonlyArray<WriteRecord>): ReadonlyArray<string> => {
  if (writes.length === 0) return [];
  const remaining = writes.filter(
    (write) => write.disposal === "left" || write.disposal === "cleanup-failed",
  ).length;
  const out: Array<string> = [
    "WRITES",
    `  ${writes.length} resource${writes.length === 1 ? "" : "s"} created · ${remaining} still in place`,
    "",
  ];
  for (const write of writes) {
    const detail = write.detail === undefined ? "" : ` — ${write.detail}`;
    out.push(`  ${write.type}:${write.id ?? "(no id)"}  ${DISPOSAL[write.disposal]}${detail}`);
    out.push(`      created by ${write.rule}`);
  }
  out.push("");
  return out;
};

/**
 * Renders the whole report. Failures first within each tier, because that is
 * what a reader came for; then passes, then the rules that did not run.
 *
 * @internal
 */
export const format = (
  report: {
    readonly target: string;
    readonly transport: string;
    readonly version: string;
    readonly outcomes: ReadonlyArray<Outcome>;
    readonly gaps: ReadonlyArray<Gap>;
    readonly writes?: ReadonlyArray<WriteRecord> | undefined;
  },
  options?: { readonly width?: number | undefined },
): string => {
  const width = options?.width ?? 96;
  const summary = summarise(report.outcomes);
  const out: Array<string> = [];
  out.push(`JSON:API conformance — ${report.target}`);
  out.push(`  target: JSON:API v${report.version} · transport: ${report.transport}`);
  out.push("");

  for (const tier of ["spec", "profile"] as const) {
    const outcomes = report.outcomes.filter((outcome) => outcome.rule.tier === tier);
    if (outcomes.length === 0) continue;
    const tierSummary = summarise(outcomes);
    out.push(`${TIER_TITLE[tier].toUpperCase()}`);
    out.push(
      `  ${tierSummary.failed} failed · ${tierSummary.passed} passed · ${tierSummary.skipped} not checked`,
    );
    out.push("");
    const ordered = [
      ...outcomes.filter((outcome) => outcome._tag === "Failed"),
      ...outcomes.filter((outcome) => outcome._tag === "Passed"),
      ...outcomes.filter((outcome) => outcome._tag === "Skipped"),
    ];
    for (const outcome of ordered) {
      out.push(indent(renderOutcome(outcome, width), "  "));
      out.push("");
    }
  }

  out.push(...renderWrites(report.writes ?? []));

  out.push("NOT COVERED BY THIS KIT");
  if (report.gaps.length === 0) {
    out.push("  (none declared)");
  } else {
    out.push("  Areas the kit does not check at all. A rule that is absent here and");
    out.push("  absent above is simply unwritten — treat this list as the kit's own");
    out.push("  statement of its limits, not as a complete account of the specification.");
    out.push("");
    for (const gap of report.gaps) {
      out.push(`  · ${gap.area}`);
      for (const line of wrap(gap.reason, width - 6)) out.push(indent(line, "      "));
      if (gap.tracking.length > 0)
        out.push(indent(`tracking: ${gap.tracking.join(", ")}`, "      "));
    }
  }
  out.push("");
  out.push(
    `SUMMARY  ${summary.failed} rule${summary.failed === 1 ? "" : "s"} failed (${summary.findings} finding${
      summary.findings === 1 ? "" : "s"
    }) · ${summary.passed} passed · ${summary.skipped} not checked · ${report.gaps.length} area${
      report.gaps.length === 1 ? "" : "s"
    } out of scope · ${summary.probes} request${summary.probes === 1 ? "" : "s"} made`,
  );
  return out.join("\n");
};
