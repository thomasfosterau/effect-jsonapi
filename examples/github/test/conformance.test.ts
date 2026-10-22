/**
 * The conformance kit, run against the github example.
 *
 * This is an acceptance gate for the kit as much as for the example. Rather
 * than assert a clean run, it pins the exact set of rules the example breaks —
 * one today, a library defect — which is what keeps both honest: a new
 * failure means a regression in the example (or a defect to file and pin
 * here), and a disappearing one means a fixed bug whose entry should come
 * off this list.
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect, Predicate } from "effect";
import { Conformance } from "@thomasfosterau/effect-jsonapi";
import { Api } from "../api.js";
import { discardIssue, discardRepository, GitHubLive } from "../handlers.js";

/**
 * The rules this example is known to break, each with the issue tracking it.
 * Remove an entry when its issue is fixed; the test will tell you to. The read
 * rules have been clean since #169: the handlers of the reads that declare
 * `fields` (`GET /repositories/:id`, `GET /issues/:id` and `/search`) project
 * `?fields[TYPE]=` with `onResource: Handlers.project(query.fields)` and stamp
 * `jsonapi: Document.v1_1` on every `Handlers.data` / `collection` / `linkage`
 * document. The write rules have been clean since #428, which answers a
 * resource object of another `type` with 409, and #450, which answers a
 * client-generated id `Endpoint.create` does not support with 403.
 */
const KNOWN_FAILURES: ReadonlyArray<readonly [id: string, tracking: string]> = [];

const IDS = {
  users: "1",
  repositories: "1",
  issues: "1",
  pulls: "1",
  labels: "1",
  issueComments: "1",
};

/**
 * The write fixture: payloads the example accepts, updates it must apply, and
 * the cleanup for whatever the write rules create. Repository names are unique
 * per run because the example rejects a duplicate name for the same owner.
 */
let sequence = 0;
const WRITES: Conformance.Options["writes"] = {
  repositories: {
    create: () => ({
      type: "repositories",
      attributes: {
        name: `conformance-probe-${++sequence}`,
        private: false,
        stargazerCount: 0,
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      relationships: { owner: { data: { type: "users", id: "1" } } },
    }),
    update: () => ({ attributes: { description: "Updated by the conformance kit." } }),
    cleanup: discardRepository,
  },
  issues: {
    create: () => ({
      type: "issues",
      attributes: {
        number: 1000 + ++sequence,
        title: "Opened by the conformance kit",
        body: "",
        state: "open",
        locked: false,
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      relationships: {
        repository: { data: { type: "repositories", id: "1" } },
        author: { data: { type: "users", id: "1" } },
      },
    }),
    update: () => ({ attributes: { state: "closed" } }),
    cleanup: discardIssue,
    // The example mints its own ids, so a client-generated one must be refused (#450).
    clientId: { supported: false, id: () => `conformance-client-${++sequence}` },
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
  Conformance.verify(Api, { ids: IDS, mutating: true, writes: WRITES }).pipe(
    Effect.provide(GitHubLive),
    Effect.scoped,
  ) as Effect.Effect<Conformance.Report, never, never>,
);

describe("github: JSON:API conformance", () => {
  it("decided every rule it ran: none died", () => {
    // The message carries the whole report, so a dead rule explains itself
    // alongside its neighbours; the diff names each dead rule and its defect.
    expect(
      died(report),
      `a rule died — a defect, not a finding\n${Conformance.format(report)}`,
    ).toEqual([]);
  });

  it("sampled only resources the example holds: every sample read answered 200", () => {
    // An `ids` entry the example does not hold fails no rule: its `/:type/:id`
    // read answers 404, and every rule that resolves it sees less of the api
    // (#301). `report.samples` records each such read with its status (#319).
    // Keyed by type, so a sample that did not resolve shows up under its type.
    // `labels` and `issueComments` have no `GET /:type/:id` endpoint, so their
    // samples key relationship and related reads only, and record no read.
    expect(
      Object.fromEntries((report.samples ?? []).map((sample) => [sample.type, sample.status])),
      Conformance.format(report),
    ).toEqual({ users: 200, repositories: 200, issues: 200, pulls: 200 });
  });

  it("breaks exactly the rules that are already filed", () => {
    const failing = report.outcomes
      .filter((outcome) => outcome._tag === "Failed")
      .map((outcome) => outcome.rule.id)
      .sort();
    const known = KNOWN_FAILURES.map(([id]) => id).sort();

    // The whole report is the assertion message, so a new failure explains itself.
    expect(failing, Conformance.format(report)).toEqual(known);
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
    // writes for an issue's comments (`/issues/:id/relationships/comments`)
    // is served by a declared `Endpoint.getRelationship`, so both MUSTs pass
    // rather than skip. That relationship is links-only, so the relationship
    // SHOULD has no linkage to compare and skips.
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

  it("judges GET /issues, which speaks the filter grammar, by the profile's own semantics", () => {
    // #433: `GET /issues` declares `filter: true` and advertises the profile,
    // so the filter-profile rules run here rather than only against the kit's
    // canned servers. The evaluation rule decides the empty groups, the
    // ordering operators on `number` (never NULL) and `assignee`, a to-one
    // relationship empty on two of the three issues; the §6.5 corollaries on
    // `assignee` and `include=…` beside a filter (#458) — and says why the
    // rest went undecided: no attribute is ever NULL, and the endpoint
    // declares no `fields[issues]` (deliberately, #322) to send beside a
    // filter. Spelling equivalence runs on `title`, the first string
    // attribute, `number` leading it (#458).
    const outcomeOf = (id: string) => report.outcomes.find((outcome) => outcome.rule.id === id);
    expect(outcomeOf("profile/filter/advertises-profile-uri")?._tag).toBe("Passed");
    expect(outcomeOf("profile/filter/rejections")?._tag).toBe("Passed");
    expect(outcomeOf("profile/filter/spelling-equivalence")?._tag).toBe("Passed");
    expect(outcomeOf("profile/filter/evaluation")).toMatchObject({
      _tag: "Passed",
      probes: 20,
      note: expect.stringMatching(
        /^not decided: F-CMP-1, .* on \/issues: no attribute .*; F-EVAL-6 on \/issues: it declares no `fields\[issues\]`/,
      ),
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
      // #237: what each create and update answered reads back through the
      // resource's own GET.
      "spec/status/create-read-back",
      "spec/status/update-read-back",
      // #429: a created issue's `labels` replaced with, added to and removed
      // from by the `ids` label, each read back through
      // `GET /issues/:id/relationships/labels`. The `assignee` PATCH has no
      // relationship GET to read back through, so is not decided.
      "spec/relationships/update-replaces",
      "spec/relationships/add-appends",
      "spec/relationships/remove-deletes",
      // #451: what each of those writes, and the `assignee` PATCH, answered.
      // `update-to-one-null` is not decided: `assignee` has no relationship
      // GET to read the cleared linkage back through.
      "spec/relationships/write-response",
      // #461: the `assignee` and `labels` writes answer 404 for a resource
      // that does not exist.
      "spec/relationships/absent-related-404",
      // #477: a `labels` DELETE naming a label that does not exist succeeds —
      // it is already missing from the relationship.
      "spec/relationships/remove-absent-succeeds",
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
      Conformance.verify(Api, { ids: IDS, tiers: ["spec"] }).pipe(
        Effect.provide(GitHubLive),
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
