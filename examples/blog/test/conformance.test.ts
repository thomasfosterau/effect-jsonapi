/**
 * The conformance kit, run against the blog example.
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
import { BlogLive, discardArticle } from "../handlers.js";

/**
 * The rules this example is known to break, each with the issue tracking it.
 * Remove an entry when its issue is fixed; the test will tell you to. The read
 * rules have been clean since #169: the handlers of the reads that declare
 * `fields` (`GET /articles/:id`, `/search` and, since #485,
 * `GET /articles/:id/relationships/tags`) project `?fields[TYPE]=` with
 * `onResource: Handlers.project(query.fields)` and stamp `jsonapi:
 * Document.v1_1` on every `Handlers.data` / `collection` / `linkage` document
 * (the `Atomic.results` answer carries none). The write rules have been clean
 * since #428, which answers a resource object of another `type` with 409, and
 * #450, which answers a client-generated id `Endpoint.create` does not
 * support with 403 — as #464 does one on an atomic `add`.
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
    // The blog mints its own ids, so a client-generated one must be refused (#450).
    clientId: { supported: false, id: () => `conformance-client-${++sequence}` },
  },
};

/**
 * The `ids` samples: an article for the read rules, and a comment and a person
 * for the relationship mutation rules to link a created article's `comments`
 * and `author` to.
 */
const IDS = { articles: "1", comments: "5", people: "9" };

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

  it("sampled only resources the example holds: every sample read answered 200", () => {
    // An `ids` entry the example does not hold fails no rule: its `/:type/:id`
    // read answers 404, and every rule that resolves it sees less of the api
    // (#301). `report.samples` records each such read with its status (#319).
    // Keyed by type, so a sample that did not resolve shows up under its type.
    expect(
      Object.fromEntries((report.samples ?? []).map((sample) => [sample.type, sample.status])),
      Conformance.format(report),
    ).toEqual({ articles: 200 });
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

  it("honours an empty sparse fieldset as no fields, on primary data and `included` alike", () => {
    // #488: `?fields[TYPE]=` asks for no fields, not every field, and
    // `Handlers.project` answers it with no attributes.
    const ids = [
      "spec/query/sparse-fieldsets-primary",
      "spec/query/sparse-fieldsets-included",
      "spec/query/sparse-fieldsets-empty",
    ];
    expect(
      ids.map((id) => `${id}: ${report.outcomes.find((o) => o.rule.id === id)?._tag}`),
    ).toEqual(ids.map((id) => `${id}: Passed`));
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

  it("judges the compound relationship document by the compound-document rules", () => {
    // #439: `GET /articles/:id/relationships/tags` declares `include`, so the
    // kit's compound probe asks it for `?include=tags`. Its primary data is
    // the tag identifiers and its `included` the tags they name: full linkage
    // starts from those identifiers, and a tag in both is no duplicate.
    // #483: `GET /articles/:id/relationships/comments`, paginated, declares
    // `include` too, so it is asked for `?include=comments` and answers the
    // comments on its page.
    // #485: it declares `fields` too, so the `included` variant of the
    // sparse-fieldset rule asks it for `?include=tags&fields[tags]=name`.
    const ids = [
      "spec/document/full-linkage",
      "spec/document/no-duplicate-resources",
      "spec/document/included-on-include",
      "spec/query/sparse-fieldsets-included",
    ];
    expect(
      ids.map((id) => `${id}: ${report.outcomes.find((o) => o.rule.id === id)?._tag}`),
    ).toEqual(ids.map((id) => `${id}: Passed`));
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
      "spec/atomic/response-ext-parameter",
      // #164: processing, judged by what the blog stored afterwards. The
      // blog's operations endpoint takes articles and comments, and the one
      // fixture here, `articles`, links only to a person, which no fixture
      // creates, so `lid-resolution` runs its update probe rather than its
      // linkage one: an `add` under a `lid`, then an `update` naming it by
      // that `lid`, read back by the id the blog gave it. `all-or-nothing`
      // lists `/articles` around a request whose last operation names an
      // absent `lid`; `results-order` sends an `add` then a `remove` by `lid`.
      "spec/atomic/all-or-nothing",
      "spec/atomic/lid-resolution",
      "spec/atomic/results-order",
      // #471: an `add` under the fixture's client id, which the blog does not
      // support, answered 403 naming `/atomic:operations/0/data/id` (#464).
      "spec/atomic/add-client-id-unsupported",
      // #429: a created article's `comments` linked to the `ids` comment and
      // unlinked again, each read back through
      // `GET /articles/:id/relationships/comments`. The `author` PATCH has no
      // relationship GET to read back through, so `update-replaces` skips.
      "spec/relationships/add-appends",
      "spec/relationships/remove-deletes",
      // #451: what each of those writes, and the `author` PATCH, answered —
      // the PATCH's 200 linkage judged by what it replaced the linkage with.
      "spec/relationships/write-response",
      // #461: the `author` PATCH and `comments` POST answer 404 for a resource
      // that does not exist.
      "spec/relationships/absent-related-404",
      // #477: a `comments` DELETE, and an atomic `remove` from a created
      // article's `comments`, naming a comment that does not exist succeed —
      // it is already missing from the relationship.
      "spec/relationships/remove-absent-succeeds",
      "spec/atomic/remove-absent-succeeds",
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
