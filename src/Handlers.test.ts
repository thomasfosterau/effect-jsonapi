import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import { Schema } from "effect";
import * as Document from "./Document.js";
import * as Handlers from "./Handlers.js";
import * as Query from "./Query.js";
import * as Resource from "./Resource.js";

const article = {
  type: "articles",
  id: "1",
  attributes: { title: "Hello" },
  relationships: {
    author: { data: { type: "people", id: "9" } },
    comments: { data: [{ type: "comments", id: "5" }] },
  },
};

const author = { type: "people", id: "9", attributes: { firstName: "John" } };
const comment = {
  type: "comments",
  id: "5",
  attributes: { body: "Nice" },
  relationships: { author: { data: { type: "people", id: "9" } } },
};
const stranger = { type: "people", id: "404", attributes: { firstName: "Nobody" } };

describe("Handlers.data", () => {
  it("builds a minimal document", () => {
    expect(Handlers.data(article)).toEqual({ data: article });
  });

  it("builds a null-data document", () => {
    expect(Handlers.data(null)).toEqual({ data: null });
  });

  it("adds self links, extra links and meta", () => {
    const doc = Handlers.data(article, {
      self: "/articles/1",
      links: { related: "/articles/1/related" },
      meta: { copyright: "ACME" },
    });
    expect(doc).toEqual({
      data: article,
      links: { self: "/articles/1", related: "/articles/1/related" },
      meta: { copyright: "ACME" },
    });
  });

  it("includes referenced resources", () => {
    const doc = Handlers.data(article, { included: [author, comment] });
    expect(doc.included).toEqual([author, comment]);
  });

  it("deduplicates included resources by (type, id)", () => {
    const doc = Handlers.data(article, { included: [author, author, comment] });
    expect(doc.included).toEqual([author, comment]);
  });

  it("enforces full linkage: unreferenced included resources throw", () => {
    expect(() => Handlers.data(article, { included: [stranger] })).toThrow(/full linkage/);
  });

  it("allows transitively referenced included resources", () => {
    // `comment` references `author`; both are linked.
    const commentOnlyArticle = {
      type: "articles",
      id: "1",
      relationships: { comments: { data: [{ type: "comments", id: "5" }] } },
    };
    const doc = Handlers.data(commentOnlyArticle, { included: [comment, author] });
    expect(doc.included).toEqual([comment, author]);
  });

  it("linkage check can be disabled", () => {
    const doc = Handlers.data(article, { included: [stranger], checkLinkage: false });
    expect(doc.included).toEqual([stranger]);
  });

  it("does not repeat the primary resource in `included` (#147)", () => {
    // An article that links to itself: a `related` include resolves back to
    // the primary resource, which a document carries once, as `data`.
    const selfLinked = {
      ...article,
      relationships: {
        ...article.relationships,
        related: { data: [{ type: "articles", id: "1" }] },
      },
    };
    expect(Handlers.data(selfLinked, { included: [selfLinked, author] }).included).toEqual([
      author,
    ]);
    // …and when it was the only candidate, there is no `included` member at all.
    expect(Handlers.data(selfLinked, { included: [selfLinked] })).toEqual({ data: selfLinked });
  });
});

describe("Handlers.collection", () => {
  it("builds a collection document", () => {
    const doc = Handlers.collection([article], {
      included: [author],
      meta: { total: 1 },
      self: "/articles",
    });
    expect(doc).toEqual({
      data: [article],
      included: [author],
      links: { self: "/articles" },
      meta: { total: 1 },
    });
  });

  it("builds an empty collection", () => {
    expect(Handlers.collection([])).toEqual({ data: [] });
  });

  it("does not repeat primary data in `included` for a heterogeneous collection (#147)", () => {
    // `/search?include=author`: `people:9` is both a search hit (primary data)
    // and the author of another hit. A compound document MUST NOT include more
    // than one resource object for each `(type, id)` pair.
    const doc = Handlers.collection([article, author], { included: [author, comment] });
    expect(doc.data).toEqual([article, author]);
    expect(doc.included).toEqual([comment]);
  });

  it("omits `included` when every candidate is already primary data (#147)", () => {
    expect(Handlers.collection([article, author], { included: [author, author] })).toEqual({
      data: [article, author],
    });
  });

  it("appends the request's canonical query to the self link", () => {
    const pairs: ReadonlyArray<Query.Pair> = [
      ["filter[status]", "open"],
      ["sort", "-createdAt"],
    ];
    expect(Handlers.collection([article], { self: "/articles", query: pairs }).links).toEqual({
      self: "/articles?filter[status]=open&sort=-createdAt",
    });
    // …or the already serialised string, and onto a path that has a query
    expect(
      Handlers.collection([article], { self: "/articles?x=1", query: "sort=-createdAt" }).links,
    ).toEqual({
      self: "/articles?x=1&sort=-createdAt",
    });
    // an empty query leaves the path alone
    expect(Handlers.collection([article], { self: "/articles", query: [] }).links).toEqual({
      self: "/articles",
    });
  });

  it("appends the query to links.self too, which wins over the self option", () => {
    const pairs: ReadonlyArray<Query.Pair> = [["sort", "-createdAt"]];
    expect(
      Handlers.collection([article], { links: { self: "/articles" }, query: pairs }).links,
    ).toEqual({
      self: "/articles?sort=-createdAt",
    });
    expect(
      Handlers.collection([article], {
        links: { self: { href: "/articles" }, next: null },
        query: pairs,
      }).links,
    ).toEqual({ self: { href: "/articles?sort=-createdAt" }, next: null });
    // both spellings: links.self wins (as before), and the query lands on it once
    expect(
      Handlers.collection([article], {
        self: "/ignored",
        links: { self: "/articles" },
        query: "sort=-createdAt",
      }).links,
    ).toEqual({ self: "/articles?sort=-createdAt" });
    // regression: without a query the precedence is unchanged
    expect(
      Handlers.collection([article], { self: "/ignored", links: { self: "/articles" } }).links,
    ).toEqual({
      self: "/articles",
    });
  });

  it("throws for a query with no self link to carry it", () => {
    expect(() => Handlers.collection([article], { query: [["sort", "-createdAt"]] })).toThrow(
      /self link/,
    );
    expect(() =>
      Handlers.collection([article], { links: { next: null }, query: "sort=-createdAt" }),
    ).toThrow(/self link/);
  });
});

describe("Handlers.linkage", () => {
  it("builds a to-one linkage document", () => {
    expect(Handlers.linkage({ type: "people", id: "9" })).toEqual({
      data: { type: "people", id: "9" },
    });
  });

  it("builds an empty to-one linkage document", () => {
    expect(Handlers.linkage(null)).toEqual({ data: null });
  });

  it("builds a to-many linkage document", () => {
    expect(
      Handlers.linkage([
        { type: "comments", id: "5" },
        { type: "comments", id: "12" },
      ]),
    ).toEqual({
      data: [
        { type: "comments", id: "5" },
        { type: "comments", id: "12" },
      ],
    });
  });

  it("adds self/related links and meta", () => {
    const doc = Handlers.linkage([{ type: "comments", id: "5" }], {
      self: "/articles/1/relationships/comments",
      related: "/articles/1/comments",
      meta: { count: 1 },
    });
    expect(doc).toEqual({
      data: [{ type: "comments", id: "5" }],
      links: {
        self: "/articles/1/relationships/comments",
        related: "/articles/1/comments",
      },
      meta: { count: 1 },
    });
  });

  it("merges extra links (e.g. pagination)", () => {
    const doc = Handlers.linkage([], {
      self: "/articles/1/relationships/comments",
      links: { next: "/articles/1/relationships/comments?page[offset]=10" },
    });
    expect(doc.links).toEqual({
      self: "/articles/1/relationships/comments",
      next: "/articles/1/relationships/comments?page[offset]=10",
    });
  });
});

// A resource type that appears on both sides of a compound document: an
// article whose `related` relationship points at other articles. This is the
// shape the per-resource transform exists for — one type, two slots.
const primaryArticle = {
  type: "articles",
  id: "1",
  attributes: { title: "Hi", body: "the body", draft: false },
  relationships: { related: { data: [{ type: "articles", id: "2" }] } },
};
const relatedArticle = {
  type: "articles",
  id: "2",
  attributes: { title: "Yo", body: "another body", draft: true },
};

describe("Handlers.project", () => {
  it("projects `attributes` to the requested set", () => {
    expect(Handlers.project(relatedArticle, { articles: ["title"] })).toEqual({
      type: "articles",
      id: "2",
      attributes: { title: "Yo" },
    });
  });

  it("is identity when the type has no requested set", () => {
    // absent entirely…
    expect(Handlers.project(relatedArticle, { people: ["firstName"] })).toBe(relatedArticle);
    expect(Handlers.project(relatedArticle, undefined)).toBe(relatedArticle);
    // …present but empty (`?fields[articles]=`): still "every field", not "no field"
    expect(Handlers.project(relatedArticle, { articles: [] })).toBe(relatedArticle);
  });

  it("projects `attributes` only — relationships, links and meta are left alone", () => {
    const decorated = { ...primaryArticle, links: { self: "/articles/1" }, meta: { views: 3 } };
    expect(Handlers.project(decorated, { articles: ["title"] })).toEqual({
      type: "articles",
      id: "1",
      attributes: { title: "Hi" },
      relationships: { related: { data: [{ type: "articles", id: "2" }] } },
      links: { self: "/articles/1" },
      meta: { views: 3 },
    });
  });

  it("leaves a resource with no attributes (a resource identifier) alone", () => {
    const identifier = { type: "articles", id: "2" };
    expect(Handlers.project(identifier, { articles: ["title"] })).toBe(identifier);
  });

  it("ignores requested names the resource doesn't carry", () => {
    expect(Handlers.project(relatedArticle, { articles: ["title", "nope"] }).attributes).toEqual({
      title: "Yo",
    });
  });

  it("data-last builds the transform the builders take", () => {
    const onResource = Handlers.project({ articles: ["title"] });
    expect(onResource(relatedArticle)).toEqual({
      type: "articles",
      id: "2",
      attributes: { title: "Yo" },
    });
  });
});

describe("Handlers.withMeta", () => {
  it("merges the computed members over the resource's own meta", () => {
    const stamp = Handlers.withMeta((resource) => ({ href: `/${resource.type}/${resource.id}` }));
    expect(stamp({ ...relatedArticle, meta: { views: 3 } }).meta).toEqual({
      views: 3,
      href: "/articles/2",
    });
    expect(stamp(relatedArticle).meta).toEqual({ href: "/articles/2" });
  });

  it("computed members win over the resource's own", () => {
    const stamp = Handlers.withMeta(() => ({ views: 0 }));
    expect(stamp({ ...relatedArticle, meta: { views: 3 } }).meta).toEqual({ views: 0 });
  });

  it("emits no `meta` member when the merged result is empty", () => {
    // an empty `meta` object is a *present* meta to the spec — not the same
    // statement as having none
    expect(Handlers.withMeta(() => ({}))(relatedArticle)).not.toHaveProperty("meta");
    expect(Handlers.withMeta(() => undefined)(relatedArticle)).toBe(relatedArticle);
    // …including when the resource arrived carrying an empty one
    expect(Handlers.withMeta(() => undefined)({ ...relatedArticle, meta: {} })).not.toHaveProperty(
      "meta",
    );
  });

  it("computes per resource, over every type in the document", () => {
    const stamp = Handlers.withMeta((resource) =>
      resource.type === "articles" ? { kind: "article" } : undefined,
    );
    expect(stamp(relatedArticle).meta).toEqual({ kind: "article" });
    expect(stamp(author)).not.toHaveProperty("meta");
  });
});

describe("Handlers.compose", () => {
  it("applies the first transform, then the second", () => {
    const onResource = Handlers.compose(
      Handlers.project({ articles: ["title"] }),
      Handlers.withMeta((resource) => ({ href: `/${resource.type}/${resource.id}` })),
    );
    expect(onResource(relatedArticle)).toEqual({
      type: "articles",
      id: "2",
      attributes: { title: "Yo" },
      meta: { href: "/articles/2" },
    });
  });
});

describe("Handlers.transform", () => {
  it("wraps a runtime function as a transform", () => {
    const withSelfLink = Handlers.transform<Handlers.IdentityLambda>((resource) => ({
      ...resource,
      links: { self: `/${resource.type}/${resource.id}` },
    }));
    expect(Handlers.data(relatedArticle, { onResource: withSelfLink }).data).toEqual({
      ...relatedArticle,
      links: { self: "/articles/2" },
    });
  });
});

describe("the per-resource transform pass", () => {
  it("shapes a type identically wherever it appears — primary and included", () => {
    // The regression this hook exists to prevent: a sparse fieldset applied to
    // the primary data but not to `included` leaves one document describing
    // "articles" two different ways.
    const document = Handlers.data(primaryArticle, {
      included: [relatedArticle],
      onResource: Handlers.project({ articles: ["title"] }),
    });

    expect(document.data.attributes).toEqual({ title: "Hi" });
    expect(document.included?.[0]?.attributes).toEqual({ title: "Yo" });
    // the assertion that matters: one type, one shape
    expect(Object.keys(document.data.attributes)).toEqual(
      Object.keys(document.included![0]!.attributes),
    );
    // …and the relationships that carry the linkage survived in both slots
    expect(document.data.relationships).toEqual(primaryArticle.relationships);
  });

  it("applies to a collection's `data` and `included` alike", () => {
    const document = Handlers.collection([primaryArticle], {
      included: [relatedArticle],
      onResource: Handlers.project({ articles: ["title"] }),
    });
    expect(document.data[0]?.attributes).toEqual({ title: "Hi" });
    expect(document.included?.[0]?.attributes).toEqual({ title: "Yo" });
    expect(Object.keys(document.data[0]!.attributes)).toEqual(
      Object.keys(document.included![0]!.attributes),
    );
  });

  it("leaves types with no requested set untouched, in either slot", () => {
    const document = Handlers.data(article, {
      included: [author, comment],
      onResource: Handlers.project({ articles: ["title"] }),
    });
    expect(document.data.attributes).toEqual({ title: "Hello" });
    expect(document.included).toEqual([author, comment]);
  });

  it("runs after dedup: once per distinct included resource, not once per occurrence", () => {
    const seen: Array<string> = [];
    const document = Handlers.data(article, {
      included: [author, author, comment],
      onResource: (resource) => {
        seen.push(`${resource.type}:${resource.id}`);
        return resource;
      },
    });
    expect(document.included).toEqual([author, comment]);
    expect(seen).toEqual(["articles:1", "people:9", "comments:5"]);
  });

  it("runs once for a resource offered as both primary data and an `included` member", () => {
    // The builders emit it once, as primary data (#147), and shape it once:
    // the transform's result for the primary slot is the one the document carries.
    const selfReferential = {
      type: "articles",
      id: "1",
      attributes: { title: "Hi" },
      relationships: { related: { data: [{ type: "articles", id: "1" }] } },
    };
    let runs = 0;
    const document = Handlers.data(selfReferential, {
      included: [selfReferential],
      onResource: (resource) => {
        runs += 1;
        return resource;
      },
    });
    expect(runs).toBe(1);
    expect(document.included).toBeUndefined();
  });

  it("runs before the full-linkage check — a transform that breaks linkage is caught", () => {
    const stripRelationships = Handlers.transform<Handlers.IdentityLambda>(
      ({ relationships: _relationships, ...rest }) => rest,
    );
    expect(() =>
      Handlers.data(primaryArticle, { included: [relatedArticle], onResource: stripRelationships }),
    ).toThrow(/full linkage/);
    // …and the check is still skippable
    expect(
      Handlers.data(primaryArticle, {
        included: [relatedArticle],
        onResource: stripRelationships,
        checkLinkage: false,
      }).included,
    ).toEqual([{ type: "articles", id: "2", attributes: relatedArticle.attributes }]);
  });

  it("checks reachability from the primary data — a cycle the primary data no longer reaches throws (#239)", () => {
    // `people:9` and `articles:2` reference each other, but once the transform
    // strips `articles:1`'s relationships nothing in the primary data reaches
    // either, so neither can be linked to it.
    const stripRelationships = Handlers.transform<Handlers.IdentityLambda>((resource) => {
      if (resource.type !== "articles" || resource.id !== "1") return resource;
      const { relationships: _relationships, ...rest } = resource;
      return rest;
    });
    const primary = {
      type: "articles",
      id: "1",
      attributes: { title: "Hi" },
      relationships: { author: { data: { type: "people", id: "9" } } },
    };
    const person = {
      type: "people",
      id: "9",
      attributes: { name: "Ann" },
      relationships: { articles: { data: [{ type: "articles", id: "2" }] } },
    };
    const other = {
      type: "articles",
      id: "2",
      attributes: { title: "Yo" },
      relationships: { author: { data: { type: "people", id: "9" } } },
    };
    expect(() =>
      Handlers.data(primary, { included: [person, other], onResource: stripRelationships }),
    ).toThrow(/full linkage violation: included resource "people:9"/);
    // A collection walks from its transformed primary data too.
    expect(() =>
      Handlers.collection([primary], { included: [person, other], onResource: stripRelationships }),
    ).toThrow(/full linkage violation: included resource "people:9"/);
    // Untransformed, the primary data reaches both: `people:9` directly,
    // `articles:2` through it.
    expect(Handlers.data(primary, { included: [person, other] }).included).toEqual([person, other]);
  });

  it("rejects a member whose only reference is its own (#239)", () => {
    const manager = {
      type: "people",
      id: "9",
      attributes: { name: "Ann" },
      relationships: { manager: { data: { type: "people", id: "9" } } },
    };
    const unlinked = { type: "articles", id: "1", attributes: { title: "Hi" } };
    expect(() => Handlers.data(unlinked, { included: [manager] })).toThrow(
      /full linkage violation: included resource "people:9"/,
    );
    expect(() => Handlers.buildIncluded([unlinked], [manager])).toThrow(/full linkage/);
  });

  it("rejects every member of a chain the primary data no longer reaches (#239)", () => {
    // articles:1 → people:9 → companies:3. Stripping articles:1's
    // relationships orphans people:9, and companies:3 with it, though
    // people:9 still references companies:3.
    const primary = {
      type: "articles",
      id: "1",
      relationships: { author: { data: { type: "people", id: "9" } } },
    };
    const person = {
      type: "people",
      id: "9",
      relationships: { employer: { data: { type: "companies", id: "3" } } },
    };
    const company = { type: "companies", id: "3", attributes: { name: "ACME" } };
    expect(Handlers.buildIncluded([primary], [person, company])).toEqual([person, company]);
    const { relationships: _relationships, ...stripped } = primary;
    expect(() => Handlers.buildIncluded([stripped], [person, company])).toThrow(
      /full linkage violation: included resource "people:9"/,
    );
    expect(() => Handlers.buildIncluded([stripped], [company, person])).toThrow(
      /full linkage violation: included resource "companies:3"/,
    );
    // A collection reaches a member through any of its primary resources.
    const sibling = { ...primary, id: "2" };
    expect(
      Handlers.collection([stripped, sibling], { included: [company, person] }).included,
    ).toEqual([company, person]);
  });

  it("walks a long chain of included members without overflowing the stack (#239)", () => {
    // articles:1 → people:0 → people:1 → … → people:9999: one walk level per
    // member, so a walk that recursed per level would exhaust the stack.
    const length = 10_000;
    const primary = {
      type: "articles",
      id: "1",
      relationships: { author: { data: { type: "people", id: "0" } } },
    };
    const chain = Arr.makeBy(length, (i) => ({
      type: "people",
      id: String(i),
      relationships: {
        manager: { data: i + 1 < length ? { type: "people", id: String(i + 1) } : null },
      },
    }));
    expect(Handlers.buildIncluded([primary], chain)).toHaveLength(length);
    expect(Handlers.data(primary, { included: chain }).included).toHaveLength(length);
  });

  it("buildIncluded drops members already present as primary data (#147)", () => {
    expect(Handlers.buildIncluded([article, author], [author, comment, author])).toEqual([comment]);
  });

  it("buildIncluded applies it to the deduplicated members", () => {
    expect(
      Handlers.buildIncluded([article], [author, author], {
        onResource: Handlers.withMeta((resource) => ({ href: `/${resource.type}/${resource.id}` })),
      }),
    ).toEqual([{ ...author, meta: { href: "/people/9" } }]);
  });

  it("applies to a linkage document's resource identifiers", () => {
    const document = Handlers.linkage([{ type: "comments", id: "5" }], {
      self: "/articles/1/relationships/comments",
      onResource: Handlers.withMeta((resource) => ({ href: `/${resource.type}/${resource.id}` })),
    });
    expect(document.data).toEqual([{ type: "comments", id: "5", meta: { href: "/comments/5" } }]);
    // a to-one identifier, and an empty to-one which has nothing to shape
    expect(
      Handlers.linkage(
        { type: "people", id: "9" },
        { onResource: Handlers.withMeta(() => ({ canEdit: true })) },
      ).data,
    ).toEqual({ type: "people", id: "9", meta: { canEdit: true } });
    expect(
      Handlers.linkage(null, { onResource: Handlers.withMeta(() => ({ canEdit: true })) }).data,
    ).toBeNull();
  });
});

describe("relationship URL helpers", () => {
  it("relationshipLink builds the relationship-endpoint URL", () => {
    expect(Handlers.relationshipLink("articles", "1", "comments")).toBe(
      "/articles/1/relationships/comments",
    );
  });

  it("relatedLink builds the related-resource URL", () => {
    expect(Handlers.relatedLink("articles", "1", "comments")).toBe("/articles/1/comments");
  });

  it("paginatedRelationship builds a links-only relationship object", () => {
    expect(Handlers.paginatedRelationship("people", "9", "articles")).toEqual({
      links: {
        self: "/people/9/relationships/articles",
        related: "/people/9/articles",
      },
    });
  });
});

describe("pagination links", () => {
  it("offset pagination: first page", () => {
    const links = Handlers.offsetPaginationLinks("/articles", { offset: 0, limit: 10 }, 35);
    expect(links).toEqual({
      self: "/articles?page[offset]=0&page[limit]=10",
      first: "/articles?page[offset]=0&page[limit]=10",
      prev: null,
      next: "/articles?page[offset]=10&page[limit]=10",
      last: "/articles?page[offset]=30&page[limit]=10",
    });
  });

  it("offset pagination: middle page", () => {
    const links = Handlers.offsetPaginationLinks("/articles", { offset: 10, limit: 10 }, 35);
    expect(links.prev).toBe("/articles?page[offset]=0&page[limit]=10");
    expect(links.next).toBe("/articles?page[offset]=20&page[limit]=10");
  });

  it("offset pagination: last page has no next", () => {
    const links = Handlers.offsetPaginationLinks("/articles", { offset: 30, limit: 10 }, 35);
    expect(links.next).toBeNull();
    expect(links.last).toBe("/articles?page[offset]=30&page[limit]=10");
  });

  it("number pagination: pages are 1-based", () => {
    const links = Handlers.numberPaginationLinks("/articles", { number: 2, size: 10 }, 35);
    expect(links).toEqual({
      self: "/articles?page[number]=2&page[size]=10",
      first: "/articles?page[number]=1&page[size]=10",
      prev: "/articles?page[number]=1&page[size]=10",
      next: "/articles?page[number]=3&page[size]=10",
      last: "/articles?page[number]=4&page[size]=10",
    });
  });

  it("preserves existing query strings in the path", () => {
    const links = Handlers.offsetPaginationLinks(
      "/articles?sort=-createdAt",
      { offset: 0, limit: 10 },
      5,
    );
    expect(links.self).toBe("/articles?sort=-createdAt&page[offset]=0&page[limit]=10");
  });

  describe("with the request's canonical query", () => {
    const Article = Resource.make("articles", {
      attributes: {
        title: Schema.NonEmptyString,
        status: Resource.attribute(Schema.Literals(["open", "done"]), { filter: true }),
      },
    });
    const listQuery = Query.schema(Article, {
      fields: true,
      sort: true,
      page: Query.Page.Offset,
      filter: true,
    });
    const numberQuery = Query.schema(Article, {
      fields: true,
      sort: true,
      page: Query.Page.Number,
      filter: true,
    });
    const query: typeof listQuery.Type = {
      page: { offset: 10, limit: 10 },
      sort: [{ field: "title", direction: "desc" }],
      filter: { _tag: "Compare", op: "eq", field: "status", value: "open" },
      fields: { articles: ["title"] },
    };
    const others = "fields[articles]=title&filter[status]=open&sort=-title";

    it("offset: every link carries the full ordered query with its own page cursor slotted in", () => {
      const pairs = Query.canonicalPairs(listQuery)(query);
      const links = Handlers.offsetPaginationLinks("/articles", query.page ?? {}, 35, {
        query: pairs,
      });
      expect(links).toEqual({
        self: `/articles?${others}&page[offset]=10&page[limit]=10`,
        first: `/articles?${others}&page[offset]=0&page[limit]=10`,
        prev: `/articles?${others}&page[offset]=0&page[limit]=10`,
        next: `/articles?${others}&page[offset]=20&page[limit]=10`,
        last: `/articles?${others}&page[offset]=30&page[limit]=10`,
      });
      // `self` is exactly the canonical string of the request
      expect(links.self).toBe(`/articles?${Query.canonical(listQuery)(query)}`);
      // pairs carrying the request's own page cursor are replaced, not duplicated
      expect(
        Handlers.offsetPaginationLinks("/articles", { offset: 0, limit: 10 }, 35, { query: pairs })
          .self,
      ).toBe(`/articles?${others}&page[offset]=0&page[limit]=10`);
    });

    it("number: the same, for page-number pagination", () => {
      const q: typeof numberQuery.Type = { ...query, page: { number: 2, size: 10 } };
      const links = Handlers.numberPaginationLinks("/articles", q.page ?? {}, 35, {
        query: Query.canonicalPairs(numberQuery)(q),
      });
      expect(links).toEqual({
        self: `/articles?${others}&page[number]=2&page[size]=10`,
        first: `/articles?${others}&page[number]=1&page[size]=10`,
        prev: `/articles?${others}&page[number]=1&page[size]=10`,
        next: `/articles?${others}&page[number]=3&page[size]=10`,
        last: `/articles?${others}&page[number]=4&page[size]=10`,
      });
      expect(links.self).toBe(`/articles?${Query.canonical(numberQuery)(q)}`);
    });

    it("slots the page cursor before a consumer's own keys and after the families", () => {
      const pairs: ReadonlyArray<Query.Pair> = [
        ["include", "author"],
        ["sort", "-title"],
        ["zone", "au"],
      ];
      expect(
        Handlers.offsetPaginationLinks("/articles", { offset: 0, limit: 10 }, 5, { query: pairs })
          .self,
      ).toBe("/articles?include=author&sort=-title&page[offset]=0&page[limit]=10&zone=au");
      // values are percent-encoded on the way out
      expect(
        Handlers.numberPaginationLinks("/articles", { number: 1, size: 5 }, 5, {
          query: [["filter[title]", "a, b"]],
        }).self,
      ).toBe("/articles?filter[title]=a%2C%20b&page[number]=1&page[size]=5");
    });

    it("self carries the effective page window: the canonical string plus the defaults the server applied", () => {
      // ?sort=-title — no page keys sent; the builder fills in offset 0 and the total as the limit
      const request: typeof listQuery.Type = { sort: [{ field: "title", direction: "desc" }] };
      const canonical = Query.canonical(listQuery)(request);
      expect(canonical).toBe("sort=-title");
      const links = Handlers.offsetPaginationLinks("/articles", request.page ?? {}, 35, {
        query: Query.canonicalPairs(listQuery)(request),
      });
      expect(links.self).toBe("/articles?sort=-title&page[offset]=0&page[limit]=35");
      expect(links.self).not.toBe(`/articles?${canonical}`);
      expect(links).toEqual({
        self: "/articles?sort=-title&page[offset]=0&page[limit]=35",
        first: "/articles?sort=-title&page[offset]=0&page[limit]=35",
        prev: null,
        next: null,
        last: "/articles?sort=-title&page[offset]=0&page[limit]=35",
      });
    });

    it("keeps the request's pairs, its own page[*] included, on `self` when the window is unpageable", () => {
      // ?sort=-title&page[limit]=0 — `PageInt` admits 0, so the request decodes and nothing can be paged
      const request = Schema.decodeUnknownSync(listQuery as Schema.Codec<any, any>)({
        sort: "-title",
        "page[limit]": "0",
      }) as typeof listQuery.Type;
      expect(request).toEqual({
        sort: [{ field: "title", direction: "desc" }],
        page: { limit: 0 },
      });
      const pairs = Query.canonicalPairs(listQuery)(request);
      expect(
        Handlers.offsetPaginationLinks("/articles", request.page ?? {}, 5, { query: pairs }),
      ).toEqual({
        self: "/articles?sort=-title&page[limit]=0",
        first: null,
        prev: null,
        next: null,
        last: null,
      });
      expect(
        Handlers.numberPaginationLinks("/articles", { size: 0 }, 5, {
          query: [["page[size]", "0"]],
        }).self,
      ).toBe("/articles?page[size]=0");
      expect(Handlers.numberPaginationLinks("/articles", { size: 0 }, 5, { query: [] }).self).toBe(
        "/articles",
      );
      // regression: without the option the bare path, as before
      expect(Handlers.offsetPaginationLinks("/articles", { limit: 0 }, 5).self).toBe("/articles");
    });

    it("an empty query option is byte-identical to no option", () => {
      const page = { offset: 10, limit: 10 };
      expect(Handlers.offsetPaginationLinks("/articles", page, 35, { query: [] })).toEqual(
        Handlers.offsetPaginationLinks("/articles", page, 35),
      );
      expect(
        Handlers.numberPaginationLinks("/articles?x=1", { number: 2, size: 10 }, 35, {}),
      ).toEqual(Handlers.numberPaginationLinks("/articles?x=1", { number: 2, size: 10 }, 35));
    });
  });
});

describe("Handlers.DocumentValue / Document.Value", () => {
  const Article = Resource.make("articles", { attributes: { title: Schema.NonEmptyString } });
  const value = Article.make({ id: Article.Id.make("1"), attributes: { title: "Hi" } });

  it("DocumentValue names the value type Handlers.data returns", () => {
    const named: Handlers.DocumentValue<typeof Article.Type> = Handlers.data(value);
    expect(named.data.id).toBe("1");
  });

  it("DocumentValue carries jsonapi only when parameterized with J", () => {
    const doc: Handlers.DocumentValue<typeof Article.Type, never, never, typeof Document.v1_1> = {
      data: value,
      jsonapi: { version: "1.1" },
    };
    expect(doc.jsonapi.version).toBe("1.1");
    expectTypeOf<Handlers.JsonApiObjectValue>().toEqualTypeOf<typeof Document.JsonApiObject.Type>();
  });

  it("Handlers.data narrows jsonapi into the return type based on the option", () => {
    const withJsonapi = Handlers.data(value, { jsonapi: Document.v1_1 });
    expect(withJsonapi.jsonapi.version).toBe("1.1");

    const withoutJsonapi = Handlers.data(value);
    expectTypeOf(withoutJsonapi).not.toHaveProperty("jsonapi");
  });

  it("Document.Value names a data-document value type", () => {
    const doc: Document.Value<typeof Article> = {
      data: Schema.decodeUnknownSync(Article)({
        type: "articles",
        id: "1",
        attributes: { title: "Hi" },
      }),
      jsonapi: { version: "1.1" },
    };
    expect(doc.data.id).toBe("1");
  });

  it("Document.Value carries included and meta when parameterized", () => {
    const item = Schema.decodeUnknownSync(Article)({
      type: "articles",
      id: "1",
      attributes: { title: "Hi" },
    });
    const doc: Document.Value<typeof Article, typeof Article, typeof Document.AnyMeta> = {
      data: item,
      included: [item],
      meta: { note: "x" },
    };
    expect(doc.included?.[0]?.id).toBe("1");
    expect(doc.meta?.note).toBe("x");
  });
});
