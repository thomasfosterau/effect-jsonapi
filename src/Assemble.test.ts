/**
 * The document assembler, pinned against the consuming applications'
 * assembler corpus: the envelope shape, link coercion, the capability meta,
 * sparse fieldsets, the collection's pagination math, the `included` walk
 * with its whitelist / depth guards and its batching, and the §8.4
 * relationship document.
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect, Exit, Record as R, Schema } from "effect";
import * as ApiError from "./ApiError.js";
import * as Assemble from "./Assemble.js";
import type * as Handlers from "./Handlers.js";
import * as Query from "./Query.js";

interface User {
  readonly id: string;
  readonly role: "user" | "editor" | "admin";
}
const ADMIN: User = { id: "u-admin", role: "admin" };
const EDITOR: User = { id: "u-editor", role: "editor" };
const NON_ADMIN: User = { id: "u-user", role: "user" };

/** The reference-data rule: admins write, everyone else reads. */
const adminCapabilities = Assemble.roleCapabilities(
  (viewer: User | null | undefined) => viewer?.role === "admin",
);

/** The applications' family rule: political types by role, ingested types never. */
const POLITICAL = new Set(["people", "places"]);
const familyCapabilities: Assemble.CapabilitiesHook<User | null> = (resource, viewer) =>
  POLITICAL.has(resource.type)
    ? adminCapabilities(resource, viewer)
    : { canEdit: false, canDelete: false };

const person = (id: string): Assemble.ResourceLike => ({
  type: "people",
  id,
  attributes: {
    name: `Person ${id}`,
    slug: `person-${id}`,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  },
  relationships: {
    birthPlace: {
      data: { type: "places", id: "place-1" },
      links: { related: new URL(`https://example.test/people/${id}/birthPlace`) },
    },
    officeHoldings: {
      data: [],
      links: { related: `https://example.test/people/${id}/officeHoldings` },
    },
  },
  links: { self: new URL(`https://example.test/people/${id}`) },
});

const contest = (id: string): Assemble.ResourceLike => ({
  type: "contests",
  id,
  attributes: { name: `Contest ${id}` },
  relationships: {
    election: { data: { type: "elections", id: "election-1" } },
    candidates: {
      data: [
        { type: "candidates", id: "c-1" },
        { type: "candidates", id: "c-2" },
      ],
    },
  },
  links: { self: `https://example.test/contests/${id}` },
});

const place: Assemble.ResourceLike = {
  type: "places",
  id: "place-1",
  attributes: { name: "Sydney" },
};
const election: Assemble.ResourceLike = {
  type: "elections",
  id: "election-1",
  attributes: { name: "House" },
  relationships: { electionEvent: { data: { type: "election-events", id: "event-1" } } },
};
const event: Assemble.ResourceLike = { type: "election-events", id: "event-1", attributes: {} };
const candidate = (id: string, party?: string): Assemble.ResourceLike => ({
  type: "candidates",
  id,
  attributes: {},
  ...(party === undefined
    ? {}
    : { relationships: { party: { data: { type: "parties", id: party } } } }),
});
const party = (id: string): Assemble.ResourceLike => ({ type: "parties", id, attributes: {} });

/** A loader registry over a fixed set of resources, recording every call. */
const registry = (known: ReadonlyArray<Assemble.ResourceLike>) => {
  const calls: Array<{ type: string; ids: ReadonlyArray<string> }> = [];
  const target =
    (type: string): Handlers.IncludeTarget =>
    (ids) =>
      Effect.sync(() => {
        calls.push({ type, ids });
        return known.filter(
          (r) => r.type === type && ids.includes(r.id),
        ) as ReadonlyArray<Handlers.ResourceValue>;
      });
  const targets = Object.fromEntries(
    [...new Set(known.map((r) => r.type))].map((type) => [type, target(type)]),
  ) satisfies Handlers.IncludeTargets;
  return { calls, targets };
};

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

// A free-form resource read from JSON text, as a handler gets one from a
// database driver, and the JSON text a value serialises to.
const OpenRecord = Schema.Record(Schema.String, Schema.Unknown);
const parseResource = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.String,
      id: Schema.String,
      attributes: OpenRecord,
      meta: Schema.optionalKey(OpenRecord),
    }),
  ),
);
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const ids = (resources: ReadonlyArray<Assemble.ResourceLike> | undefined) =>
  resources?.map((r) => `${r.type}:${r.id}`);

describe("Assemble.resource", () => {
  it("wraps a resource in a JSON:API document with the jsonapi member and a self link", async () => {
    const document = await run(Assemble.resource(person("p1")));
    expect(document.jsonapi).toEqual({ version: "1.1" });
    expect(document.data.type).toBe("people");
    expect(document.data.id).toBe("p1");
    expect(document.links?.self).toBe("https://example.test/people/p1");
    expect(document.data.attributes["name"]).toBe("Person p1");
  });

  it("coerces URL `links.self` and relationship `links.related` to wire strings", async () => {
    const document = await run(Assemble.resource(person("p1")));
    expect(typeof document.data.links?.self).toBe("string");
    const rels = document.data.relationships as Record<string, { links: { related: unknown } }>;
    expect(rels["birthPlace"]?.links.related).toBe("https://example.test/people/p1/birthPlace");
    expect(rels["officeHoldings"]?.links.related).toBe(
      "https://example.test/people/p1/officeHoldings",
    );
  });

  it("stamps canEdit / canDelete per the hook: true for an admin, false for everyone else", async () => {
    const stamped = (viewer: User | null) =>
      run(Assemble.resource(person("p1"), { viewer, capabilities: familyCapabilities }));
    expect((await stamped(ADMIN)).data.meta).toEqual({ canEdit: true, canDelete: true });
    expect((await stamped(NON_ADMIN)).data.meta).toEqual({ canEdit: false, canDelete: false });
    expect((await stamped(EDITOR)).data.meta).toEqual({ canEdit: false, canDelete: false });
    expect((await stamped(null)).data.meta).toEqual({ canEdit: false, canDelete: false });
  });

  it("keys the rule off the resource type, so an ingested family is never editable", async () => {
    const document = await run(
      Assemble.resource(contest("x"), { viewer: ADMIN, capabilities: familyCapabilities }),
    );
    expect(document.data.meta).toEqual({ canEdit: false, canDelete: false });
  });

  it("stamps no meta without a hook, and drops an empty meta for `noCapabilities`", async () => {
    expect((await run(Assemble.resource(person("p1")))).data).not.toHaveProperty("meta");
    const none = await run(
      Assemble.resource(person("p1"), { viewer: ADMIN, capabilities: Assemble.noCapabilities }),
    );
    expect(none.data).not.toHaveProperty("meta");
    // …but a resource's own meta survives, merged under the hook's members.
    const own = await run(
      Assemble.resource(
        { ...person("p1"), meta: { score: 1 } },
        { capabilities: adminCapabilities },
      ),
    );
    expect(own.data.meta).toEqual({ score: 1, canEdit: false, canDelete: false });
  });

  it("applies sparse fieldset projection to attributes, by type", async () => {
    const projected = await run(Assemble.resource(person("p1"), { fields: { people: ["name"] } }));
    expect(Object.keys(projected.data.attributes)).toEqual(["name"]);
    const untouched = await run(Assemble.resource(person("p1"), { fields: { places: ["name"] } }));
    expect(Object.keys(untouched.data.attributes).length).toBeGreaterThan(1);
  });

  it("omits top-level links when the resource has no self URL", async () => {
    expect((await run(Assemble.resource(place))).links).toBeUndefined();
  });

  it("resolves a to-one include into `included`, capability-stamped per type", async () => {
    const { calls, targets } = registry([place]);
    const document = await run(
      Assemble.resource(person("p1"), {
        viewer: ADMIN,
        capabilities: familyCapabilities,
        include: ["birthPlace"],
        includable: ["birthPlace"],
        targets,
      }),
    );
    expect(calls).toEqual([{ type: "places", ids: ["place-1"] }]);
    expect(document.included).toHaveLength(1);
    expect(document.included?.[0]).toMatchObject({ type: "places", id: "place-1" });
    expect(document.included?.[0]?.meta).toEqual({ canEdit: true, canDelete: true });
  });

  it("resolves a to-many include in one loader call per level", async () => {
    const { calls, targets } = registry([candidate("c-1"), candidate("c-2")]);
    const document = await run(
      Assemble.resource(contest("x"), {
        include: ["candidates"],
        includable: ["candidates"],
        targets,
      }),
    );
    expect(calls).toEqual([{ type: "candidates", ids: ["c-1", "c-2"] }]);
    expect(document.included?.map((r) => r.id)).toEqual(["c-1", "c-2"]);
  });

  it("walks a nested path level by level and drops a ref that does not resolve", async () => {
    const { targets } = registry([election, event]);
    const document = await run(
      Assemble.resource(contest("x"), {
        include: ["election.electionEvent", "candidates"],
        includable: ["election", "election.electionEvent", "candidates"],
        targets,
      }),
    );
    expect(ids(document.included)).toEqual(["elections:election-1", "election-events:event-1"]);
  });

  it("walks a second hop off a to-many head, hoisting the whole level, deduplicated", async () => {
    const { calls, targets } = registry([
      candidate("c-1", "party-1"),
      candidate("c-2", "party-1"),
      party("party-1"),
    ]);
    const document = await run(
      Assemble.resource(contest("x"), {
        include: ["candidates.party"],
        includable: ["candidates", "candidates.party"],
        targets,
      }),
    );
    expect(ids(document.included)).toEqual(["candidates:c-1", "candidates:c-2", "parties:party-1"]);
    // Two candidates sharing one party is one read of that party, not two.
    expect(calls.filter((call) => call.type === "parties")).toEqual([
      { type: "parties", ids: ["party-1"] },
    ]);
  });

  it("emits no `included` when no include is requested", async () => {
    expect(
      await run(Assemble.resource(person("p1"), { includable: ["birthPlace"] })),
    ).not.toHaveProperty("included");
  });

  it("emits `included: []` for `?include=` with no paths: the request carried `include` (#232)", async () => {
    // Presence is the signal: `?include=` decodes to `[]`, and a client that
    // supplied `include`, even empty, gets the compound document's key.
    expect(
      (await run(Assemble.resource(person("p1"), { include: [], includable: ["birthPlace"] })))
        .included,
    ).toEqual([]);
  });

  it("emits `included: []` when include was requested and nothing resolved (#232)", async () => {
    // §Fetching Includes: a response to a request carrying `include` MUST be a
    // compound document with an `included` key, even an empty one.
    const validatedOnly = await run(
      Assemble.resource(person("p1"), { include: ["birthPlace"], includable: ["birthPlace"] }),
    );
    expect(validatedOnly.included).toEqual([]);
    // A registry that cannot resolve the ref: the walk answers `[]`.
    const { calls, targets } = registry([party("party-1")]);
    const unresolved = await run(
      Assemble.resource(person("p1"), {
        include: ["birthPlace"],
        includable: ["birthPlace"],
        targets,
      }),
    );
    expect(calls).toEqual([]);
    expect(unresolved.included).toEqual([]);
  });

  it("rejects an include path outside the whitelist, naming the allowed paths", async () => {
    const exit = await Effect.runPromiseExit(
      Assemble.resource(person("p1"), { include: ["candidacies"], includable: ["birthPlace"] }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Effect.runSync(
      Effect.flip(
        Assemble.resource(person("p1"), { include: ["candidacies"], includable: ["birthPlace"] }),
      ),
    );
    expect(error).toBeInstanceOf(ApiError.UnsupportedIncludePath);
    expect((error as ApiError.UnsupportedIncludePath).includablePaths).toEqual(["birthPlace"]);
  });

  it("rejects a path deeper than the cap as a depth error, before the whitelist", () => {
    const deep = Effect.runSync(
      Effect.flip(Assemble.resource(person("p1"), { include: ["a.b.c.d"], includable: ["a"] })),
    );
    expect(deep).toBeInstanceOf(ApiError.UnsupportedIncludeDepth);
    const shallow = Effect.runSync(
      Effect.flip(
        Assemble.resource(person("p1"), { include: ["a.b"], includable: ["a"], depth: 1 }),
      ),
    );
    expect(shallow).toBeInstanceOf(ApiError.UnsupportedIncludeDepth);
  });

  it("matches the whole dotted path, not just its head", async () => {
    const head = Effect.runSync(
      Effect.flip(
        Assemble.resource(contest("x"), {
          include: ["election.electionEvent"],
          includable: ["election"],
        }),
      ),
    );
    expect(head).toBeInstanceOf(ApiError.UnsupportedIncludePath);
    const { targets } = registry([election, event]);
    const whole = await run(
      Assemble.resource(contest("x"), {
        include: ["election.electionEvent"],
        includable: ["election", "election.electionEvent"],
        targets,
      }),
    );
    expect(ids(whole.included)).toEqual(["elections:election-1", "election-events:event-1"]);
  });
});

describe("Assemble.collection", () => {
  const page = [person("a"), person("b"), person("c")];
  const baseUrl = "https://example.test/people";
  const at = (offset: number, limit: number, totalCount: number) =>
    run(Assemble.collection(page, { totalCount, offset, limit, baseUrl }));

  it("populates meta.totalCount and the jsonapi member", async () => {
    const document = await at(0, 10, 42);
    expect(document.meta.totalCount).toBe(42);
    expect(document.jsonapi).toEqual({ version: "1.1" });
  });

  it("builds first-page links without prev, with next", async () => {
    const document = await at(0, 10, 100);
    expect(document.links.first).toContain("page[offset]=0");
    expect(document.links.next).toContain("page[offset]=10");
    expect(document.links.prev).toBeNull();
  });

  it("builds last-page links with prev, without next", async () => {
    const document = await at(20, 10, 25);
    expect(document.links.prev).toContain("page[offset]=10");
    expect(document.links.next).toBeNull();
    expect(document.links.last).toContain("page[offset]=20");
  });

  it("handles an empty collection by pointing last at offset 0", async () => {
    const document = await run(
      Assemble.collection([], { totalCount: 0, offset: 0, limit: 10, baseUrl }),
    );
    expect(document.links.last).toContain("page[offset]=0");
    expect(document.data).toEqual([]);
  });

  it("carries the request's other query pairs into every link, cursor last", async () => {
    const document = await run(
      Assemble.collection(page, {
        totalCount: 3,
        offset: 1,
        limit: 1,
        baseUrl,
        query: [
          ["include", "birthPlace"],
          ["filter[q]", "alpha"],
        ],
      }),
    );
    expect(document.links).toEqual({
      self: "https://example.test/people?include=birthPlace&filter[q]=alpha&page[offset]=1&page[limit]=1",
      first:
        "https://example.test/people?include=birthPlace&filter[q]=alpha&page[offset]=0&page[limit]=1",
      prev: "https://example.test/people?include=birthPlace&filter[q]=alpha&page[offset]=0&page[limit]=1",
      next: "https://example.test/people?include=birthPlace&filter[q]=alpha&page[offset]=2&page[limit]=1",
      last: "https://example.test/people?include=birthPlace&filter[q]=alpha&page[offset]=2&page[limit]=1",
    });
  });

  it("stamps per-viewer meta on every resource in data", async () => {
    const document = await run(
      Assemble.collection(
        page,
        { totalCount: 3, offset: 0, limit: 10, baseUrl },
        { viewer: ADMIN, capabilities: familyCapabilities },
      ),
    );
    for (const resource of document.data) {
      expect(resource.meta).toEqual({ canEdit: true, canDelete: true });
    }
  });

  it("emits pre-resolved included members, link-coerced, and omits the member when empty and unrequested", async () => {
    const withIncluded = await run(
      Assemble.collection(
        page,
        { totalCount: 3, offset: 0, limit: 10, baseUrl },
        {
          included: [{ ...place, links: { self: new URL("https://example.test/places/place-1") } }],
        },
      ),
    );
    expect(withIncluded.included).toHaveLength(1);
    expect(withIncluded.included?.[0]?.links?.self).toBe("https://example.test/places/place-1");
    expect((await at(0, 10, 3)).included).toBeUndefined();
    expect(
      (
        await run(
          Assemble.collection(
            page,
            { totalCount: 3, offset: 0, limit: 10, baseUrl },
            { included: [] },
          ),
        )
      ).included,
    ).toBeUndefined();
    // Members that are all primary data, with no `include` on the request:
    // the dedupe leaves nothing, and there is no request to answer with `[]`.
    expect(
      await run(
        Assemble.collection(
          [person("a"), place],
          { totalCount: 2, offset: 0, limit: 10, baseUrl },
          { included: [place] },
        ),
      ),
    ).not.toHaveProperty("included");
  });

  it("does not repeat a page member in `included` (#147)", async () => {
    // A heterogeneous page: `place-1` is a hit in its own right and the
    // birthplace of the person beside it. The include walk already skips
    // resources the document holds, so it never loads `place-1`; the repeat
    // comes only from the caller's own pre-resolved `included`, which is what
    // the dedupe against primary data has to drop.
    const { calls, targets } = registry([place]);
    const document = await run(
      Assemble.collection(
        [person("a"), place],
        { totalCount: 2, offset: 0, limit: 10, baseUrl },
        { included: [place], include: ["birthPlace"], includable: ["birthPlace"], targets },
      ),
    );
    expect(calls).toEqual([]);
    expect(ids(document.data)).toEqual(["people:a", "places:place-1"]);
    // Every candidate was a hit, but the request carried `include`, so the
    // compound document keeps its `included` key, empty (#232).
    expect(document.included).toEqual([]);
  });

  it("emits `included: []` when include was requested and nothing resolved (#232)", async () => {
    const { calls, targets } = registry([]);
    const document = await run(
      Assemble.collection(
        page,
        { totalCount: 3, offset: 0, limit: 10, baseUrl },
        { include: ["birthPlace"], includable: ["birthPlace"], targets },
      ),
    );
    expect(calls).toEqual([]);
    expect(document.included).toEqual([]);
    // An empty page answers the same way.
    expect(
      (
        await run(
          Assemble.collection(
            [],
            { totalCount: 0, offset: 0, limit: 10, baseUrl },
            { include: ["birthPlace"], includable: ["birthPlace"], targets },
          ),
        )
      ).included,
    ).toEqual([]);
  });

  it("emits `included: []` in validate-only mode: include, no registry (#232)", async () => {
    const pagination = { totalCount: 3, offset: 0, limit: 10, baseUrl };
    expect(
      (
        await run(
          Assemble.collection(page, pagination, {
            include: ["birthPlace"],
            includable: ["birthPlace"],
          }),
        )
      ).included,
    ).toEqual([]);
    // `?include=` with no paths is still a request that carried `include`.
    expect(
      (await run(Assemble.collection(page, pagination, { include: [], includable: [] }))).included,
    ).toEqual([]);
  });

  it("resolves the page's include walk in one batch per target type, deduplicated", async () => {
    const { calls, targets } = registry([place]);
    const document = await run(
      Assemble.collection(
        page,
        { totalCount: 3, offset: 0, limit: 10, baseUrl },
        {
          viewer: NON_ADMIN,
          capabilities: familyCapabilities,
          include: ["birthPlace"],
          includable: ["birthPlace"],
          targets,
        },
      ),
    );
    // Three people share one birthplace: one loader call, one id, one member.
    expect(calls).toEqual([{ type: "places", ids: ["place-1"] }]);
    expect(document.included?.map((r) => r.id)).toEqual(["place-1"]);
    expect(document.included?.[0]?.meta).toEqual({ canEdit: false, canDelete: false });
  });
});

describe("Assemble.unpaginatedCollection", () => {
  const whole = [person("a"), person("b"), person("c")];

  it("emits the whole collection with the jsonapi member and no page math", async () => {
    const document = await run(Assemble.unpaginatedCollection(whole));
    expect(ids(document.data)).toEqual(["people:a", "people:b", "people:c"]);
    expect(document.jsonapi).toEqual({ version: "1.1" });
    expect(document).not.toHaveProperty("links");
    expect(document).not.toHaveProperty("meta");
    expect(document).not.toHaveProperty("included");
    expect((await run(Assemble.unpaginatedCollection([]))).data).toEqual([]);
  });

  it("coerces links, stamps per-viewer meta and projects fieldsets on every resource", async () => {
    const document = await run(
      Assemble.unpaginatedCollection(whole, {
        viewer: ADMIN,
        capabilities: familyCapabilities,
        fields: { people: ["name"] },
      }),
    );
    expect(document.data.map((resource) => resource.meta)).toEqual(
      whole.map(() => ({ canEdit: true, canDelete: true })),
    );
    expect(document.data.map((resource) => resource.attributes)).toEqual(
      whole.map((resource) => ({ name: resource.attributes["name"] })),
    );
    expect(document.data.map((resource) => resource.links?.self)).toEqual(
      whole.map((resource) => `https://example.test/people/${resource.id}`),
    );
  });

  it("resolves the include walk in one batch per target type, deduplicated", async () => {
    const { calls, targets } = registry([place]);
    const document = await run(
      Assemble.unpaginatedCollection(whole, {
        viewer: NON_ADMIN,
        capabilities: familyCapabilities,
        include: ["birthPlace"],
        includable: ["birthPlace"],
        targets,
      }),
    );
    expect(calls).toEqual([{ type: "places", ids: ["place-1"] }]);
    expect(ids(document.included)).toEqual(["places:place-1"]);
    expect(document.included?.[0]?.meta).toEqual({ canEdit: false, canDelete: false });
  });

  it("walks a nested path level by level", async () => {
    const { targets } = registry([election, event]);
    const document = await run(
      Assemble.unpaginatedCollection([contest("x"), contest("y")], {
        include: ["election.electionEvent"],
        includable: ["election", "election.electionEvent"],
        targets,
      }),
    );
    expect(ids(document.included)).toEqual(["elections:election-1", "election-events:event-1"]);
  });

  it("rejects an include path outside the whitelist before any loader runs", async () => {
    const { calls, targets } = registry([place]);
    const error = await run(
      Effect.flip(
        Assemble.unpaginatedCollection(whole, {
          include: ["candidacies"],
          includable: ["birthPlace"],
          targets,
        }),
      ),
    );
    expect(error).toBeInstanceOf(ApiError.UnsupportedIncludePath);
    expect(calls).toEqual([]);
  });

  it("emits pre-resolved included members, deduplicated against the primary data", async () => {
    const withIncluded = await run(
      Assemble.unpaginatedCollection(whole, {
        included: [{ ...place, links: { self: new URL("https://example.test/places/place-1") } }],
      }),
    );
    expect(withIncluded.included?.[0]?.links?.self).toBe("https://example.test/places/place-1");
    // `election-1` is primary data and also in the caller's `included`, beside
    // a candidate the contest links to but the collection doesn't hold. Only
    // the repeat is dropped: the candidate survives, so the assertion fails
    // both when the dedupe is lost and when `included` is dropped wholesale.
    const { calls, targets } = registry([election]);
    const deduped = await run(
      Assemble.unpaginatedCollection([contest("x"), election], {
        included: [election, candidate("c-1")],
        include: ["election"],
        includable: ["election"],
        targets,
      }),
    );
    expect(calls).toEqual([]);
    expect(ids(deduped.data)).toEqual(["contests:x", "elections:election-1"]);
    expect(ids(deduped.included)).toEqual(["candidates:c-1"]);
    expect(await run(Assemble.unpaginatedCollection(whole, { included: [] }))).not.toHaveProperty(
      "included",
    );
  });

  it("emits `included: []` when include was requested and nothing remains (#232)", async () => {
    const { calls, targets } = registry([]);
    const unresolved = await run(
      Assemble.unpaginatedCollection(whole, {
        include: ["birthPlace"],
        includable: ["birthPlace"],
        targets,
      }),
    );
    expect(calls).toEqual([]);
    expect(unresolved.included).toEqual([]);
    // Every candidate is already primary data: the dedupe leaves nothing, and
    // the key stays.
    const deduped = await run(
      Assemble.unpaginatedCollection([contest("x"), election], {
        included: [election],
        include: ["election"],
        includable: ["election"],
        targets,
      }),
    );
    expect(ids(deduped.data)).toEqual(["contests:x", "elections:election-1"]);
    expect(deduped.included).toEqual([]);
  });

  it("emits `included: []` in validate-only mode: include, no registry (#232)", async () => {
    expect(
      (
        await run(
          Assemble.unpaginatedCollection(whole, {
            include: ["birthPlace"],
            includable: ["birthPlace"],
          }),
        )
      ).included,
    ).toEqual([]);
    expect(
      (await run(Assemble.unpaginatedCollection(whole, { include: [], includable: [] }))).included,
    ).toEqual([]);
  });

  it("assembles what `collection` does, less its links and meta", async () => {
    const options = {
      viewer: NON_ADMIN,
      capabilities: familyCapabilities,
      include: ["birthPlace"],
      includable: ["birthPlace"],
      targets: registry([place]).targets,
    };
    const { links, meta, ...paged } = await run(
      Assemble.collection(
        whole,
        { totalCount: 3, offset: 0, limit: 10, baseUrl: "https://example.test/people" },
        options,
      ),
    );
    expect(links.self).toBeDefined();
    expect(meta.totalCount).toBe(3);
    expect(await run(Assemble.unpaginatedCollection(whole, options))).toEqual(paged);
  });

  describe("with a `self` link (#242)", () => {
    const self = "https://example.test/people";
    const query: ReadonlyArray<Query.Pair> = [
      ["include", "birthPlace"],
      ["filter[q]", "Ada Lovelace, & co"],
      ["sort", "-name"],
    ];

    it("emits `links.self` and nothing else at the top level", async () => {
      const document = await run(Assemble.unpaginatedCollection(whole, { self }));
      expect(document.links).toEqual({ self });
      expect(document).not.toHaveProperty("meta");
      expect(ids(document.data)).toEqual(["people:a", "people:b", "people:c"]);
      expect(document.jsonapi).toEqual({ version: "1.1" });
    });

    it("carries the query on `self`, canonicalised as `collection`'s links are", async () => {
      const document = await run(Assemble.unpaginatedCollection(whole, { self, query }));
      expect(document.links.self).toBe(
        `${self}?include=birthPlace&filter[q]=Ada%20Lovelace%2C%20%26%20co&sort=-name`,
      );
      expect(document.links.self).toBe(`${self}?${Query.serialise(query)}`);
      // The paginated form serialises the same pairs the same way, its page
      // cursor appended after them.
      const paged = await run(
        Assemble.collection(whole, { totalCount: 3, offset: 0, limit: 10, baseUrl: self, query }),
      );
      expect(paged.links.first).toBe(`${document.links.self}&page[offset]=0&page[limit]=10`);
      // An empty query leaves `self` as given; a `self` that has a query
      // string of its own is extended rather than given a second `?`.
      expect((await run(Assemble.unpaginatedCollection(whole, { self, query: [] }))).links).toEqual(
        { self },
      );
      expect(
        (
          await run(
            Assemble.unpaginatedCollection(whole, {
              self: `${self}?locale=en`,
              query: [["sort", "name"]],
            }),
          )
        ).links.self,
      ).toBe(`${self}?locale=en&sort=name`);
    });

    it("emits exactly the linkless document when `self` is absent", async () => {
      const options = {
        viewer: NON_ADMIN,
        capabilities: familyCapabilities,
        include: ["birthPlace"],
        includable: ["birthPlace"],
        targets: registry([place]).targets,
      };
      const linkless = await run(Assemble.unpaginatedCollection(whole, options));
      // A `self` the handler turns out not to have (typed `string | undefined`,
      // as an optional threaded through would be) drops the query with the link.
      const absentSelf = [self].find((url) => url.startsWith("ftp:"));
      const dropped = await run(
        Assemble.unpaginatedCollection(whole, { ...options, self: absentSelf, query }),
      );
      expect(dropped).not.toHaveProperty("links");
      expect(dropped).toStrictEqual(linkless);
      // With `self`, the document is the linkless one plus `links` — the
      // rest is untouched.
      const { links, ...rest } = await run(
        Assemble.unpaginatedCollection(whole, { ...options, self, query }),
      );
      expect(links.self).toBe(`${self}?${Query.serialise(query)}`);
      expect(rest).toStrictEqual(linkless);
    });
  });

  describe("with a top-level `meta` (#253)", () => {
    const self = "https://example.test/people";
    const meta = { generatedAt: "2026-10-08T00:00:00Z", cache: { maxAge: 60 } };
    const options = {
      viewer: NON_ADMIN,
      capabilities: familyCapabilities,
      include: ["birthPlace"],
      includable: ["birthPlace"],
      targets: registry([place]).targets,
    };

    it("emits `meta` as given, beside the per-resource meta it doesn't touch", async () => {
      const document = await run(Assemble.unpaginatedCollection(whole, { ...options, meta }));
      expect(document.meta).toStrictEqual(meta);
      expect(document).not.toHaveProperty("links");
      expect(document.data.map((resource) => resource.meta)).toEqual(
        whole.map(() => ({ canEdit: false, canDelete: false })),
      );
      // No page math is added to it: a total is `Assemble.collection`'s.
      expect(document.meta).not.toHaveProperty("totalCount");
    });

    it("is the meta-less document plus `meta`, with or without `self`", async () => {
      const bare = await run(Assemble.unpaginatedCollection(whole, options));
      const { meta: emitted, ...rest } = await run(
        Assemble.unpaginatedCollection(whole, { ...options, meta }),
      );
      expect(emitted).toStrictEqual(meta);
      expect(rest).toStrictEqual(bare);

      const query: ReadonlyArray<Query.Pair> = [["sort", "-name"]];
      const linked = await run(Assemble.unpaginatedCollection(whole, { ...options, self, query }));
      const { meta: linkedMeta, ...linkedRest } = await run(
        Assemble.unpaginatedCollection(whole, { ...options, self, query, meta }),
      );
      expect(linkedMeta).toStrictEqual(meta);
      expect(linkedRest).toStrictEqual(linked);
      expect(linkedRest.links.self).toBe(`${self}?sort=-name`);
    });

    it("emits exactly the meta-less document when `meta` is absent", async () => {
      const bare = await run(Assemble.unpaginatedCollection(whole, options));
      expect(bare).not.toHaveProperty("meta");
      // A `meta` the handler turns out not to have (typed `… | undefined`,
      // as an optional threaded through would be) adds no member.
      const absentMeta = [meta].find((value) => value.generatedAt === "");
      const dropped = await run(
        Assemble.unpaginatedCollection(whole, { ...options, meta: absentMeta }),
      );
      expect(dropped).not.toHaveProperty("meta");
      expect(dropped).toStrictEqual(bare);
    });
  });
});

describe("Assemble.relationship", () => {
  it("answers the linkage as data, the parent (and extras) as included, and the related link", () => {
    const document = Assemble.relationship({
      parent: contest("x"),
      key: "candidates",
      included: [candidate("c-1"), candidate("c-1")],
    });
    expect(document.data).toEqual([
      { type: "candidates", id: "c-1" },
      { type: "candidates", id: "c-2" },
    ]);
    expect(ids(document.included)).toEqual(["contests:x", "candidates:c-1"]);
    expect(document.links).toBeUndefined();
    expect(document.jsonapi).toEqual({ version: "1.1" });
    const withLink = Assemble.relationship({ parent: person("p1"), key: "birthPlace" });
    expect(withLink.data).toEqual({ type: "places", id: "place-1" });
    expect(withLink.links).toEqual({ related: "https://example.test/people/p1/birthPlace" });
  });

  it("spells an empty to-one as `data: null`", () => {
    const parent: Assemble.ResourceLike = {
      type: "t",
      id: "1",
      attributes: {},
      relationships: { one: { data: null } },
    };
    expect(Assemble.relationship({ parent, key: "one" }).data).toBeNull();
    expect(Assemble.relationship({ parent, key: "missing" }).data).toBeNull();
  });
});

describe("Assemble.edgePage", () => {
  it("assembles a capability-free page under <base>/<segment>", async () => {
    const document = await run(
      Assemble.edgePage(
        "contributions",
        { items: [person("a")], totalCount: 7 },
        { limit: 1, offset: 0 },
        "https://example.test",
        ADMIN,
      ),
    );
    expect(document.links.self).toBe(
      "https://example.test/contributions?page[offset]=0&page[limit]=1",
    );
    expect(document.data[0]).not.toHaveProperty("meta");
    expect(document.meta.totalCount).toBe(7);
  });
});

describe("helpers", () => {
  it("reads the refs a relationship's data carries, tolerating bare shapes", () => {
    expect(Assemble.relationshipRefs(contest("x"), "candidates")).toEqual([
      { type: "candidates", id: "c-1" },
      { type: "candidates", id: "c-2" },
    ]);
    expect(Assemble.relationshipRefs(contest("x"), "election")).toEqual([
      { type: "elections", id: "election-1" },
    ]);
    expect(Assemble.relationshipRefs(contest("x"), "missing")).toEqual([]);
    const bare: Assemble.ResourceLike = {
      type: "t",
      id: "1",
      attributes: {},
      relationships: { one: { type: "u", id: "2" }, many: [{ type: "u", id: "3" }], none: null },
    };
    expect(Assemble.relationshipRefs(bare, "one")).toEqual([{ type: "u", id: "2" }]);
    expect(Assemble.relationshipRefs(bare, "many")).toEqual([{ type: "u", id: "3" }]);
    expect(Assemble.relationshipRefs(bare, "none")).toEqual([]);
  });

  it("deep-coerces Dates and URLs and drops undefined members", () => {
    const coerced = Assemble.toWireSafeResource({
      type: "t",
      id: "1",
      attributes: { at: new Date("2026-01-01T00:00:00Z"), gone: undefined, list: [undefined, 1] },
      links: { self: new URL("https://example.test/t/1") },
    });
    expect(coerced.attributes).toEqual({ at: "2026-01-01T00:00:00.000Z", list: [null, 1] });
    expect(coerced.links?.self).toBe("https://example.test/t/1");
  });

  // A value parsed from JSON (or read by a database driver) can carry
  // `__proto__` as an own key; a copy that assigned it would run the
  // prototype setter, dropping the member and re-parenting the copy onto its
  // value (#269).
  it("keeps a member keyed __proto__ as an own data member, coerced like any other", () => {
    const json =
      '{"type":"things","id":"1","attributes":{"settings":{"kept":1,"__proto__":{"inner":2}}},' +
      '"meta":{"__proto__":{"source":"driver"}}}';
    const coerced = Assemble.toWireSafeResource(parseResource(json));
    const settings = coerced.attributes["settings"];
    expect(Object.getPrototypeOf(settings)).toBe(Object.prototype);
    expect(Object.getOwnPropertyNames(settings)).toEqual(["kept", "__proto__"]);
    expect(Object.getOwnPropertyDescriptor(settings, "__proto__")?.value).toEqual({ inner: 2 });
    expect(Object.getPrototypeOf(coerced.meta)).toBe(Object.prototype);
    expect(Object.getOwnPropertyNames(coerced.meta)).toEqual(["__proto__"]);
    // The wire form is the input's, byte for byte.
    expect(toJson(coerced)).toBe(json);
    expect(Object.hasOwn(Object.prototype, "inner")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "source")).toBe(false);

    // A value under the member is still deep-coerced.
    const linked = Assemble.toWireSafeResource({
      type: "things",
      id: "2",
      attributes: R.fromEntries([["__proto__", { at: new URL("https://example.test/a") }]]),
    });
    expect(toJson(linked.attributes)).toBe('{"__proto__":{"at":"https://example.test/a"}}');
  });

  it("carries a __proto__ member through an assembled document's attributes and meta", async () => {
    const document = await run(
      Assemble.resource(
        Assemble.toWireSafeResource(
          parseResource(
            '{"type":"things","id":"1","attributes":{"__proto__":{"inner":2},"title":"T","hidden":0},' +
              '"meta":{"__proto__":{"source":"driver"}}}',
          ),
        ),
        { fields: { things: ["__proto__", "title"] } },
      ),
    );
    const { attributes, meta } = document.data;
    expect(Object.getPrototypeOf(attributes)).toBe(Object.prototype);
    expect(Object.getOwnPropertyNames(attributes)).toEqual(["__proto__", "title"]);
    expect(Object.getPrototypeOf(meta)).toBe(Object.prototype);
    expect(toJson(document.data)).toBe(
      '{"type":"things","id":"1","attributes":{"__proto__":{"inner":2},"title":"T"},' +
        '"meta":{"__proto__":{"source":"driver"}}}',
    );
    expect(Object.hasOwn(Object.prototype, "inner")).toBe(false);
  });

  it("stringifies a link object's href too", () => {
    const wired = Assemble.stringifyLinks({
      type: "t",
      id: "1",
      attributes: {},
      links: { self: { href: new URL("https://example.test/t/1") } },
    });
    expect(wired.links?.self).toBe("https://example.test/t/1");
  });

  it("ownedCapabilities: the owner and a moderator may write, a stranger may not", () => {
    const owned = Assemble.ownedCapabilities({
      viewerId: (viewer: User | null | undefined) => viewer?.id,
      canModerate: (viewer) => viewer?.role === "admin",
    });
    const garden: Assemble.ResourceLike = {
      type: "gardens",
      id: "g1",
      attributes: {},
      relationships: { owner: { data: { type: "users", id: "u-user" } } },
    };
    expect(owned(garden, NON_ADMIN)).toEqual({ canEdit: true, canDelete: true });
    expect(owned(garden, ADMIN)).toEqual({ canEdit: true, canDelete: true });
    expect(owned(garden, EDITOR)).toEqual({ canEdit: false, canDelete: false });
    expect(owned(garden, null)).toEqual({ canEdit: false, canDelete: false });
    expect(owned(place, NON_ADMIN)).toEqual({ canEdit: false, canDelete: false });
  });
});
