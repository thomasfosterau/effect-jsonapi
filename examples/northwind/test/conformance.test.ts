/**
 * The conformance kit, run against the northwind example.
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
import { HttpApiTest } from "effect/http-api";
import { Conformance } from "@thomasfosterau/effect-jsonapi";
import { Api } from "../api.js";
import {
  alfreds,
  beverages,
  chai,
  discardOrder,
  discardProduct,
  exotic,
  nancy,
  NorthwindLive,
  order10248,
  speedy,
  westboro,
} from "../handlers.js";

/**
 * The rules this example is known to break, each with the issue tracking it.
 * Remove an entry when its issue is fixed; the test will tell you to. One
 * entry, #428: `Endpoint.create` answers a resource object of another `type`
 * with 400 (it decodes `data.type` against a literal), where JSON:API requires
 * 409. The read rules have been clean since #169: the handlers of the reads
 * that declare `fields` (`GET /products/:id`, `GET /orders/:id` and `/search`)
 * project `?fields[TYPE]=` with `onResource: Handlers.project(query.fields)`
 * and stamp `jsonapi: Document.v1_1` on every `Handlers.data` / `collection` /
 * `linkage` document.
 */
const KNOWN_FAILURES: ReadonlyArray<readonly [id: string, tracking: string]> = [
  ["spec/status/create-conflict-type", "#428"],
];

/**
 * One id per resource type, each taken from a record the example's store is
 * seeded with, so every rule that resolves `/:type/:id` probes a resource the
 * example holds rather than a 404. Northwind's ids are not uniform — orders
 * start at 10248 and territories are zip codes — so a hard-coded `"1"` for
 * every type silently probed absent resources (#301).
 */
const IDS = {
  categories: beverages.id,
  suppliers: exotic.id,
  shippers: speedy.id,
  customers: alfreds.id,
  territories: westboro.id,
  employees: nancy.id,
  products: chai.id,
  orders: order10248.id,
};

/**
 * The write fixture: payloads the example accepts, updates it must apply, and
 * the cleanup for whatever the write rules create. Product names are unique per
 * run because the example rejects a duplicate product name.
 */
let sequence = 0;
const WRITES: Conformance.Options["writes"] = {
  products: {
    create: () => ({
      type: "products",
      attributes: {
        name: `Conformance Probe ${++sequence}`,
        unitPrice: 1,
        unitsInStock: 0,
        discontinued: false,
      },
      relationships: {
        category: { data: { type: "categories", id: IDS.categories } },
        supplier: { data: { type: "suppliers", id: IDS.suppliers } },
      },
    }),
    update: () => ({ attributes: { unitsInStock: 10 } }),
    cleanup: discardProduct,
  },
  orders: {
    create: () => ({
      type: "orders",
      attributes: {
        orderDate: "2024-01-01T00:00:00.000Z",
        requiredDate: "2024-01-15T00:00:00.000Z",
        freight: 1,
        shipCountry: "Australia",
      },
      relationships: {
        customer: { data: { type: "customers", id: IDS.customers } },
        employee: { data: { type: "employees", id: IDS.employees } },
      },
    }),
    update: () => ({ attributes: { shipCity: "Melbourne" } }),
    cleanup: discardOrder,
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

/**
 * Each `IDS` entry fetched through its type's `get` endpoint, as the returned
 * `data.id`, or `did not resolve: …` with the error when the fetch fails.
 */
const resolveSamples = Effect.fn("resolveSamples")(function* () {
  const client = yield* HttpApiTest.groups(Api, [
    "categories",
    "suppliers",
    "shippers",
    "customers",
    "territories",
    "employees",
    "products",
    "orders",
  ]);
  const id = <A extends { readonly data: { readonly id: string } }, E, R>(
    get: Effect.Effect<A, E, R>,
  ) =>
    get.pipe(
      Effect.match({
        onFailure: (error) => `did not resolve: ${String(error)}`,
        onSuccess: (document): string => document.data.id,
      }),
    );
  return yield* Effect.all(
    {
      categories: id(client.categories.get({ params: { id: IDS.categories }, query: {} })),
      suppliers: id(client.suppliers.get({ params: { id: IDS.suppliers }, query: {} })),
      shippers: id(client.shippers.get({ params: { id: IDS.shippers }, query: {} })),
      customers: id(client.customers.get({ params: { id: IDS.customers }, query: {} })),
      territories: id(client.territories.get({ params: { id: IDS.territories }, query: {} })),
      employees: id(client.employees.get({ params: { id: IDS.employees }, query: {} })),
      products: id(client.products.get({ params: { id: IDS.products }, query: {} })),
      orders: id(client.orders.get({ params: { id: IDS.orders }, query: {} })),
    },
    { concurrency: 1 },
  );
});

// The samples are resolved first, against the store as seeded, then the suite
// runs against the same layer.
const { report, resolved } = await Effect.runPromise(
  Effect.all(
    {
      resolved: resolveSamples(),
      report: Conformance.verify(Api, { ids: IDS, mutating: true, writes: WRITES }),
    },
    { concurrency: 1 },
  ).pipe(Effect.provide(NorthwindLive), Effect.scoped) as Effect.Effect<
    { readonly report: Conformance.Report; readonly resolved: Record<keyof typeof IDS, string> },
    never,
    never
  >,
);

describe("northwind: JSON:API conformance", () => {
  it("decided every rule it ran: none died", () => {
    // The message carries the whole report, so a dead rule explains itself
    // alongside its neighbours; the diff names each dead rule and its defect.
    expect(
      died(report),
      `a rule died — a defect, not a finding\n${Conformance.format(report)}`,
    ).toEqual([]);
  });

  it("samples an id the example holds for every resource type", () => {
    // An `ids` entry the example does not hold fails no rule: the read endpoints
    // answer 404, and the rules that resolve `/:type/:id` see less of the api
    // (#301). This is the direct guard: each sample fetched through its own
    // `get` endpoint, independent of how the kit words anything in its report.
    // Keyed by type, so the returned `data.id`s are compared with `IDS` entry by
    // entry and a sample that does not resolve shows up under its type.
    expect(resolved).toEqual(IDS);
  });

  it("sampled only resources the example holds: nothing it read answered 404", () => {
    // A second line of defence behind the direct guard above, over what the kit
    // itself read. An absent sample surfaces only in the notes of rules that
    // passed and the reasons of rules that skipped, so this matches `404` in
    // the kit's wording and checks nothing once that wording changes. It also
    // leans on one rule for every type but orders: today only the skip reason
    // of `spec/links/resource-self-dereferences` (no read endpoint carries a
    // resource `links.self`) lists a 404 per sampled `/:type/:id`. Once a read
    // endpoint carries `links.self`, that rule stops skipping, and an absent
    // territory, say, would pass here unnoticed.
    const remarks = report.outcomes.flatMap((outcome) => {
      if (Predicate.isTagged(outcome, "Passed") && outcome.note !== undefined) {
        return [`${outcome.rule.id}: ${outcome.note}`];
      }
      return Predicate.isTagged(outcome, "Skipped")
        ? [`${outcome.rule.id}: ${outcome.reason}`]
        : [];
    });
    expect(remarks.filter((remark) => /\b404\b/.test(remark))).toEqual([]);
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
    // writes for an order's line items
    // (`/orders/:id/relationships/lineItems`) is served by a declared
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
      // #237: what each create and update answered reads back through the
      // resource's own GET.
      "spec/status/create-read-back",
      "spec/status/update-read-back",
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
        Effect.provide(NorthwindLive),
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
