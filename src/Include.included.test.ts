/**
 * `Include.included`'s resource form (#342): `Include.included(resource,
 * { include })`, or `Include.included(members, { include })` for a
 * `collection` / `polymorphic` endpoint, builds the `included` union the
 * matching endpoint's default document binds (bar a declared surface on the
 * members form, which those endpoints ignore until #336) — so a wire-variant `success`
 * can reuse it rather than list every reachable type by hand, and a type the
 * endpoint's include paths reach is never missing from it (a missing one is a
 * `ResponseEncodeError` on the path that reaches it, #320).
 *
 * Each pin compares the helper's union members with those of the default
 * document's `included` union, by identity. The type-level half is
 * `test/include-depth-included.types.ts`.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Document from "./Document.js";
import * as Endpoint from "./Endpoint.js";
import * as Include from "./Include.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";

const Revision = Resource.make("revisions", { attributes: { editedAt: Schema.String } });
// Three hops from `Article` (`owner.employer.holding`): only `depth: 3` reaches it.
const Holding = Resource.make("holdings", { attributes: { name: Schema.String } });
const Company = Resource.make("companies", {
  attributes: { name: Schema.String },
  relationships: { holding: Relationship.optional(() => Holding) },
});
const Person = Resource.make("people", {
  attributes: { name: Schema.String },
  relationships: { employer: Relationship.one(() => Company) },
});
const Comment = Resource.make("comments", {
  attributes: { body: Schema.String },
  relationships: {
    author: Relationship.one(() => Person),
    revisions: Relationship.paginated(() => Revision),
  },
});
// The family's base: its relationships are the family's, and its members'.
const Node = Resource.make("nodes", {
  attributes: { name: Schema.String },
  relationships: { employer: Relationship.optional(() => Company) },
});
const Author = Resource.extend(Node, "authors", {
  inheritId: true,
  relationships: { comments: Relationship.many(() => Comment) },
});
const Editor = Resource.extend(Node, "editors", {
  inheritId: true,
  relationships: { drafts: Relationship.paginated(() => Revision) },
});
const AnyNode = Resource.family(Node, [Author, Editor]);
const Article = Resource.make("articles", {
  attributes: { title: Schema.String },
  relationships: {
    comments: Relationship.many(() => Comment),
    history: Relationship.paginated(() => Revision),
    owner: Relationship.optional(() => AnyNode),
  },
});

// The members of a union schema (none for anything else).
const membersOf = (union: Schema.Top): ReadonlyArray<Schema.Top> =>
  Predicate.hasProperty(union, "members") && Array.isArray(union.members)
    ? union.members.filter(Schema.isSchema)
    : [];

// The `included` union of a JSON:API document struct —
// `included: Schema.optionalKey(Schema.Array(union))` — looking through a
// wrapper (`HttpApiSchema.asJson`'s) that holds the struct under `schema`;
// `Schema.Never`, which has no members, when there is none.
const includedOf = (schema: Schema.Top): Schema.Top => {
  if (Predicate.hasProperty(schema, "fields") && Predicate.hasProperty(schema.fields, "included")) {
    const optional = schema.fields.included;
    return Predicate.hasProperty(optional, "schema") &&
      Predicate.hasProperty(optional.schema, "value") &&
      Schema.isSchema(optional.schema.value)
      ? optional.schema.value
      : Schema.Never;
  }
  return Predicate.hasProperty(schema, "schema") && Schema.isSchema(schema.schema)
    ? includedOf(schema.schema)
    : Schema.Never;
};

// The same members, by identity, in any order: the order of `included`'s
// members carries no meaning.
const expectSameMembers = (actual: ReadonlyArray<unknown>, expected: ReadonlyArray<unknown>) => {
  expect(actual).toHaveLength(expected.length);
  expect(expected.filter((member) => !actual.includes(member))).toEqual([]);
};

// The helper's union is the endpoint's default document's `included` union.
const expectSameUnion = (
  helper: Schema.Top,
  endpoint: { readonly success: Iterable<Schema.Top> },
): void => {
  const [success] = endpoint.success;
  const union = includedOf(success);
  // Never vacuous: the document's `included` union was found.
  expect(membersOf(union).length).toBeGreaterThan(0);
  expectSameMembers(membersOf(helper), membersOf(union));
};

describe("Include.included(resource, { include }) is the default document's union (#342)", () => {
  const surface = Include.make(Article, {
    comments: Include.nested(Comment, { author: Person }),
  });

  it.each([
    ["off", false],
    ["true", true],
    ["a depth", { depth: 3 }],
    ["an allow-list", { paths: ["comments.author"] }],
  ] as const)("`get` and `list`, `include` %s", (_, include) => {
    const union = Include.included(Article, { include });
    expectSameUnion(union, Endpoint.get(Article, { include }));
    expectSameUnion(union, Endpoint.list(Article, { include }));
  });

  it("`get` and `list` under a declared surface: the surface's own union", () => {
    const union = Include.included(Article, { include: surface });
    expect(union).toBe(surface.included);
    expectSameUnion(union, Endpoint.get(Article, { include: surface }));
    expectSameUnion(union, Endpoint.list(Article, { include: surface }));
  });

  it("what `include: true` reaches: the family target and the paths through it, no paginated target", () => {
    expectSameMembers(membersOf(Include.included(Article, { include: true })), [
      Comment,
      AnyNode,
      Person,
      Company,
    ]);
  });

  it("`related`: its target's graph", () => {
    expectSameUnion(
      Include.included(Comment, { include: true }),
      Endpoint.related(Article, "comments", { include: true }),
    );
    expectSameUnion(
      Include.included(Comment, { include: false }),
      Endpoint.related(Article, "comments"),
    );
    // A family target walks the family's own graph.
    expectSameUnion(
      Include.included(AnyNode, { include: true }),
      Endpoint.related(Article, "owner", { include: true }),
    );
    const commentSurface = Include.make(Comment, { author: Person });
    expectSameUnion(
      Include.included(Comment, { include: commentSurface }),
      Endpoint.related(Article, "comments", { include: commentSurface }),
    );
  });

  it.each([
    ["off", false],
    ["true", true],
    ["a depth", { depth: 3 }],
  ] as const)("`collection` and `polymorphic`, `include` %s", (_, include) => {
    expectSameUnion(
      Include.included([Article, Person], { include }),
      Endpoint.collection([Article, Person], { name: "search", path: "/search", include }),
    );
    expectSameUnion(
      Include.included(AnyNode.members, { include }),
      Endpoint.polymorphic(AnyNode, { include }),
    );
  });

  it("`polymorphic` never admits a member's paginated target", () => {
    expectSameMembers(membersOf(Include.included(AnyNode.members, { include: true })), [
      Comment,
      Person,
      Company,
      Holding,
    ]);
  });

  it("`collection` and `polymorphic` under a declared surface: the surface's own union", () => {
    const union = Include.included([Article, Person], { include: surface });
    expect(union).toBe(surface.included);
    const nodeSurface = Include.make(Author, {
      comments: Include.nested(Comment, { author: Person }),
    });
    expect(Include.included(AnyNode.members, { include: nodeSurface })).toBe(nodeSurface.included);
    // Which `collection` and `polymorphic` do not bind yet (#336): their
    // documents keep the members' direct targets. When #336 is fixed these
    // flip, and the docs' caveat goes.
    const [success] = Endpoint.collection([Article, Person], {
      name: "search",
      path: "/search",
      include: surface,
    }).success;
    expectSameMembers(membersOf(includedOf(success)), [Comment, AnyNode, Company]);
    const [nodeSuccess] = Endpoint.polymorphic(AnyNode, { include: nodeSurface }).success;
    expectSameMembers(membersOf(includedOf(nodeSuccess)), [Comment, Company]);
  });

  it("an `include` that may be a surface or not: the union for the value it holds", () => {
    const pick = (useSurface: boolean) => (useSurface ? surface : true);
    expect(Include.included([Article, Person], { include: pick(true) })).toBe(surface.included);
    expectSameUnion(
      Include.included([Article, Person], { include: pick(false) }),
      Endpoint.collection([Article, Person], { name: "search", path: "/search", include: true }),
    );
  });

  it("a widened `include` is the value it holds at runtime", () => {
    const widen = (value: boolean): boolean => value;
    expectSameUnion(
      Include.included(Article, { include: widen(true) }),
      Endpoint.get(Article, { include: true }),
    );
    expectSameUnion(
      Include.included([Article, Person], { include: widen(false) }),
      Endpoint.collection([Article, Person], { name: "search", path: "/search" }),
    );
    // The members form too, though its type is the direct targets alone (#382).
    expectSameUnion(
      Include.included([Article, Person], { include: widen(true) }),
      Endpoint.collection([Article, Person], { name: "search", path: "/search", include: true }),
    );
    expectSameUnion(
      Include.included(AnyNode.members, { include: widen(true) }),
      Endpoint.polymorphic(AnyNode, { include: true }),
    );
  });

  it("encodes a wire variant's document carrying what `comments.author` reaches", () => {
    const WireArticle = Schema.Struct({ ...Article.fields });
    const included = Include.included(Article, { include: true });
    const document = Document.DataDocument(WireArticle, { included });
    const encode = Schema.encodeUnknownSync(document);
    const value = Schema.decodeUnknownSync(document)({
      data: { type: "articles", id: "1", attributes: { title: "Hello" } },
      included: [
        { type: "comments", id: "5", attributes: { body: "First" } },
        { type: "people", id: "9", attributes: { name: "Ada" } },
      ],
    });
    expect(() => encode(value)).not.toThrow();
  });
});

describe("Include.included(spec) is unchanged", () => {
  it("projects a declaration's union, one member per resource", () => {
    const union = Include.included({
      comments: Include.nested(Comment, { author: Person }),
    });
    expect(union.members).toEqual([Comment, Person]);
  });
});
