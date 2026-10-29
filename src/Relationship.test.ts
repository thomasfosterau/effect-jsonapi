import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { Schema } from "effect";
import * as Relationship from "./Relationship.js";
import {
  annotate,
  extend,
  make as Resource,
  relationships as relationshipsOf,
} from "./Resource.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

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

// A resource exercising all four relationship kinds.
const Article = Resource("articles", {
  attributes: { title: Schema.NonEmptyString },
  relationships: {
    author: Relationship.one(() => Person),
    editor: Relationship.optional(() => Person),
    comments: Relationship.many(() => Comment),
    revisions: Relationship.paginated(() => Comment),
  },
});

describe("Relationship constructors", () => {
  it("produce descriptors discriminated by kind", () => {
    expect(Relationship.one(() => Person).kind).toBe("one");
    expect(Relationship.optional(() => Person).kind).toBe("optional");
    expect(Relationship.many(() => Comment).kind).toBe("many");
    expect(Relationship.paginated(() => Comment).kind).toBe("paginated");
  });

  it("resolve their target through the thunk", () => {
    expect(Relationship.one(() => Person).ref().type).toBe("people");
    expect(Relationship.paginated(() => Comment).ref().type).toBe("comments");
  });
});

describe("Relationship predicates", () => {
  const one = Relationship.one(() => Person);
  const optional = Relationship.optional(() => Person);
  const many = Relationship.many(() => Comment);
  const paginated = Relationship.paginated(() => Comment);

  it("isLinkable: everything except paginated", () => {
    expect(Relationship.isLinkable(one)).toBe(true);
    expect(Relationship.isLinkable(optional)).toBe(true);
    expect(Relationship.isLinkable(many)).toBe(true);
    expect(Relationship.isLinkable(paginated)).toBe(false);
  });

  it("isToOne: one and optional", () => {
    expect(Relationship.isToOne(one)).toBe(true);
    expect(Relationship.isToOne(optional)).toBe(true);
    expect(Relationship.isToOne(many)).toBe(false);
    expect(Relationship.isToOne(paginated)).toBe(false);
  });

  it("isToMany: many and paginated", () => {
    expect(Relationship.isToMany(one)).toBe(false);
    expect(Relationship.isToMany(optional)).toBe(false);
    expect(Relationship.isToMany(many)).toBe(true);
    expect(Relationship.isToMany(paginated)).toBe(true);
  });
});

describe("Relationship wire schemas", () => {
  describe("one", () => {
    const schema = Relationship.schemaFor(Relationship.one(() => Person));

    it("accepts identifier linkage", () => {
      const decoded = Schema.decodeUnknownSync(schema)({ data: { type: "people", id: "9" } });
      expect(decoded.data).toEqual({ type: "people", id: "9" });
    });

    it("rejects null linkage (required relationship)", () => {
      expect(() => Schema.decodeUnknownSync(schema)({ data: null })).toThrow();
    });

    it("rejects missing data", () => {
      expect(() => Schema.decodeUnknownSync(schema)({})).toThrow();
    });

    it("rejects identifiers of the wrong type", () => {
      expect(() =>
        Schema.decodeUnknownSync(schema)({ data: { type: "comments", id: "9" } }),
      ).toThrow();
    });

    it("accepts optional links and meta", () => {
      const decoded = Schema.decodeUnknownSync(schema)({
        data: { type: "people", id: "9" },
        links: { self: "/articles/1/relationships/author", related: "/articles/1/author" },
        meta: { count: 1 },
      });
      expect(decoded.links?.related).toBe("/articles/1/author");
      expect(decoded.meta?.count).toBe(1);
    });
  });

  describe("optional", () => {
    const schema = Relationship.schemaFor(Relationship.optional(() => Person));

    it("accepts identifier linkage", () => {
      const decoded = Schema.decodeUnknownSync(schema)({ data: { type: "people", id: "9" } });
      expect(decoded.data).toEqual({ type: "people", id: "9" });
    });

    it("accepts null linkage (empty relationship)", () => {
      const decoded = Schema.decodeUnknownSync(schema)({ data: null });
      expect(decoded.data).toBeNull();
    });

    it("rejects missing data", () => {
      expect(() => Schema.decodeUnknownSync(schema)({})).toThrow();
    });
  });

  describe("many", () => {
    const schema = Relationship.schemaFor(Relationship.many(() => Comment));

    it("accepts identifier array linkage", () => {
      const decoded = Schema.decodeUnknownSync(schema)({
        data: [
          { type: "comments", id: "5" },
          { type: "comments", id: "6" },
        ],
      });
      expect(decoded.data).toHaveLength(2);
    });

    it("accepts an empty array", () => {
      expect(Schema.decodeUnknownSync(schema)({ data: [] }).data).toEqual([]);
    });

    it("rejects null linkage", () => {
      expect(() => Schema.decodeUnknownSync(schema)({ data: null })).toThrow();
    });

    it("rejects a single identifier (must be an array)", () => {
      expect(() =>
        Schema.decodeUnknownSync(schema)({ data: { type: "comments", id: "5" } }),
      ).toThrow();
    });
  });

  describe("paginated", () => {
    const schema = Relationship.schemaFor(Relationship.paginated(() => Comment));

    it("accepts links-only relationship objects (no data)", () => {
      const decoded = Schema.decodeUnknownSync(schema)({
        links: { related: "/articles/1/revisions" },
      });
      expect(decoded.links.related).toBe("/articles/1/revisions");
    });

    it("accepts a self link alongside related", () => {
      const decoded = Schema.decodeUnknownSync(schema)({
        links: {
          self: "/articles/1/relationships/revisions",
          related: "/articles/1/revisions",
        },
      });
      expect(decoded.links.self).toBe("/articles/1/relationships/revisions");
    });

    it("requires the related link", () => {
      expect(() => Schema.decodeUnknownSync(schema)({ links: { self: "/x" } })).toThrow();
      expect(() => Schema.decodeUnknownSync(schema)({})).toThrow();
    });

    it("has no data member in its type", () => {
      type Decoded = (typeof schema)["Type"];
      expectTypeOf<Decoded>().not.toHaveProperty("data");
    });

    it("accepts meta (e.g. a count) alongside links", () => {
      const decoded = Schema.decodeUnknownSync(schema)({
        links: { related: "/articles/1/revisions" },
        meta: { count: 412 },
      });
      expect(decoded.meta?.count).toBe(412);
    });
  });
});

describe("relationship kinds in resource objects", () => {
  it("decodes a resource exercising all four kinds", () => {
    const decoded = Schema.decodeUnknownSync(Article)({
      type: "articles",
      id: "1",
      attributes: { title: "Hello" },
      relationships: {
        author: { data: { type: "people", id: "9" } },
        editor: { data: null },
        comments: { data: [{ type: "comments", id: "5" }] },
        revisions: { links: { related: "/articles/1/revisions" } },
      },
    });
    expect(decoded.relationships?.author.data.id).toBe("9");
    expect(decoded.relationships?.editor.data).toBeNull();
    expect(decoded.relationships?.comments.data).toHaveLength(1);
    expect(decoded.relationships?.revisions.links.related).toBe("/articles/1/revisions");
  });

  it("rejects null linkage for a `one` relationship", () => {
    expect(() =>
      Schema.decodeUnknownSync(Article)({
        type: "articles",
        id: "1",
        attributes: { title: "Hello" },
        relationships: {
          author: { data: null },
          editor: { data: null },
          comments: { data: [] },
          revisions: { links: { related: "/articles/1/revisions" } },
        },
      }),
    ).toThrow();
  });

  it("rejects inline data for a `paginated` relationship", () => {
    expect(() =>
      Schema.decodeUnknownSync(Article)(
        {
          type: "articles",
          id: "1",
          attributes: { title: "Hello" },
          relationships: {
            author: { data: { type: "people", id: "9" } },
            editor: { data: null },
            comments: { data: [] },
            // data is not part of the paginated schema; links are required
            revisions: { data: [{ type: "comments", id: "5" }] },
          },
        },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
  });

  it("types `one` linkage as non-nullable and `optional` linkage as nullable", () => {
    type Rels = NonNullable<(typeof Article.Type)["relationships"]>;
    expectTypeOf<Rels["author"]["data"]>().toEqualTypeOf<typeof Person.identifier.Type>();
    expectTypeOf<Rels["editor"]["data"]>().toEqualTypeOf<typeof Person.identifier.Type | null>();
  });
});

// ---------------------------------------------------------------------------
// The canonical order of a paginated relationship (#113)
// ---------------------------------------------------------------------------

describe("Relationship.paginated `order`", () => {
  const Revision = Resource("revisions", {
    attributes: { note: Schema.NonEmptyString, createdAt: Schema.DateFromString },
  });

  it("carries the declared order on the descriptor, typed as sort terms", () => {
    const Page = Resource("pages", {
      attributes: { title: Schema.NonEmptyString },
      relationships: {
        revisions: Relationship.paginated(() => Revision, {
          order: [
            { field: "createdAt", direction: "desc" },
            { field: "id", direction: "asc" },
          ],
        }),
      },
    });

    expect(Page.relationships.revisions.order).toEqual([
      { field: "createdAt", direction: "desc" },
      { field: "id", direction: "asc" },
    ]);
    expectTypeOf(Page.relationships.revisions.order).toEqualTypeOf<
      readonly [
        { readonly field: "createdAt"; readonly direction: "desc" },
        { readonly field: "id"; readonly direction: "asc" },
      ]
    >();
  });

  it("is `undefined` when no order is declared", () => {
    expect(Relationship.paginated(() => Revision).order).toBeUndefined();
    expect(Article.relationships.revisions.order).toBeUndefined();
  });

  it("orders only by the related resource's attributes, or its id", () => {
    // @ts-expect-error -- "note" is Revision's, but "title" is not
    Relationship.paginated(() => Revision, { order: [{ field: "title", direction: "asc" }] });
    // the negative control: a real attribute of the *related* resource compiles
    expect(
      Relationship.paginated(() => Revision, { order: [{ field: "note", direction: "asc" }] })
        .order,
    ).toEqual([{ field: "note", direction: "asc" }]);

    // @ts-expect-error -- "sideways" is not a direction
    Relationship.paginated(() => Revision, { order: [{ field: "id", direction: "sideways" }] });
  });

  it("refuses an order that declares nothing, or orders twice by one field", () => {
    expect(() => Relationship.paginated(() => Revision, { order: [] })).toThrow(
      /declares no terms/,
    );
    expect(() =>
      Relationship.paginated(() => Revision, {
        order: [
          { field: "createdAt", direction: "asc" },
          { field: "createdAt", direction: "desc" },
        ],
      }),
    ).toThrow(/more than once/);
  });

  it("leaves the relationship's wire schema untouched — an order is not linkage", () => {
    const Page = Resource("ordered-pages", {
      attributes: { title: Schema.NonEmptyString },
      relationships: {
        revisions: Relationship.paginated(() => Revision, {
          order: [{ field: "id", direction: "asc" }],
        }),
      },
    });
    const schema = Relationship.schemaFor(Page.relationships.revisions);
    expect(Object.keys(schema.fields)).toEqual(["links", "meta"]);
    expect(Schema.decodeUnknownSync(schema)({ links: { related: "/pages/1/revisions" } })).toEqual({
      links: { related: "/pages/1/revisions" },
    });
  });
});

describe("Relationship.one / optional `key` (#509)", () => {
  const Owner = Resource("owners", { attributes: { name: Schema.NonEmptyString } });

  it("records the declared storage key on the descriptor, typed", () => {
    const Pet = Resource("pets", {
      attributes: { name: Schema.NonEmptyString },
      relationships: {
        owner: Relationship.one(() => Owner, { key: "ownerId" }),
        sitter: Relationship.optional(() => Owner, { key: "sitterId", filter: ["eq", "isnull"] }),
      },
    });
    expect(relationshipsOf(Pet).owner.key).toBe("ownerId");
    expect(relationshipsOf(Pet).sitter.key).toBe("sitterId");
    expect(relationshipsOf(Pet).sitter.filter).toEqual(["eq", "isnull"]);
    expectTypeOf(relationshipsOf(Pet).owner.key).toEqualTypeOf<"ownerId">();
    expectTypeOf(relationshipsOf(Pet).sitter.key).toEqualTypeOf<"sitterId">();
  });

  it("is `undefined` when none is declared", () => {
    expect(Relationship.one(() => Owner).key).toBeUndefined();
    expect(Relationship.optional(() => Owner, { filter: true }).key).toBeUndefined();
    expectTypeOf(Relationship.one(() => Owner).key).toEqualTypeOf<undefined>();
  });

  it("is a storage fact: the wire schema is unchanged", () => {
    const Keyed = Resource("keyed", {
      attributes: { name: Schema.String },
      relationships: { owner: Relationship.one(() => Owner, { key: "ownerId" }) },
    });
    const wire = {
      type: "keyed",
      id: "1",
      attributes: { name: "n" },
      relationships: { owner: { data: { type: "owners", id: "9" } } },
    };
    const decoded = Schema.decodeUnknownSync(Keyed)(wire);
    expect(decoded.relationships?.owner.data.id).toBe("9");
    // the key is never an attribute of the resource object
    expect(Object.keys(decoded.attributes)).toEqual(["name"]);
  });

  it("refuses an empty key when the relationship is declared", () => {
    expect(() => Relationship.one(() => Owner, { key: "" })).toThrow(
      /Relationship\.one: `key` is empty/,
    );
    expect(() => Relationship.optional(() => Owner, { key: "" })).toThrow(
      /Relationship\.optional: `key` is empty/,
    );
  });

  it("refuses, at Resource.make, a key that is an attribute name", () => {
    expect(() =>
      Resource("clash", {
        attributes: { ownerId: Schema.String },
        relationships: { owner: Relationship.one(() => Owner, { key: "ownerId" }) },
      }),
    ).toThrow(
      /Resource\.make\("clash"\): relationship "owner" declares storage key "ownerId", which is also an attribute/,
    );
  });

  it("refuses, at Resource.make, a key two to-one relationships share", () => {
    expect(() =>
      Resource("shared", {
        attributes: { name: Schema.String },
        relationships: {
          owner: Relationship.one(() => Owner, { key: "personId" }),
          sitter: Relationship.optional(() => Owner, { key: "personId" }),
        },
      }),
    ).toThrow(
      /relationships "owner" and "sitter" both declare storage key "personId"; each to-one relationship needs its own stored field/,
    );
  });

  it("survives Resource.extend and Resource.annotate, and is checked against what extend adds", () => {
    const Pet = Resource("pets", {
      attributes: { name: Schema.NonEmptyString },
      relationships: { owner: Relationship.one(() => Owner, { key: "ownerId" }) },
    });
    const Dog = extend(Pet, "dogs", { attributes: { breed: Schema.String } });
    expect(relationshipsOf(Dog).owner.key).toBe("ownerId");
    expectTypeOf(relationshipsOf(Dog).owner.key).toEqualTypeOf<"ownerId">();
    const Labelled = annotate(Pet, { title: "Pet" });
    expect(relationshipsOf(Labelled).owner.key).toBe("ownerId");
    expect(() => extend(Pet, "cats", { attributes: { ownerId: Schema.String } })).toThrow(
      /Resource\.extend\("cats"\): relationship "owner" declares storage key "ownerId", which is also an attribute/,
    );
  });
});
