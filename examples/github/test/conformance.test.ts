/**
 * The conformance kit, run against the github example.
 *
 * This is an acceptance gate for the kit as much as for the example. It does
 * **not** assert a clean run: the kit finds real, filed defects here, and
 * pinning the exact set is what keeps both honest — a new failure means a
 * regression in the example, and a disappearing one means a fixed bug whose
 * entry should come off this list.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { Conformance } from "@thomasfosterau/effect-jsonapi"
import { Api } from "../api.js"
import { GitHubLive } from "../handlers.js"

/**
 * The rules this example is known to break, each with the issue tracking it.
 * Remove an entry when its issue is fixed; the test will tell you to.
 */
const KNOWN_FAILURES: ReadonlyArray<readonly [id: string, tracking: string]> = [
  // #147 — `Handlers.buildIncluded` dedupes `included` against itself but not
  // against the primary data, so a resource that is both primary data and an
  // include target is emitted twice in one document. A library defect.
  ["spec/document/no-duplicate-resources", "#147"],
  // #112 landed the mechanism — `onResource: Handlers.project(query.fields)` —
  // but this example's handlers have not adopted it, so `?fields[TYPE]=` still
  // returns every attribute. An example gap now, not a library one.
  ["spec/query/sparse-fieldsets-primary", "#112"],
  ["spec/query/sparse-fieldsets-included", "#112"],
  // #148 — a query parameter named only with a-z that the server does not
  // recognise must be a 400; `Query.schema` ignores unknown keys instead.
  ["spec/query/unknown-query-parameter", "#148"],
  // #103 landed the `jsonapi` option on the document builders, but this
  // example's handlers do not pass it, so no document advertises the version
  // it implements. An example gap now, not a library one.
  ["profile/document/jsonapi-member", "#103"]
]

const IDS = {
  users: "1",
  repositories: "1",
  issues: "1",
  pulls: "1",
  labels: "1",
  issueComments: "1"
}

const report = await Effect.runPromise(
  Conformance.verify(Api, { ids: IDS }).pipe(Effect.provide(GitHubLive), Effect.scoped) as Effect.Effect<
    Conformance.Report,
    never,
    never
  >
)

describe("github: JSON:API conformance", () => {
  it("breaks exactly the rules that are already filed", () => {
    const failing = report.outcomes
      .filter((outcome) => outcome._tag === "Failed")
      .map((outcome) => outcome.rule.id)
      .sort()
    const known = KNOWN_FAILURES.map(([id]) => id).sort()

    if (failing.join("\n") !== known.join("\n")) {
      // Print the whole report so a new failure explains itself.
      console.log(Conformance.format(report))
    }
    expect(failing).toEqual(known)
  })

  it("every failure names a rule, cites its section and shows the request", () => {
    for (const outcome of report.outcomes) {
      if (outcome._tag !== "Failed") continue
      expect(outcome.rule.requirement.length).toBeGreaterThan(20)
      expect(outcome.rule.reference).toMatch(/^https:\/\//)
      for (const finding of outcome.findings) {
        expect(finding.detail).not.toBe("")
        expect(finding.expected).not.toBe("")
        expect(finding.observed).not.toBe("")
      }
    }
  })

  it("actually probed the api rather than skipping its way to a verdict", () => {
    const summary = Conformance.summarise(report)
    expect(summary.probes).toBeGreaterThan(50)
    expect(summary.passed).toBeGreaterThan(15)
  })

  it("renders a report that states what it did not check", () => {
    const text = Conformance.format(report)
    expect(text).toContain("NOT COVERED BY THIS KIT")
    expect(text).toContain("SUMMARY")
    // Skipped rules are named individually, not rolled into the pass count.
    expect(text).toContain("not checked:")
  })

  it("runs the spec tier without the profile tier", async () => {
    const specOnly = await Effect.runPromise(
      Conformance.verify(Api, { ids: IDS, tiers: ["spec"] }).pipe(
        Effect.provide(GitHubLive),
        Effect.scoped
      ) as Effect.Effect<Conformance.Report, never, never>
    )
    expect(specOnly.outcomes.every((outcome) => outcome.rule.tier === "spec")).toBe(true)
    const failing = specOnly.outcomes.filter((outcome) => outcome._tag === "Failed").map((outcome) => outcome.rule.id)
    expect(failing).not.toContain("profile/document/jsonapi-member")
  })
})
