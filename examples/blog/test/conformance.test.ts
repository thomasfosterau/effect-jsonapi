/**
 * The conformance kit, run against the blog example.
 *
 * This is an acceptance gate for the kit as much as for the example. Rather
 * than assert a clean run, it pins the exact set of rules the example breaks —
 * none today — which is what keeps both honest: a new failure means a
 * regression in the example (or a defect to file and pin here), and a
 * disappearing one means a fixed bug whose entry should come off this list.
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect, Predicate } from "effect";
import { Conformance } from "@thomasfosterau/effect-jsonapi";
import { Api } from "../api.js";
import { BlogLive, discardArticle } from "../handlers.js";

/**
 * The rules this example is known to break, each with the issue tracking it.
 * Remove an entry when its issue is fixed; the test will tell you to. Empty
 * since #169: the handlers of the reads that declare `fields`
 * (`GET /articles/:id` and `/search`) project `?fields[TYPE]=` with
 * `onResource: Handlers.project(query.fields)` and stamp
 * `jsonapi: Document.v1_1` on every `Handlers.data` / `collection` / `linkage`
 * document (the `Atomic.results` answer carries none).
 */
const KNOWN_FAILURES: ReadonlyArray<readonly [id: string, tracking: string]> = [];

/**
 * The write fixture: a payload the blog accepts, an update it must apply, and
 * the cleanup for whatever the write rules create. Titles are unique per run
 * because the blog rejects a duplicate title with 409.
 */
let sequence = 0;
const WRITES: Conformance.Options["writes"] = {
  articles: {
    create: () => ({
      type: "articles",
      attributes: {
        title: `conformance probe ${++sequence}`,
        body: "Created by the conformance kit.",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      relationships: { author: { data: { type: "people", id: "9" } } },
    }),
    update: () => ({ attributes: { title: `conformance probe ${++sequence} (updated)` } }),
    cleanup: discardArticle,
  },
};

/**
 * The rules that died in a run, each as `id: message`. A rule that dies — a
 * defect in the kit or its transport, not a finding about this example — is an
 * `Errored` outcome rather than a failed run (#246), so nothing that filters
 * for `Failed` sees it; every run here is checked with this.
 */
const died = (run: Conformance.Report): ReadonlyArray<string> =>
  run.outcomes.flatMap((outcome) =>
    Predicate.isTagged(outcome, "Errored") ? [`${outcome.rule.id}: ${outcome.message}`] : [],
  );

const report = await Effect.runPromise(
  Conformance.verify(Api, { ids: { articles: "1" }, mutating: true, writes: WRITES }).pipe(
    Effect.provide(BlogLive),
    Effect.scoped,
  ) as Effect.Effect<Conformance.Report, never, never>,
);

describe("blog: JSON:API conformance", () => {
  it("decided every rule it ran: none died", () => {
    // The message carries the whole report, so a dead rule explains itself
    // alongside its neighbours; the diff names each dead rule and its defect.
    expect(
      died(report),
      `a rule died — a defect, not a finding\n${Conformance.format(report)}`,
    ).toEqual([]);
  });

  it("breaks exactly the rules that are already filed", () => {
    const failing = report.outcomes
      .filter((outcome) => outcome._tag === "Failed")
      .map((outcome) => outcome.rule.id)
      .sort();
    const known = KNOWN_FAILURES.map(([id]) => id).sort();

    if (failing.join("\n") !== known.join("\n")) {
      // Print the whole report so a new failure explains itself.
      console.log(Conformance.format(report));
    }
    expect(failing).toEqual(known);
  });

  it("every failure names a rule, cites its section and shows the request", () => {
    for (const outcome of report.outcomes) {
      if (outcome._tag !== "Failed") continue;
      expect(outcome.rule.requirement.length).toBeGreaterThan(20);
      expect(outcome.rule.reference).toMatch(/^https:\/\//);
      for (const finding of outcome.findings) {
        expect(finding.detail).not.toBe("");
        expect(finding.expected).not.toBe("");
        expect(finding.observed).not.toBe("");
      }
    }
  });

  it("actually probed the api rather than skipping its way to a verdict", () => {
    const summary = Conformance.summarise(report);
    expect(summary.probes).toBeGreaterThan(50);
    expect(summary.passed).toBeGreaterThan(15);
  });

  it("follows every relationship's and document's `self` link to a verdict", () => {
    // #309: the relationship `self` link `Handlers.paginatedRelationship`
    // writes for an article's comments is served by a declared
    // `Endpoint.getRelationship`, so both MUSTs pass rather than skip. That
    // relationship is links-only, so the relationship SHOULD has no linkage to
    // compare and skips.
    const ids = [
      "spec/links/relationship-self-dereferences",
      "spec/links/relationship-self-matches-linkage",
      "spec/links/top-level-self-dereferences",
      "spec/links/top-level-self-matches-document",
    ];
    const outcomeOf = (id: string) => report.outcomes.find((outcome) => outcome.rule.id === id);
    expect(ids.map((id) => `${id}: ${outcomeOf(id)?._tag}`)).toEqual([
      "spec/links/relationship-self-dereferences: Passed",
      "spec/links/relationship-self-matches-linkage: Skipped",
      "spec/links/top-level-self-dereferences: Passed",
      "spec/links/top-level-self-matches-document: Passed",
    ]);
    // Skipped for want of linkage, not for want of a link to follow.
    expect(outcomeOf("spec/links/relationship-self-matches-linkage")).toMatchObject({
      reason: expect.stringContaining("carries both a `self` link and resource linkage"),
    });
  });

  it("ran the write rules against targets it created, and left nothing behind", () => {
    const writeRules = [
      "spec/status/create-response-document",
      // #236: the 201 carries `Location`, copied from the created resource's
      // own `links.self`, so the two match.
      "spec/status/create-location",
      "spec/status/create-location-matches-self",
      "spec/status/update-response",
      "spec/status/delete-response",
      "spec/atomic/response-ext-parameter",
    ];
    expect(
      writeRules.map((id) => report.outcomes.find((outcome) => outcome.rule.id === id)?._tag),
    ).toEqual(writeRules.map(() => "Passed"));
    const writes = report.writes ?? [];
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.map((write) => write.disposal)).toEqual(
      writes.map(() => expect.stringMatching(/^(deleted|cleaned-up)$/)),
    );
  });

  it("renders a report that states what it did not check", () => {
    const text = Conformance.format(report);
    expect(text).toContain("NOT COVERED BY THIS KIT");
    expect(text).toContain("SUMMARY");
    // Skipped rules are named individually, not rolled into the pass count.
    expect(text).toContain("not checked:");
  });

  it("runs the spec tier without the profile tier", async () => {
    const specOnly = await Effect.runPromise(
      Conformance.verify(Api, { ids: { articles: "1" }, tiers: ["spec"] }).pipe(
        Effect.provide(BlogLive),
        Effect.scoped,
      ) as Effect.Effect<Conformance.Report, never, never>,
    );
    expect(specOnly.outcomes.every((outcome) => outcome.rule.tier === "spec")).toBe(true);
    expect(
      died(specOnly),
      `a rule died — a defect, not a finding\n${Conformance.format(specOnly)}`,
    ).toEqual([]);
    const failing = specOnly.outcomes
      .filter((outcome) => outcome._tag === "Failed")
      .map((outcome) => outcome.rule.id);
    expect(failing).not.toContain("profile/document/jsonapi-member");
  });
});
