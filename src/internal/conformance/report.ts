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
import { Array as Arr, Predicate, Result } from "effect";
import type { Disposal, Gap, Outcome, Rule, Tier, WriteRecord } from "./core.js";

/** @internal */
export interface Summary {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  /** Rules that died before reaching a verdict. */
  readonly errored: number;
  readonly findings: number;
  readonly probes: number;
}

/** @internal */
export const summarise = (outcomes: ReadonlyArray<Outcome>): Summary => {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let errored = 0;
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
      case "Errored":
        errored += 1;
        break;
    }
  }
  return { passed, failed, skipped, errored, findings, probes };
};

const MARK = { Passed: "PASS", Failed: "FAIL", Skipped: "SKIP", Errored: "DIED" } as const;

/** The order outcomes are listed in within a tier: what the run could not decide, then what it found. */
const ORDER = ["Errored", "Failed", "Passed", "Skipped"] as const satisfies ReadonlyArray<
  Outcome["_tag"]
>;

/** `" · N died"`, or nothing when no rule died — a run without a defect reads as it always has. */
const died = (errored: number): string => (errored === 0 ? "" : ` · ${errored} died`);

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
    case "Errored":
      lines.push(indent(`not decided — the rule died: ${outcome.message}`, "      "));
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

/** Still on the target as far as the kit knows: nothing it did removed it. */
const remains = (write: WriteRecord): boolean =>
  write.disposal === "left" || write.disposal === "cleanup-failed";

const renderWrite = (write: WriteRecord): ReadonlyArray<string> => [
  `  ${write.type}:${write.id ?? "(id unknown)"}  ${DISPOSAL[write.disposal]}${
    write.detail === undefined ? "" : ` — ${write.detail}`
  }`,
  `      created by ${write.rule}`,
];

/**
 * The audit trail of a run that wrote: every resource the kit created and what
 * became of it — what is still there first, then what is gone, each in
 * creation order. Nothing at all when no write rule ran, so a read-only run's
 * report is unchanged.
 */
const renderWrites = (writes: ReadonlyArray<WriteRecord>): ReadonlyArray<string> =>
  Arr.match(writes, {
    onEmpty: () => [],
    onNonEmpty: (all) => {
      const [gone, remaining] = Arr.partition(all, (write) =>
        remains(write) ? Result.fail(write) : Result.succeed(write),
      );
      return [
        "WRITES",
        `  ${all.length} resource${all.length === 1 ? "" : "s"} created · ${remaining.length} still in place`,
        "",
        ...Arr.flatMap([...remaining, ...gone], renderWrite),
        "",
      ];
    },
  });

/**
 * Renders the whole report. Within each tier the rules that died come first —
 * the run could not decide them, so the report is incomplete there — then
 * failures, because that is what a reader came for; then passes, then the
 * rules that did not run.
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
      `  ${tierSummary.failed} failed${died(tierSummary.errored)} · ${tierSummary.passed} passed · ${tierSummary.skipped} not checked`,
    );
    out.push("");
    const ordered = Arr.flatMap(ORDER, (tag) =>
      Arr.filter(outcomes, (outcome) => Predicate.isTagged(outcome, tag)),
    );
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
    })${died(summary.errored)} · ${summary.passed} passed · ${summary.skipped} not checked · ${report.gaps.length} area${
      report.gaps.length === 1 ? "" : "s"
    } out of scope · ${summary.probes} request${summary.probes === 1 ? "" : "s"} made`,
  );
  return out.join("\n");
};
