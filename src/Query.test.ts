import { afterEach, describe, expect, expectTypeOf, it } from "vite-plus/test";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, UrlParams } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as ApiError from "./ApiError.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Middleware from "./Middleware.js";
import * as Query from "./Query.js";
import * as Relationship from "./Relationship.js";
import { platformLayer } from "./Registry.js";
import { attribute, make as Resource } from "./Resource.js";

const Person = Resource("people", {
  attributes: {
    firstName: Schema.NonEmptyString,
    lastName: Schema.NonEmptyString,
  },
});

const Comment = Resource("comments", {
  attributes: { body: Schema.NonEmptyString },
  relationships: { author: Relationship.one(() => Person) },
});

const Article = Resource("articles", {
  attributes: {
    title: Schema.NonEmptyString,
    body: Schema.String,
    createdAt: Schema.DateFromString,
  },
  relationships: {
    author: Relationship.one(() => Person),
    comments: Relationship.many(() => Comment),
  },
});

// A resource with a paginated relationship: excluded from include paths, but
// its target still gets sparse fieldsets.
const Feed = Resource("feeds", {
  attributes: { name: Schema.NonEmptyString },
  relationships: {
    owner: Relationship.one(() => Person),
    entries: Relationship.paginated(() => Article),
  },
});

describe("Query.Include", () => {
  const include = Query.Include(Article);

  it("decodes comma-separated relationship paths", () => {
    expect(Schema.decodeUnknownSync(include)("author,comments")).toEqual(["author", "comments"]);
  });

  it("accepts nested paths from the relationship graph", () => {
    expect(Schema.decodeUnknownSync(include)("comments.author")).toEqual(["comments.author"]);
  });

  it("rejects unknown include paths (→ 400)", () => {
    expect(() => Schema.decodeUnknownSync(include)("author,publisher")).toThrow();
    expect(() => Schema.decodeUnknownSync(include)("comments.likes")).toThrow();
  });

  it("encodes back to a comma-separated string", () => {
    expect(Schema.encodeUnknownSync(include)(["author", "comments.author"])).toBe(
      "author,comments.author",
    );
  });

  it("excludes paginated relationships from include paths (→ 400)", () => {
    const feedInclude = Query.Include(Feed);
    // `owner` is linkable; `entries` is paginated and cannot be included.
    expect(Schema.decodeUnknownSync(feedInclude)("owner")).toEqual(["owner"]);
    expect(() => Schema.decodeUnknownSync(feedInclude)("entries")).toThrow();
    expect(() => Schema.decodeUnknownSync(feedInclude)("entries.author")).toThrow();
    // ... and paths *through* a paginated relationship don't exist either.
    type FeedPaths = typeof feedInclude.Type;
    expectTypeOf<FeedPaths>().toEqualTypeOf<ReadonlyArray<"owner">>();
  });

  it("derives the whole graph at depth 2 when unconstrained (regression: the default)", () => {
    // every path the graph reaches, and nothing further
    expect(Schema.decodeUnknownSync(include)("author,comments,comments.author")).toEqual([
      "author",
      "comments",
      "comments.author",
    ]);
    expectTypeOf<typeof include.Type>().toEqualTypeOf<
      ReadonlyArray<"author" | "comments" | "comments.author">
    >();
  });

  it("constrains the legal paths to an explicit allow-list", () => {
    const subset = Query.Include(Article, { paths: ["author", "comments"] });
    expect(Schema.decodeUnknownSync(subset)("author,comments")).toEqual(["author", "comments"]);
    // a path the graph has but this endpoint can't populate is now a 400, not
    // a 200 with an empty `included`
    expect(() => Schema.decodeUnknownSync(subset)("comments.author")).toThrow();
    expectTypeOf<typeof subset.Type>().toEqualTypeOf<ReadonlyArray<"author" | "comments">>();
  });

  it("bounds the derivation by depth", () => {
    const shallow = Query.Include(Article, { depth: 1 });
    expect(Schema.decodeUnknownSync(shallow)("author,comments")).toEqual(["author", "comments"]);
    expect(() => Schema.decodeUnknownSync(shallow)("comments.author")).toThrow();
    expectTypeOf<typeof shallow.Type>().toEqualTypeOf<ReadonlyArray<"author" | "comments">>();

    const deep = Query.Include(Article, { depth: 3 });
    expect(Schema.decodeUnknownSync(deep)("comments.author")).toEqual(["comments.author"]);
    expectTypeOf<typeof deep.Type>().toEqualTypeOf<
      ReadonlyArray<"author" | "comments" | "comments.author">
    >();
  });

  it("lets an explicit allow-list win over a depth bound", () => {
    const subset = Query.Include(Article, { paths: ["comments.author"], depth: 1 });
    expect(Schema.decodeUnknownSync(subset)("comments.author")).toEqual(["comments.author"]);
    expect(() => Schema.decodeUnknownSync(subset)("author")).toThrow();
  });
});

describe("Query.Fieldset", () => {
  const fieldset = Query.Fieldset(Article);

  it("decodes attribute names", () => {
    expect(Schema.decodeUnknownSync(fieldset)("title,body")).toEqual(["title", "body"]);
  });

  it("rejects unknown attribute names (→ 400)", () => {
    expect(() => Schema.decodeUnknownSync(fieldset)("title,publisher")).toThrow();
  });

  it("decodes relationship names, which are fields too (#494)", () => {
    expect(Schema.decodeUnknownSync(fieldset)("title,author")).toEqual(["title", "author"]);
    expect(Schema.decodeUnknownSync(fieldset)(["comments"])).toEqual(["comments"]);
  });

  it("types the decoded fields as attribute- and relationship-key literals", () => {
    type Decoded = typeof fieldset.Type;
    expectTypeOf<Decoded>().toEqualTypeOf<
      ReadonlyArray<"title" | "body" | "createdAt" | "author" | "comments">
    >();
  });
});

describe("Query.Sort", () => {
  const sort = Query.Sort(["createdAt", "title"]);

  it("decodes sort terms with direction prefixes", () => {
    expect(Schema.decodeUnknownSync(sort)("-createdAt,title")).toEqual([
      { field: "createdAt", direction: "desc" },
      { field: "title", direction: "asc" },
    ]);
  });

  it("rejects unknown sort fields (→ 400)", () => {
    expect(() => Schema.decodeUnknownSync(sort)("body")).toThrow();
  });

  it("encodes sort terms back to the wire form", () => {
    expect(
      Schema.encodeUnknownSync(sort)([
        { field: "createdAt", direction: "desc" },
        { field: "title", direction: "asc" },
      ]),
    ).toBe("-createdAt,title");
  });
});

describe("an empty vocabulary says so when it rejects a value (#282)", () => {
  // `Schema.Literals([])` is `never`; its rejection would read "Expected never".
  const Tag = Resource("tags", { attributes: {} });

  const cases: ReadonlyArray<
    readonly [name: string, schema: Schema.Codec<unknown, unknown>, input: unknown, what: string]
  > = [
    ["Query.Include over no relationships", Query.Include(Tag), "author", "include paths"],
    [
      "Query.Include with no paths",
      Query.Include(Article, { paths: [] }),
      "author",
      "include paths",
    ],
    ["Query.Sort with no fields", Query.Sort([]), "-title", "sortable fields"],
    [
      "Query.schema's sort over no attributes",
      Query.schema(Tag, { sort: true }),
      { sort: "title" },
      "sortable fields",
    ],
    [
      "Query.Fieldset over no attributes (#261)",
      Query.Fieldset(Tag),
      "name",
      'sparse fieldset for type "tags"',
    ],
    [
      "Query.schema's fieldset for a type with no attributes (#261)",
      Query.schema(Tag, { fields: true }),
      { "fields[tags]": "name" },
      'sparse fieldset for type "tags"',
    ],
  ];

  it.each(cases)("%s", (_, schema, input, what) => {
    expect(() => Schema.decodeUnknownSync(schema)(input)).toThrow(
      `This endpoint supports no ${what}.`,
    );
  });

  it("leaves a non-empty vocabulary's rejection as it was", () => {
    expect(() => Schema.decodeUnknownSync(Query.Sort(["title"]))("body")).toThrow(
      'Expected "title"',
    );
    expect(() => Schema.decodeUnknownSync(Query.Fieldset(Article))("nope")).toThrow(/^Expected "/);
  });
});

describe("Query.schema", () => {
  const query = Query.schema(Article, {
    include: true,
    fields: true,
    sort: true,
    page: Query.Page.Offset,
    filter: { author: Schema.String },
  });

  it("decodes a full flat query into the nested ergonomic shape", () => {
    const decoded = Schema.decodeUnknownSync(query)({
      include: "author,comments.author",
      "fields[articles]": "title,body",
      "fields[people]": "firstName",
      sort: "-createdAt",
      "page[offset]": "20",
      "page[limit]": "10",
      "filter[author]": "9",
    });
    expect(decoded).toEqual({
      include: ["author", "comments.author"],
      fields: { articles: ["title", "body"], people: ["firstName"] },
      sort: [{ field: "createdAt", direction: "desc" }],
      page: { offset: 20, limit: 10 },
      filter: { author: "9" },
    });
  });

  it("decodes an empty query (all features optional)", () => {
    expect(Schema.decodeUnknownSync(query)({})).toEqual({});
  });

  it("decodes partial queries", () => {
    const decoded = Schema.decodeUnknownSync(query)({ "page[limit]": "5" });
    expect(decoded).toEqual({ page: { limit: 5 } });
  });

  it("rejects unknown include paths in the combined schema", () => {
    expect(() => Schema.decodeUnknownSync(query)({ include: "publisher" })).toThrow();
  });

  it("carries a constrained include through the combined schema", () => {
    const constrained = Query.schema(Article, {
      include: { paths: ["author"] },
      page: Query.Page.Offset,
    });
    expect(
      Schema.decodeUnknownSync(constrained)({ include: "author", "page[limit]": "5" }),
    ).toEqual({
      include: ["author"],
      page: { limit: 5 },
    });
    expect(() => Schema.decodeUnknownSync(constrained)({ include: "comments" })).toThrow();
    expectTypeOf<typeof constrained.Type>().toEqualTypeOf<{
      readonly include?: ReadonlyArray<"author">;
      readonly page?: { readonly offset?: number; readonly limit?: number };
    }>();
  });

  it("omits the include parameter when the option is off (regression)", () => {
    const noInclude = Query.schema(Article, { include: false, sort: true });
    expect(() =>
      Schema.decodeUnknownSync(noInclude)({ include: "author" }, { onExcessProperty: "error" }),
    ).toThrow();
    expectTypeOf<typeof noInclude.Type>().toEqualTypeOf<{
      readonly sort?: ReadonlyArray<{
        readonly field: "title" | "body" | "createdAt";
        readonly direction: "asc" | "desc";
      }>;
    }>();
  });

  it("rejects unknown sparse fieldsets", () => {
    expect(() => Schema.decodeUnknownSync(query)({ "fields[articles]": "secret" })).toThrow();
  });

  it("rejects non-numeric page parameters", () => {
    expect(() => Schema.decodeUnknownSync(query)({ "page[offset]": "abc" })).toThrow();
  });

  it("encodes the nested shape back to flat wire parameters (client side)", () => {
    const encoded = Schema.encodeUnknownSync(query)({
      include: ["author"],
      fields: { articles: ["title"] },
      sort: [{ field: "createdAt", direction: "desc" }],
      page: { offset: 0, limit: 10 },
      filter: { author: "9" },
    });
    expect(encoded).toEqual({
      include: "author",
      "fields[articles]": "title",
      sort: "-createdAt",
      "page[offset]": "0",
      "page[limit]": "10",
      "filter[author]": "9",
    });
  });

  it("types the decoded query shape", () => {
    type Decoded = typeof query.Type;
    // include paths are typed literals derived from the relationship graph
    expectTypeOf<Decoded["include"]>().toEqualTypeOf<
      ReadonlyArray<"author" | "comments" | "comments.author"> | undefined
    >();
    expectTypeOf<NonNullable<Decoded["fields"]>["articles"]>().toEqualTypeOf<
      ReadonlyArray<"title" | "body" | "createdAt" | "author" | "comments"> | undefined
    >();
    expectTypeOf<NonNullable<Decoded["fields"]>["people"]>().toEqualTypeOf<
      ReadonlyArray<"firstName" | "lastName"> | undefined
    >();
    expectTypeOf<NonNullable<Decoded["page"]>["offset"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<NonNullable<Decoded["sort"]>[number]["field"]>().toEqualTypeOf<
      "title" | "body" | "createdAt"
    >();
    expectTypeOf<NonNullable<Decoded["filter"]>["author"]>().toEqualTypeOf<string>();
  });

  it("supports restricted sort fields", () => {
    const restricted = Query.schema(Article, { sort: ["createdAt"] });
    expect(Schema.decodeUnknownSync(restricted)({ sort: "-createdAt" })).toEqual({
      sort: [{ field: "createdAt", direction: "desc" }],
    });
    expect(() => Schema.decodeUnknownSync(restricted)({ sort: "title" })).toThrow();
    type Decoded = typeof restricted.Type;
    expectTypeOf<NonNullable<Decoded["sort"]>[number]["field"]>().toEqualTypeOf<"createdAt">();
  });

  it("builds an empty schema when no features are enabled", () => {
    const empty = Query.schema(Article, {});
    expect(Schema.decodeUnknownSync(empty)({})).toEqual({});
  });

  it("a paginated-only target gets no sparse fieldset; its related endpoint declares one (#311)", () => {
    const feedQuery = Query.schema(Feed, { include: true, fields: true });
    const decoded = Schema.decodeUnknownSync(feedQuery)({
      "fields[feeds]": "name",
      "fields[people]": "firstName",
    });
    expect(decoded).toEqual({ fields: { feeds: ["name"], people: ["firstName"] } });
    // Article is only reachable via the paginated `entries` relationship,
    // which is never an include path (so never in a feed's `included`): the
    // feed's query declares no `fields[articles]`.
    expect(() => Schema.decodeUnknownSync(feedQuery)({ include: "entries" })).toThrow();
    expect(feedQuery.from.fields).not.toHaveProperty(["fields[articles]"]);
    expect(feedQuery.from.fields).toHaveProperty(["fields[people]"]);
    type FeedFieldsets = keyof NonNullable<typeof feedQuery.Type.fields>;
    expectTypeOf<FeedFieldsets>().toEqualTypeOf<"feeds" | "people">();
    // The related endpoint, whose primary data the articles are, declares it.
    const entries = Query.schema(Article, { fields: true });
    expect(
      Schema.decodeUnknownSync(entries)({ "fields[articles]": "title" }).fields?.articles,
    ).toEqual(["title"]);
  });

  describe("definitions sharing a wire type share one fields[TYPE] vocabulary (#362)", () => {
    const Photo = Resource("photos", { attributes: { width: Schema.Number } });
    const PhotoCard = Resource("photos", { attributes: { caption: Schema.String } });
    const coverFirst = Resource("g2", {
      attributes: { t: Schema.String },
      relationships: {
        cover: Relationship.one(() => Photo),
        thumb: Relationship.one(() => PhotoCard),
      },
    });
    const thumbFirst = Resource("g2", {
      attributes: { t: Schema.String },
      relationships: {
        thumb: Relationship.one(() => PhotoCard),
        cover: Relationship.one(() => Photo),
      },
    });

    it.each([
      ["cover before thumb", coverFirst],
      ["thumb before cover", thumbFirst],
    ])("accepts the union of their attributes (%s)", (_, Gallery) => {
      const query = Query.schema(Gallery, { fields: true });
      const decode = (value: string) =>
        Schema.decodeUnknownSync(query)({ "fields[photos]": value }).fields?.photos;
      expect(decode("width")).toEqual(["width"]);
      expect(decode("caption")).toEqual(["caption"]);
      expect(decode("width,caption")).toEqual(["width", "caption"]);
      expect(() => Schema.decodeUnknownSync(query)({ "fields[photos]": "t" })).toThrow();
      type Photos = NonNullable<NonNullable<(typeof query)["Type"]["fields"]>["photos"]>;
      expectTypeOf<Photos[number]>().toEqualTypeOf<"width" | "caption">();
    });
  });
});

describe("Query.Page", () => {
  it("provides offset, number and cursor strategies", () => {
    expect(Object.keys(Query.Page.Offset)).toEqual(["offset", "limit"]);
    expect(Object.keys(Query.Page.Number)).toEqual(["number", "size"]);
    expect(Object.keys(Query.Page.Cursor)).toEqual(["cursor", "size"]);
  });

  it("number strategy decodes page[number]/page[size]", () => {
    const query = Query.schema(Article, { page: Query.Page.Number });
    const decoded = Schema.decodeUnknownSync(query)({ "page[number]": "2", "page[size]": "25" });
    expect(decoded).toEqual({ page: { number: 2, size: 25 } });
  });

  it("cursor strategy keeps the cursor opaque", () => {
    const query = Query.schema(Article, { page: Query.Page.Cursor });
    const decoded = Schema.decodeUnknownSync(query)({ "page[cursor]": "opaque-token" });
    expect(decoded).toEqual({ page: { cursor: "opaque-token" } });
  });
});

describe("Query.Page.offset (factory)", () => {
  it("produces the same { offset, limit } shape as the constant", () => {
    expect(Object.keys(Query.Page.offset())).toEqual(["offset", "limit"]);
  });

  it("fromString: false decodes a plain number and rejects a numeric string", () => {
    const page = Schema.Struct(Query.Page.offset({ fromString: false }));
    expect(Schema.decodeUnknownSync(page)({ offset: 0, limit: 50 })).toEqual({
      offset: 0,
      limit: 50,
    });
    expect(() => Schema.decodeUnknownSync(page)({ limit: "50" })).toThrow();
  });

  it("fromString: true (default) decodes a numeric string and rejects a plain number", () => {
    const page = Schema.Struct(Query.Page.offset());
    expect(Schema.decodeUnknownSync(page)({ offset: "0", limit: "50" })).toEqual({
      offset: 0,
      limit: 50,
    });
    expect(() => Schema.decodeUnknownSync(page)({ limit: 50 })).toThrow();
  });

  it("maxLimit rejects maxLimit + 1 and accepts maxLimit", () => {
    const page = Schema.Struct(Query.Page.offset({ maxLimit: 100, fromString: false }));
    expect(Schema.decodeUnknownSync(page)({ limit: 100 })).toEqual({ limit: 100 });
    expect(() => Schema.decodeUnknownSync(page)({ limit: 101 })).toThrow();
  });

  it("minLimit defaults to 1 (rejects 0) and is configurable", () => {
    const dflt = Schema.Struct(Query.Page.offset({ fromString: false }));
    expect(() => Schema.decodeUnknownSync(dflt)({ limit: 0 })).toThrow();
    expect(Schema.decodeUnknownSync(dflt)({ limit: 1 })).toEqual({ limit: 1 });

    const floored = Schema.Struct(Query.Page.offset({ minLimit: 10, fromString: false }));
    expect(() => Schema.decodeUnknownSync(floored)({ limit: 9 })).toThrow();
    expect(Schema.decodeUnknownSync(floored)({ limit: 10 })).toEqual({ limit: 10 });
  });

  it("defaultLimit/defaultOffset fill in on an absent key", () => {
    const withDefaults = Schema.Struct(
      Query.Page.offset({ defaultLimit: 25, defaultOffset: 0, fromString: false }),
    );
    expect(Schema.decodeUnknownSync(withDefaults)({})).toEqual({ offset: 0, limit: 25 });
    // a present key still wins over the default
    expect(Schema.decodeUnknownSync(withDefaults)({ limit: 10 })).toEqual({ offset: 0, limit: 10 });
  });

  it("encodes a string default for a string-coercing field (fromString: true)", () => {
    // withDecodingDefaultKey takes the *encoded* default, so the string field
    // must default through a string and still decode to a number.
    const page = Schema.Struct(Query.Page.offset({ defaultLimit: 25 }));
    expect(Schema.decodeUnknownSync(page)({})).toEqual({ limit: 25 });
  });

  it("omitting a default leaves the field optionalKey (absent → undefined)", () => {
    const page = Schema.Struct(Query.Page.offset({ fromString: false }));
    expect(Schema.decodeUnknownSync(page)({})).toEqual({});
  });

  it("rejects negative offsets and non-integers on both fields", () => {
    const page = Schema.Struct(Query.Page.offset({ fromString: false }));
    expect(() => Schema.decodeUnknownSync(page)({ offset: -1 })).toThrow();
    expect(() => Schema.decodeUnknownSync(page)({ offset: 1.5 })).toThrow();
    expect(() => Schema.decodeUnknownSync(page)({ limit: 2.5 })).toThrow();
  });

  it("slots into Query.schema as a drop-in for the constant, carrying its bound", () => {
    const query = Query.schema(Article, { page: Query.Page.offset({ maxLimit: 100 }) });
    expect(Schema.decodeUnknownSync(query)({ "page[offset]": "20", "page[limit]": "10" })).toEqual({
      page: { offset: 20, limit: 10 },
    });
    expect(() => Schema.decodeUnknownSync(query)({ "page[limit]": "101" })).toThrow();
  });

  it("types a defaulted field as required and an un-defaulted field as optional", () => {
    const page = Schema.Struct(Query.Page.offset({ defaultLimit: 50, fromString: false }));
    type Decoded = typeof page.Type;
    expectTypeOf<Decoded["offset"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Decoded["limit"]>().toEqualTypeOf<number>();
    expectTypeOf<Decoded>().toEqualTypeOf<{ readonly offset?: number; readonly limit: number }>();

    // with fromString: true the *encoded* (wire) shape is strings
    const wire = Schema.Struct(Query.Page.offset({ defaultLimit: 50 }));
    type Encoded = typeof wire.Encoded;
    expectTypeOf<Encoded["limit"]>().toEqualTypeOf<string | undefined>();
  });
});

describe("Query.Page.number (factory)", () => {
  it("produces the { number, size } shape and decodes", () => {
    expect(Object.keys(Query.Page.number())).toEqual(["number", "size"]);
    const page = Schema.Struct(Query.Page.number({ fromString: false }));
    expect(Schema.decodeUnknownSync(page)({ number: 2, size: 25 })).toEqual({
      number: 2,
      size: 25,
    });
  });

  it("treats page numbers as 1-based (rejects 0)", () => {
    const page = Schema.Struct(Query.Page.number({ fromString: false }));
    expect(() => Schema.decodeUnknownSync(page)({ number: 0 })).toThrow();
    expect(Schema.decodeUnknownSync(page)({ number: 1 })).toEqual({ number: 1 });
  });

  it("bounds and defaults the size field", () => {
    const page = Schema.Struct(
      Query.Page.number({ maxSize: 50, defaultSize: 10, fromString: false }),
    );
    expect(Schema.decodeUnknownSync(page)({})).toEqual({ size: 10 });
    expect(() => Schema.decodeUnknownSync(page)({ size: 51 })).toThrow();
  });
});

describe("Query.bracketPageKeys", () => {
  // The flat list-input shape this combinator exists for: pagination merged
  // alongside the consumer's own filter fields, not nested under `page`.
  const ListArticles = Schema.Struct({
    ...Query.Page.offset({ maxLimit: 100, fromString: false }),
    authorId: Schema.optionalKey(Schema.String),
  });

  it("renames only the page cursor's encoded keys, leaving other fields flat", () => {
    const wire = Query.bracketPageKeys(ListArticles);
    expect(Object.keys(wire.from.fields).sort()).toEqual([
      "authorId",
      "page[limit]",
      "page[offset]",
    ]);
  });

  it("round-trips decode → encode through the bracket keys", () => {
    const wire = Query.bracketPageKeys(ListArticles);
    const encoded = { "page[offset]": 20, "page[limit]": 10, authorId: "9" };
    const decoded = Schema.decodeUnknownSync(wire)(encoded);

    // The decoded shape stays flat — the whole point of the combinator.
    expect(decoded).toEqual({ offset: 20, limit: 10, authorId: "9" });
    expect(Schema.encodeSync(wire)(decoded)).toEqual(encoded);
  });

  it("leaves the decoded type identical to the input struct's", () => {
    const wire = Query.bracketPageKeys(ListArticles);
    expectTypeOf<typeof wire.Type>().toEqualTypeOf<typeof ListArticles.Type>();
  });

  it("types the encoded side with the bracket keys", () => {
    const wire = Query.bracketPageKeys(ListArticles);
    expectTypeOf<typeof wire.Encoded>().toEqualTypeOf<{
      readonly "page[offset]"?: number;
      readonly "page[limit]"?: number;
      readonly authorId?: string;
    }>();
  });

  it("carries the checks of the underlying leaves through the rename", () => {
    const wire = Query.bracketPageKeys(ListArticles);
    expect(() => Schema.decodeUnknownSync(wire)({ "page[limit]": 101 })).toThrow();
  });

  it("bracket-keys the string-decoding Page.Offset constant too", () => {
    const wire = Query.bracketPageKeys(Schema.Struct(Query.Page.Offset));
    expect(Schema.decodeUnknownSync(wire)({ "page[offset]": "20", "page[limit]": "10" })).toEqual({
      offset: 20,
      limit: 10,
    });
  });

  it("produces the same wire keys Query.schema's page option does", () => {
    // The two compositions differ only in nesting: `Query.schema` nests the
    // decoded cursor under `page`, this leaves it flat. The wire keys match.
    const composed = Query.schema(Article, { page: Query.Page.Offset });
    const standalone = Query.bracketPageKeys(Schema.Struct(Query.Page.Offset));
    expect(Object.keys(standalone.from.fields).sort()).toEqual(
      Object.keys(composed.from.fields).sort(),
    );
    expect(
      Schema.decodeUnknownSync(composed)({ "page[offset]": "20", "page[limit]": "10" }),
    ).toEqual({
      page: { offset: 20, limit: 10 },
    });
  });
});

describe("Query.bracketKeys", () => {
  // The general form: any prefix, any subset of the struct's own keys.
  const ListArticles = Schema.Struct({
    ...Query.Page.offset({ maxLimit: 100, fromString: false }),
    authorId: Schema.optionalKey(Schema.String),
    status: Schema.optionalKey(Schema.String),
  });

  it("renames only the given keys under the given prefix, leaving the rest flat", () => {
    const wire = ListArticles.pipe(Query.bracketKeys("filter", ["status"]));
    expect(Object.keys(wire.from.fields).sort()).toEqual([
      "authorId",
      "filter[status]",
      "limit",
      "offset",
    ]);
  });

  it("round-trips decode → encode through the bracket keys", () => {
    const wire = ListArticles.pipe(Query.bracketKeys("filter", ["status"]));
    const encoded = { "filter[status]": "open", offset: 20, limit: 10, authorId: "9" };
    const decoded = Schema.decodeUnknownSync(wire)(encoded);
    expect(decoded).toEqual({ status: "open", offset: 20, limit: 10, authorId: "9" });
    expect(Schema.encodeSync(wire)(decoded)).toEqual(encoded);
  });

  it("reproduces bracketPageKeys' exact behaviour", () => {
    const wire = ListArticles.pipe(Query.bracketKeys("page", ["offset", "limit"]));
    const viaBracketPageKeys = Query.bracketPageKeys(ListArticles);
    expect(Object.keys(wire.from.fields).sort()).toEqual(
      Object.keys(viaBracketPageKeys.from.fields).sort(),
    );
    const encoded = { "page[offset]": 20, "page[limit]": 10, authorId: "9", status: "open" };
    expect(Schema.decodeUnknownSync(wire)(encoded)).toEqual(
      Schema.decodeUnknownSync(viaBracketPageKeys)(encoded),
    );
  });

  describe("composition", () => {
    const wire = ListArticles.pipe(
      Query.bracketKeys("page", ["offset", "limit"]),
      Query.bracketKeys("filter", ["authorId", "status"]),
    );

    it("bracket-keys every family applied so far, not just the last one", () => {
      expect(Object.keys(wire.from.fields).sort()).toEqual([
        "filter[authorId]",
        "filter[status]",
        "page[limit]",
        "page[offset]",
      ]);
    });

    it("round-trips decode → encode with both families bracketed", () => {
      const encoded = {
        "page[offset]": 20,
        "page[limit]": 10,
        "filter[authorId]": "9",
        "filter[status]": "open",
      };
      const decoded = Schema.decodeUnknownSync(wire)(encoded);
      expect(decoded).toEqual({ offset: 20, limit: 10, authorId: "9", status: "open" });
      expect(Schema.encodeSync(wire)(decoded)).toEqual(encoded);
    });

    it("types the decoded and encoded sides with every rename, not `Schema.Top`", () => {
      expectTypeOf<typeof wire.Type>().toEqualTypeOf<typeof ListArticles.Type>();
      expectTypeOf<typeof wire.Encoded>().toEqualTypeOf<{
        readonly "page[offset]"?: number;
        readonly "page[limit]"?: number;
        readonly "filter[authorId]"?: string;
        readonly "filter[status]"?: string;
      }>();
    });

    it("keys pass through Query.canonical in the fixed family order, whichever call bracketed them", () => {
      const flat = Query.canonical(wire);
      const keysOf = (s: string): ReadonlyArray<string> =>
        s.split("&").map((pair) => pair.split("=")[0]!);
      expect(keysOf(flat({ offset: 20, limit: 10, authorId: "9", status: "open" }))).toEqual([
        "filter[authorId]",
        "filter[status]",
        "page[offset]",
        "page[limit]",
      ]);
    });

    it("order does not depend on which prefix was bracketed first", () => {
      const reversed = ListArticles.pipe(
        Query.bracketKeys("filter", ["authorId", "status"]),
        Query.bracketKeys("page", ["offset", "limit"]),
      );
      expect(Object.keys(reversed.from.fields).sort()).toEqual(
        Object.keys(wire.from.fields).sort(),
      );
    });
  });

  it("carries the checks of the underlying leaves through the rename", () => {
    const wire = ListArticles.pipe(Query.bracketKeys("page", ["limit"]));
    expect(() => Schema.decodeUnknownSync(wire)({ "page[limit]": 101 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Repeated keys: every comma-separated family, not just `?include=`
// ---------------------------------------------------------------------------

describe("include: repeated keys", () => {
  const query = Query.schema(Article, {
    include: true,
    fields: true,
    sort: true,
    page: Query.Page.Offset,
    filter: undefined,
  });
  const decode = Schema.decodeUnknownSync(query as Schema.Codec<any, any>);

  it("decodes the spec's comma grammar (regression: unchanged)", () => {
    expect(decode({ include: "author,comments,comments.author" })).toEqual({
      include: ["author", "comments", "comments.author"],
    });
  });

  it("decodes the repeated-key spelling `UrlParams.toRecord` produces", () => {
    expect(decode({ include: ["author", "comments", "comments.author"] })).toEqual({
      include: ["author", "comments", "comments.author"],
    });
  });

  it("treats the two spellings as the same set, including the mixed form", () => {
    expect(decode({ include: ["author", "comments.author"] })).toEqual(
      decode({ include: "author,comments.author" }),
    );
    // a repeated key whose values are themselves comma lists
    expect(decode({ include: ["author", "comments,comments.author"] })).toEqual({
      include: ["author", "comments", "comments.author"],
    });
  });

  it("still rejects an unknown path in either spelling (400, not 200-with-nothing)", () => {
    expect(() => decode({ include: "nope" })).toThrow();
    expect(() => decode({ include: ["author", "nope"] })).toThrow();
  });

  it("still rejects an unlisted path when the endpoint constrains `paths`", () => {
    const constrained = Query.schema(Article, {
      include: { paths: ["author"] },
      fields: false,
      sort: false,
      page: undefined,
      filter: undefined,
    });
    const narrow = Schema.decodeUnknownSync(constrained as Schema.Codec<any, any>);
    expect(narrow({ include: ["author"] })).toEqual({ include: ["author"] });
    expect(() => narrow({ include: ["author", "comments"] })).toThrow();
  });

  it("encodes back to the single comma form (regression: the wire shape a client is handed)", () => {
    expect(
      Schema.encodeUnknownSync(query as Schema.Codec<any, any>)({
        include: ["author", "comments"],
      }),
    ).toEqual({
      include: "author,comments",
    });
  });
});

describe("sort and fields[TYPE]: repeated keys (issue #102)", () => {
  const query = Query.schema(Article, {
    include: true,
    fields: true,
    sort: true,
    page: Query.Page.Offset,
    filter: undefined,
  });
  const decode = Schema.decodeUnknownSync(query as Schema.Codec<any, any>);

  it("?sort=-createdAt&sort=title decodes the same as ?sort=-createdAt,title", () => {
    expect(decode({ sort: ["-createdAt", "title"] })).toEqual(decode({ sort: "-createdAt,title" }));
    expect(decode({ sort: ["-createdAt", "title"] })).toEqual({
      sort: [
        { field: "createdAt", direction: "desc" },
        { field: "title", direction: "asc" },
      ],
    });
  });

  it("?fields[articles]=title&fields[articles]=body decodes the same as the comma form", () => {
    expect(decode({ "fields[articles]": ["title", "body"] })).toEqual(
      decode({ "fields[articles]": "title,body" }),
    );
    expect(decode({ "fields[articles]": ["title", "body"] })).toEqual({
      fields: { articles: ["title", "body"] },
    });
  });

  it("accepts the mixed form for sort and fields too", () => {
    expect(decode({ sort: ["title", "-createdAt"] })).toEqual({
      sort: [
        { field: "title", direction: "asc" },
        { field: "createdAt", direction: "desc" },
      ],
    });
    expect(decode({ "fields[articles]": ["title,body"] })).toEqual({
      fields: { articles: ["title", "body"] },
    });
  });

  it("still rejects an unknown sort field or attribute name in either spelling", () => {
    expect(() => decode({ sort: ["nope"] })).toThrow();
    expect(() => decode({ "fields[articles]": ["secret"] })).toThrow();
  });

  // §Sparse Fieldsets: "An empty value indicates that no fields should be
  // returned", so an empty `fields[TYPE]=` is an empty set, not the absent
  // parameter (#488) — through the flat wire record and the nested one alike.
  it("?fields[articles]= decodes to the empty set, distinct from the absent parameter", () => {
    expect(decode({ "fields[articles]": "" })).toEqual({ fields: { articles: [] } });
    expect(decode({ "fields[articles]": [""] })).toEqual({ fields: { articles: [] } });
    expect(decode({})).toEqual({});
    expect(Schema.decodeUnknownSync(Query.Fieldset(Article))("")).toEqual([]);
    expect(Schema.encodeSync(query)({ fields: { articles: [] } })).toEqual({
      "fields[articles]": "",
    });
  });

  it("encodes both back to the single comma form", () => {
    const encoded = Schema.encodeUnknownSync(query as Schema.Codec<any, any>)({
      sort: [{ field: "createdAt", direction: "desc" }],
      fields: { articles: ["title", "body"] },
    });
    expect(encoded).toMatchObject({ sort: "-createdAt", "fields[articles]": "title,body" });
  });
});

describe("Query.Include / Query.Fieldset / Query.Sort: the standalone constructors compose Repeatable too", () => {
  it("Query.Include accepts the repeated-key spelling directly", () => {
    const include = Query.Include(Article);
    expect(Schema.decodeUnknownSync(include)(["author", "comments"])).toEqual([
      "author",
      "comments",
    ]);
  });

  it("Query.Fieldset accepts the repeated-key spelling directly", () => {
    const fieldset = Query.Fieldset(Article);
    expect(Schema.decodeUnknownSync(fieldset)(["title", "body"])).toEqual(["title", "body"]);
  });

  it("Query.Sort accepts the repeated-key spelling directly", () => {
    const sort = Query.Sort(["createdAt", "title"]);
    expect(Schema.decodeUnknownSync(sort)(["-createdAt", "title"])).toEqual([
      { field: "createdAt", direction: "desc" },
      { field: "title", direction: "asc" },
    ]);
  });
});

describe("empty comma segments: normalised away, not treated as an item", () => {
  it("a double comma and a trailing comma both drop the empty segment", () => {
    const include = Query.Include(Article);
    expect(Schema.decodeUnknownSync(include)("author,,comments")).toEqual(["author", "comments"]);
    expect(Schema.decodeUnknownSync(include)("author,comments,")).toEqual(["author", "comments"]);
    expect(Schema.decodeUnknownSync(include)(",author")).toEqual(["author"]);
  });

  it("the whole-string empty case still decodes to an empty list", () => {
    const include = Query.Include(Article);
    expect(Schema.decodeUnknownSync(include)("")).toEqual([]);
  });

  it("applies to Sort too: an empty term between commas is dropped, not a bad sort term", () => {
    const sort = Query.Sort(["createdAt", "title"]);
    expect(Schema.decodeUnknownSync(sort)("-createdAt,,title")).toEqual([
      { field: "createdAt", direction: "desc" },
      { field: "title", direction: "asc" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The canonical query string
// ---------------------------------------------------------------------------

describe("Query.canonical", () => {
  const query = Query.schema(Article, {
    include: true,
    fields: true,
    sort: true,
    page: Query.Page.Offset,
    filter: { author: Schema.String, q: Schema.String },
  });
  const decode = Schema.decodeUnknownSync(query as Schema.Codec<any, any>) as (
    input: Record<string, unknown>,
  ) => typeof query.Type;
  const canonical = Query.canonical(query);
  const pairs = Query.canonicalPairs(query);
  // `URLSearchParams` is what a client (and `UrlParams.toRecord`) parses the
  // string with; repeated keys never occur in canonical output.
  const parse = (s: string): Record<string, string> => Object.fromEntries(new URLSearchParams(s));

  const expected =
    "include=author%2Ccomments.author&fields[articles]=title%2Cbody&fields[people]=firstName" +
    "&filter[author]=9&filter[q]=hello%20world&sort=-createdAt%2Ctitle&page[offset]=20&page[limit]=10";

  it("emits the families in one order: include, fields, filter, sort, page", () => {
    expect(
      canonical({
        page: { limit: 10, offset: 20 },
        sort: [
          { field: "createdAt", direction: "desc" },
          { field: "title", direction: "asc" },
        ],
        filter: { q: "hello world", author: "9" },
        fields: { people: ["firstName"], articles: ["title", "body"] },
        include: ["author", "comments.author"],
      }),
    ).toBe(expected);
  });

  it("is byte-identical for equal queries whatever the wire spelling: key order and repeated include", () => {
    const spellings: ReadonlyArray<Record<string, unknown>> = [
      {
        include: "author,comments.author",
        "fields[articles]": "title,body",
        "fields[people]": "firstName",
        "filter[author]": "9",
        "filter[q]": "hello world",
        sort: "-createdAt,title",
        "page[offset]": "20",
        "page[limit]": "10",
      },
      {
        "page[limit]": "10",
        sort: "-createdAt,title",
        "filter[q]": "hello world",
        "fields[people]": "firstName",
        "page[offset]": "20",
        "filter[author]": "9",
        "fields[articles]": "title,body",
        include: "author,comments.author",
      },
      {
        "filter[author]": "9",
        "fields[people]": "firstName",
        include: ["author", "comments.author"], // ?include=author&include=comments.author
        "page[offset]": "20",
        "fields[articles]": "title,body",
        "page[limit]": "10",
        "filter[q]": "hello world",
        sort: "-createdAt,title",
      },
      {
        // repeated keys for `sort` and `fields[articles]` too — issue #102
        "filter[author]": "9",
        "fields[people]": "firstName",
        include: "author,comments.author",
        "page[offset]": "20",
        "fields[articles]": ["title", "body"], // ?fields[articles]=title&fields[articles]=body
        "page[limit]": "10",
        "filter[q]": "hello world",
        sort: ["-createdAt", "title"], // ?sort=-createdAt&sort=title
      },
    ];
    const strings = spellings.map((spelling) => canonical(decode(spelling)));
    expect(new Set(strings).size).toBe(1);
    expect(strings[0]).toBe(expected);
    // and the ordered pairs behind the string are the same list
    expect(pairs(decode(spellings[2]!))).toEqual(pairs(decode(spellings[0]!)));
    expect(pairs(decode(spellings[3]!))).toEqual(pairs(decode(spellings[0]!)));
  });

  it("decodes back to the same query through URLSearchParams and the same schema", () => {
    const decoded = decode({
      include: ["comments.author", "author"],
      "fields[articles]": "body",
      "filter[q]": "a,b & c=d?é\\,",
      "filter[author]": "",
      sort: "title",
      "page[limit]": "5",
    });
    const s = canonical(decoded);
    expect(s).toBe(
      "include=comments.author%2Cauthor&fields[articles]=body&filter[author]=&filter[q]=a%2Cb%20%26%20c%3Dd%3F%C3%A9%5C%2C&sort=title&page[limit]=5",
    );
    const params = new URLSearchParams(s);
    expect([...params.keys()].length).toBe(new Set(params.keys()).size);
    expect(decode(parse(s))).toEqual(decoded);
    expect(canonical(decode(parse(s)))).toBe(s);
  });

  it("omits absent values, keeps an empty string as `key=`, and is empty for an empty query", () => {
    expect(canonical({})).toBe("");
    expect(canonical({ include: [], filter: { author: "", q: "x" } })).toBe(
      "include=&filter[author]=&filter[q]=x",
    );
    expect(pairs({ page: { limit: 1 } })).toEqual([["page[limit]", "1"]]);
  });

  it("sorts fields[*] by type and the escape hatch's filter[*] by key, code-point order", () => {
    const Zed = Resource("zeds", { attributes: { n: Schema.String } });
    const Amp = Resource("amps", {
      attributes: { v: Schema.String },
      relationships: { zed: Relationship.one(() => Zed), article: Relationship.one(() => Article) },
    });
    const q = Query.schema(Amp, {
      fields: true,
      filter: { z: Schema.String, a: Schema.String, B: Schema.String },
    });
    expect(Query.canonical(q)({ fields: { zeds: ["n"], amps: ["v"], articles: ["title"] } })).toBe(
      "fields[amps]=v&fields[articles]=title&fields[zeds]=n",
    );
    // uppercase sorts before lowercase by code point, whatever the map declared
    expect(Query.canonical(q)({ filter: { z: "1", a: "2", B: "3" } })).toBe(
      "filter[B]=3&filter[a]=2&filter[z]=1",
    );
  });

  it("orders page[*] as the page strategy declares its keys, the order the link builders emit", () => {
    expect(canonical({ page: { limit: 10, offset: 0 } })).toBe("page[offset]=0&page[limit]=10");
    const number = Query.schema(Article, { page: Query.Page.Number });
    expect(Query.canonical(number)({ page: { size: 25, number: 2 } })).toBe(
      "page[number]=2&page[size]=25",
    );
    const cursor = Query.schema(Article, { page: Query.Page.Cursor });
    expect(Query.canonical(cursor)({ page: { size: 25, cursor: "opaque token" } })).toBe(
      "page[cursor]=opaque%20token&page[size]=25",
    );
  });

  it("accepts a consumer's own flat schema, its other keys sorted after the families", () => {
    const wire = Query.bracketPageKeys(
      Schema.Struct({
        ...Query.Page.offset({ fromString: false }),
        zone: Schema.optionalKey(Schema.String),
        authorId: Schema.optionalKey(Schema.String),
      }),
    );
    const flat = Query.canonical(wire);
    expect(flat({ zone: "au", limit: 10, authorId: "9", offset: 20 })).toBe(
      "page[offset]=20&page[limit]=10&authorId=9&zone=au",
    );
    // page keys in the struct's declared order, even though the values are plain numbers here
    expect(parse(flat({ limit: 10, offset: 20 }))).toEqual({
      "page[offset]": "20",
      "page[limit]": "10",
    });
  });

  it("emits an array value as the repeated key and omits null, so a consumer schema decodes back", () => {
    const wire = Schema.Struct({
      tag: Schema.optionalKey(Schema.Array(Schema.String)),
      flag: Schema.optionalKey(Schema.NullOr(Schema.String)),
      ...Query.Page.Offset,
    }).pipe(Schema.encodeKeys({ limit: "page[limit]", offset: "page[offset]" }));
    const flat = Query.canonical(wire);
    const s = flat({ tag: ["b", "a", "a"], flag: null, limit: 5 });
    expect(s).toBe("page[limit]=5&tag=b&tag=a&tag=a");
    // `UrlParams.toRecord` (what HttpApi hands the query schema) turns the repeated key back into the array
    const record = UrlParams.toRecord(UrlParams.fromInput(new URLSearchParams(s)));
    expect(record).toEqual({ "page[limit]": "5", tag: ["b", "a", "a"] });
    expect(Schema.decodeUnknownSync(wire)(record)).toEqual({ tag: ["b", "a", "a"], limit: 5 });
    // a lone item is one pair, and decodes back through the same schema as a one-element array
    expect(Query.canonicalPairs(wire)({ tag: ["only"] })).toEqual([["tag", "only"]]);
    expect(flat({ tag: [] })).toBe("");
    // `include` keeps its comma form, which is what the query schema itself encodes
    const withInclude = Schema.Struct({ include: Schema.optionalKey(Schema.Array(Schema.String)) });
    expect(Query.canonical(withInclude)({ include: ["author", "comments"] })).toBe(
      "include=author%2Ccomments",
    );
    expect(canonical(decode({ include: ["author", "comments"] }))).toBe(
      "include=author%2Ccomments",
    );
  });

  it("serialise: RFC 3986 percent-encoding, brackets readable in keys, spaces %20, commas %2C", () => {
    expect(
      Query.serialise([
        ["include", "author,comments"],
        ["filter[title]", "Hello, world"],
        ["filter[c0][condition][value]", "a\\,b+c/d"],
        ["fields[a b]", ""],
        ["page[offset]", "0"],
      ]),
    ).toBe(
      "include=author%2Ccomments&filter[title]=Hello%2C%20world&filter[c0][condition][value]=a%5C%2Cb%2Bc%2Fd&fields[a%20b]=&page[offset]=0",
    );
    expect(Query.serialise([])).toBe("");
    expect(parse(Query.serialise([["k", "a\\,b+c/d é"]]))).toEqual({ k: "a\\,b+c/d é" });
  });

  it("accepts exactly the schema's decoded type", () => {
    expectTypeOf(canonical).parameter(0).toEqualTypeOf<typeof query.Type>();
    expectTypeOf(pairs).parameter(0).toEqualTypeOf<typeof query.Type>();
    expectTypeOf(canonical).returns.toEqualTypeOf<string>();
    expectTypeOf(pairs).returns.toEqualTypeOf<ReadonlyArray<Query.Pair>>();
    // the values it rejects are asserted in test/rejected-calls.types.ts
  });
});

describe("Query.validateIncludePaths", () => {
  const options = { includable: ["author", "comments", "comments.author"], maxDepth: 2 };

  it("returns each path split into segments when every path is includable and within depth", () => {
    const result = Effect.runSync(
      Query.validateIncludePaths(["author", "comments.author"], options),
    );
    expect(result).toEqual([
      { path: "author", segments: ["author"] },
      { path: "comments.author", segments: ["comments", "author"] },
    ]);
  });

  it("returns an empty array for an empty request", () => {
    expect(Effect.runSync(Query.validateIncludePaths([], options))).toEqual([]);
  });

  it("fails with UnsupportedIncludePath for a path outside the includable set", () => {
    const thrown = Effect.runSync(Effect.flip(Query.validateIncludePaths(["publisher"], options)));
    expect(thrown).toBeInstanceOf(ApiError.UnsupportedIncludePath);
    expect(thrown).toMatchObject({ path: "publisher", includablePaths: options.includable });
  });

  it("fails with UnsupportedIncludeDepth for an over-deep path", () => {
    const thrown = Effect.runSync(
      Effect.flip(Query.validateIncludePaths(["comments.author.employer"], options)),
    );
    expect(thrown).toBeInstanceOf(ApiError.UnsupportedIncludeDepth);
    expect(thrown).toMatchObject({
      path: "comments.author.employer",
      maxDepth: 2,
      includablePaths: options.includable,
    });
  });

  it("checks depth before membership: an over-deep, non-includable path fails as depth, not membership", () => {
    const thrown = Effect.runSync(
      Effect.flip(Query.validateIncludePaths(["publisher.address.city"], options)),
    );
    expect(thrown).toBeInstanceOf(ApiError.UnsupportedIncludeDepth);
  });

  it("matches the whole dotted path, not just the head segment", () => {
    // "comments" alone is includable, but "comments.body" (a non-relationship
    // member) is not — membership is checked against the full path
    const thrown = Effect.runSync(
      Effect.flip(Query.validateIncludePaths(["comments.body"], options)),
    );
    expect(thrown).toBeInstanceOf(ApiError.UnsupportedIncludePath);
    expect(thrown).toMatchObject({ path: "comments.body" });
  });
});

describe("Query.schema: undeclared parameters never reach the decoded query (issue #260)", () => {
  // The wire record `UrlParams.toRecord` builds for a query string — what an
  // `HttpApiEndpoint` decodes its `query` schema from.
  const wire = (search: string) =>
    UrlParams.toRecord(UrlParams.fromInput(new URLSearchParams(search)));

  // Undeclared keys, including every bare/bracketed collision the one-level
  // reshaper could meet.
  const undeclared = [
    "x=1",
    "x=1&x[y]=2",
    "x[y]=1&x=2",
    "x=1&x=2&x[y]=3",
    "x[y]=1&x[y][z]=2",
    "x[y][z]=1&x[y]=2",
    "a[]=1",
    "a[]=1&a[]=2&a=3",
    "[x]=1&x[]=2&[]=3",
    `a${"[b]".repeat(2000)}=1&a=2&a[b]=3`,
    "fooBar=1&fooBar[x]=2",
    "lang=en&lang[region]=au",
    "__proto__=1",
    "__proto__[polluted]=yes",
    "constructor[prototype][polluted]=yes",
  ];
  // The same shapes under implementation-specific names (a character outside
  // a-z), which the `SchemaErrors` middleware lets through to decoding; an
  // all-lowercase one it rejects first (#148).
  const implementationSpecific = [
    "fooBar=1",
    "fooBar=1&fooBar[x]=2",
    "fooBar[x]=1&fooBar=2",
    "fooBar=1&fooBar=2&fooBar[x]=3",
    "fooBar[x]=1&fooBar[x][y]=2",
    "fooBar[]=1&fooBar[]=2&fooBar=3",
    "[x]=1&x-y[]=2&[]=3",
    `aB${"[b]".repeat(2000)}=1&aB=2&aB[b]=3`,
    "__proto__=1",
    "__proto__[polluted]=yes",
    "__proto__[polluted]=yes&__proto__=1",
  ];
  // A readable test title for a query string (the deep one is 6 kB).
  const titled = (searches: ReadonlyArray<string>) =>
    searches.map((search) => [search.length > 60 ? `${search.slice(0, 60)}…` : search, search]);

  // A reshaper that wrote through `__proto__` would pollute every object in
  // the process; undo it so one failure doesn't cascade into the rest.
  const polluted = () => Object.hasOwn(Object.prototype, "polluted");
  afterEach(() => {
    Reflect.deleteProperty(Object.prototype, "polluted");
  });

  const Tag = Resource("tags", {
    attributes: { label: attribute(Schema.String, { filter: true }) },
  });
  const empty = Query.schema(Tag, {});
  const grammar = Query.schema(Tag, { filter: true });
  const all = Query.schema(Article, {
    include: true,
    fields: true,
    sort: true,
    page: Query.Page.Offset,
    filter: { author: Schema.String },
  });

  // One schema per shape of flat struct `Query.schema` builds: empty, each
  // family on its own, every family together, and the `filter: true` grammar.
  const schemas: ReadonlyArray<readonly [string, Schema.Codec<unknown, unknown>]> = [
    ["empty", empty],
    ["sort", Query.schema(Tag, { sort: true })],
    ["fields", Query.schema(Tag, { fields: true })],
    ["page", Query.schema(Tag, { page: Query.Page.Offset })],
    ["filter map", Query.schema(Tag, { filter: { label: Schema.String } })],
    ["filter: true", grammar],
    ["all", all],
  ];

  describe.each(schemas)("%s", (_, schema) => {
    it.each(titled(undeclared))("?%s decodes to {}", (_, search) => {
      expect(Schema.decodeUnknownSync(schema)(wire(search))).toEqual({});
      expect(polluted()).toBe(false);
    });
  });

  it("an empty query schema encodes an undeclared key to nothing (client side)", () => {
    expect(Schema.encodeUnknownSync(empty)({ x: "1", y: { z: "2" } })).toEqual({});
  });

  it("declared parameters decode unchanged alongside undeclared ones", () => {
    expect(
      Schema.decodeUnknownSync(all)(
        wire(
          "include=author&fields[articles]=title&sort=-createdAt&page[limit]=5&filter[author]=9" +
            "&x=1&x[y]=2&page=3&include[x]=4&fields=5&filter=6&__proto__[polluted]=yes",
        ),
      ),
    ).toEqual({
      include: ["author"],
      fields: { articles: ["title"] },
      sort: [{ field: "createdAt", direction: "desc" }],
      page: { limit: 5 },
      filter: { author: "9" },
    });
    expect(
      Schema.decodeUnknownSync(grammar)(wire("filter[label]=a&x=1&x[y]=2&page[limit]=5")),
    ).toEqual({ filter: { _tag: "Compare", op: "eq", field: "label", value: "a" } });
  });

  describe("end to end: an endpoint whose query declares nothing", () => {
    const received: Array<unknown> = [];
    const get = Endpoint.get(Person);
    const Api = HttpApi.make("undeclared").add(Group.make(Person, get));
    const PeopleLive = HttpApiBuilder.group(Api, "people", (handlers) =>
      handlers.handle("get", ({ params, query }) => {
        received.push(query);
        return Effect.succeed({
          data: {
            type: "people" as const,
            id: params.id,
            attributes: { firstName: "A", lastName: "B" },
          },
        });
      }),
    );

    const request = async (
      url: string,
      middleware: Layer.Layer<
        Middleware.ContentNegotiation | Middleware.SchemaErrors
      > = Middleware.layer,
    ) => {
      const appLayer = HttpApiBuilder.layer(Api).pipe(
        Layer.provide(PeopleLive),
        Layer.provide(middleware),
        Layer.provide(platformLayer),
      );
      const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
      return (await handler(new Request(url)).finally(dispose)).status;
    };

    // A base name that is not a legal member name — `__proto__`, or the
    // empty one of `[x]` — is a 400 since #263 unless the allow-list admits
    // it. `__proto__` is admitted here, so the reshaper still sees it end to
    // end; an empty base name no entry can admit.
    const illegal = (search: string) => search.startsWith("[") || search.startsWith("__proto__");
    const proto = implementationSpecific.filter((search) => search.startsWith("__proto__"));
    const allowingProto = Middleware.layerWith({ allowedQueryParameters: ["__proto__"] });

    it.each(titled(implementationSpecific.filter((search) => !illegal(search))))(
      "answers 200 to ?%s and hands the handler {}",
      async (_, search) => {
        received.length = 0;
        expect(await request(`http://localhost/people/1?${search}`)).toBe(200);
        expect(received).toEqual([{}]);
        expect(polluted()).toBe(false);
      },
    );

    it.each(titled(proto))(
      "answers 200 to ?%s with `__proto__` allowed and hands the handler {}",
      async (_, search) => {
        received.length = 0;
        expect(await request(`http://localhost/people/1?${search}`, allowingProto)).toBe(200);
        expect(received).toEqual([{}]);
        expect(polluted()).toBe(false);
      },
    );

    it.each(titled(implementationSpecific.filter(illegal)))(
      "answers 400 to ?%s under the default allow-list, before the handler",
      async (_, search) => {
        received.length = 0;
        expect(await request(`http://localhost/people/1?${search}`)).toBe(400);
        expect(received).toEqual([]);
        expect(polluted()).toBe(false);
      },
    );
  });
});
