/**
 * Type-level tests for calls the package's constructors must reject at
 * compile time: an undeclared or wrong-kind relationship name, a missing
 * attribute, a filter operator or literal codec that doesn't fit, a sort term
 * over a field the related resource doesn't have, a decoded query of the wrong
 * shape, and an id that crosses a brand boundary.
 *
 * These assertions used to sit beside their runtime cases in the colocated
 * `src/*.test.ts` files (#436). They live here because a type-level test is a
 * `test/*.types.ts` file: it is type-checked by `tsconfig.json` and never run,
 * and `@ts-expect-error` is its assertion mechanism. Where a runtime case
 * also checks that the same call throws, it stays in the test file and passes
 * the ill-typed argument through an explicit cast.
 *
 * Every `@ts-expect-error` annotation below is an assertion: an unused one is
 * itself a compile error.
 */
import { Schema, SchemaGetter } from "effect";
import {
  Atomic,
  Endpoint,
  Filter,
  Query,
  Relationship,
  Resource,
  Sort,
} from "@thomasfosterau/effect-jsonapi";

// ---------------------------------------------------------------------------
// Fixtures: one relationship of every kind
// ---------------------------------------------------------------------------

const Person = Resource.make("people", {
  attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString },
});

const Comment = Resource.make("comments", {
  attributes: { body: Schema.NonEmptyString },
  // required to-one
  relationships: { author: Relationship.one(() => Person) },
});

const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString, body: Schema.String },
  relationships: {
    // nullable to-one
    author: Relationship.optional(() => Person),
    // inline to-many
    comments: Relationship.many(() => Comment),
    // unbounded to-many
    subscribers: Relationship.paginated(() => Person),
  },
});

// ---------------------------------------------------------------------------
// Atomic: operation constructors
// ---------------------------------------------------------------------------

// @ts-expect-error -- "publisher" is not a relationship of Article
export const atomicUnknownRelationship = Atomic.updateRelationship(Article, "1", "publisher", null);

// @ts-expect-error -- "author" is a to-one relationship; to-many constructors take to-many keys
export const atomicToOneAsToMany = Atomic.addToRelationship(Article, "1", "author", []);

// @ts-expect-error -- Comment.author is required, so it can't be set to null
export const atomicClearRequired = Atomic.updateRelationship(Comment, "5", "author", null);

// @ts-expect-error -- an `add` operation's data needs the resource's attributes
export const atomicMissingAttributes = Atomic.add(Article, {});

// ---------------------------------------------------------------------------
// Endpoint: relationship endpoints
// ---------------------------------------------------------------------------

// @ts-expect-error -- `author` is to-one; the spec defines POST only for to-many
export const addToOne = Endpoint.addRelationship(Article, "author");
// @ts-expect-error -- `author` is to-one; the spec defines DELETE only for to-many
export const removeToOne = Endpoint.removeRelationship(Article, "author");
// @ts-expect-error -- `publisher` is not a relationship of Article
export const relatedUnknown = Endpoint.related(Article, "publisher");
// @ts-expect-error -- `publisher` is not a relationship of Article
export const getRelationshipUnknown = Endpoint.getRelationship(Article, "publisher");

// ---------------------------------------------------------------------------
// Resource.family: a family as a relationship target
// ---------------------------------------------------------------------------

const Node = Resource.make("nodes", { attributes: { name: Schema.NonEmptyString } });
const FamilyPerson = Resource.extend(Node, "people", {
  inheritId: true,
  attributes: { firstName: Schema.String },
});
const Organisation = Resource.extend(Node, "organisations", {
  inheritId: true,
  attributes: { legalName: Schema.String },
});
const AnyNode = Resource.family(Node, [FamilyPerson, Organisation]);
const Edge = Resource.make("edges", {
  attributes: { weight: Schema.Number },
  relationships: { to: Relationship.one(() => AnyNode) },
});
type ToData = NonNullable<NonNullable<(typeof Edge.Type)["relationships"]>["to"]["data"]>;

// @ts-expect-error the family name is not a member linkage type
export const familyNameAsLinkage: ToData = { type: "nodes", id: "1" };

// ---------------------------------------------------------------------------
// Filter: operators, literal codecs and typed trees
// ---------------------------------------------------------------------------

// @ts-expect-error a typo is a compile error
export const opTypo = Filter.Op.eqq;

// @ts-expect-error an operator outside the core is a compile error
export const outsideCore = Filter.able(["between"]);

const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number });
const PointFromString = Schema.String.pipe(
  Schema.decodeTo(Point, {
    decode: SchemaGetter.transform((s: string) => {
      const [x = 0, y = 0] = s.split(":").map(Number);
      return { x, y };
    }),
    encode: SchemaGetter.transform((p: typeof Point.Type) => `${p.x}:${p.y}`),
  }),
);
// @ts-expect-error a literal codec for another type does not fit the schema
export const foreignLiteral = Schema.String.pipe(Filter.able(["eq"], { literal: PointFromString }));

type Fields = { readonly age: number; readonly status: "open" | "done" };
// @ts-expect-error an undeclared field is not a node of the tree
export const undeclaredField: Filter.Ast<Fields> = Filter.eq("title", "x");
// @ts-expect-error a literal of the wrong type is not a node of the tree
export const wrongLiteral: Filter.Ast<Fields> = Filter.eq("age", "18");

// ---------------------------------------------------------------------------
// Resource: filterable keys and the `filter` / `sort` sugar
// ---------------------------------------------------------------------------

const Supplier = Resource.make("suppliers", { attributes: { name: Schema.NonEmptyString } });
const Product = Resource.make("products", {
  attributes: {
    // plain: neither filterable nor sortable
    name: Schema.NonEmptyString,
    priceCents: Schema.Int.pipe(Filter.able()),
  },
  relationships: {
    supplier: Relationship.one(() => Supplier, { filter: ["eq", "in"] }),
    // unfilterable
    maker: Relationship.optional(() => Supplier),
  },
});
// @ts-expect-error an undeclared attribute is not a filterable key
export type FilterOnPlainAttribute = Resource.FilterOperators<typeof Product, "name">;
// @ts-expect-error an undeclared relationship is not a filterable key
export type FilterOnPlainRelationship = Resource.FilterOperators<typeof Product, "maker">;

const Status = Schema.Literals(["a", "b"]);
const Wide: Schema.Codec<string, string> = Schema.String;
const Narrow = Schema.String.pipe(
  Schema.decodeTo(Schema.Literals(["a"]), {
    decode: SchemaGetter.transform((): "a" => "a"),
    encode: SchemaGetter.transform((a: "a") => a),
  }),
);
// @ts-expect-error a codec narrower than the attribute does not fit (pipeable form)
export const narrowPiped = Status.pipe(Filter.able(["eq"], { literal: Narrow }));
// @ts-expect-error a codec narrower than the attribute does not fit (sugar)
export const narrowSugar = Resource.attribute(Status, { filter: ["eq"], filterLiteral: Narrow });
// @ts-expect-error a codec narrower than the attribute does not fit (read-only sugar)
export const narrowReadOnly = Resource.readOnlyAttribute(Status, {
  filter: ["eq"],
  filterLiteral: Narrow,
});
// @ts-expect-error a codec for another type does not fit (sugar)
export const foreignSugar = Resource.attribute(Schema.Number, {
  filter: ["eq"],
  filterLiteral: Wide,
});

const filterDeclared = Schema.Number.pipe(Filter.able(["eq"]));
const sortDeclared = Schema.Number.pipe(Sort.able());
// @ts-expect-error a schema already Filter.able cannot take the `filter` sugar
export const refiltered = Resource.attribute(filterDeclared, { filter: ["gt"] });
// @ts-expect-error a schema already Sort.able cannot take the `sort` sugar
export const resorted = Resource.attribute(sortDeclared, { sort: true });
// @ts-expect-error nor can readOnlyAttribute
export const refilteredReadOnly = Resource.readOnlyAttribute(filterDeclared, { filter: true });

// @ts-expect-error -- a non-literal boolean cannot decide the resource-object type
export const nonLiteralResource = Resource.attribute(Schema.String, { resource: Boolean(0) });

// ---------------------------------------------------------------------------
// Relationship.paginated: the declared order
// ---------------------------------------------------------------------------

const Revision = Resource.make("revisions", {
  attributes: { note: Schema.NonEmptyString, createdAt: Schema.DateFromString },
});
export const orderByForeignField = Relationship.paginated(() => Revision, {
  // @ts-expect-error -- "note" is Revision's, but "title" is not
  order: [{ field: "title", direction: "asc" }],
});
export const orderSideways = Relationship.paginated(() => Revision, {
  // @ts-expect-error -- "sideways" is not a direction
  order: [{ field: "id", direction: "sideways" }],
});

// ---------------------------------------------------------------------------
// Query.canonical: exactly the schema's decoded type
// ---------------------------------------------------------------------------

const canonical = Query.canonical(
  Query.schema(Article, {
    include: true,
    fields: true,
    sort: true,
    page: Query.Page.Offset,
    filter: { author: Schema.String, q: Schema.String },
  }),
);
// @ts-expect-error — `limit` is a number once decoded
export const stringLimit = canonical({ page: { limit: "10" } });
// @ts-expect-error — not a legal include path
export const illegalInclude = canonical({ include: ["publisher"] });
// @ts-expect-error — `filter` is the escape-hatch struct, not a tree
export const treeFilter = canonical({ filter: { status: "open" } });

// ---------------------------------------------------------------------------
// Resource.extend: ids across brand boundaries
// ---------------------------------------------------------------------------

const Account = Resource.make("accounts", { attributes: { email: Schema.NonEmptyString } });
const Admin = Resource.extend(Account, "admins", { attributes: { level: Schema.Int } });
const Manager = Resource.extend(Account, "managers", { inheritId: true });
const AdminId = Schema.String.pipe(Schema.brand("AdminId"));
const BrandedAdmin = Resource.extend(Account, "branded-admins", { id: AdminId });
const SuperAdminId = Schema.String.pipe(Schema.brand("SuperAdminId"));
const SuperAdmin = Resource.extend(BrandedAdmin, "superadmins", { id: SuperAdminId });

// @ts-expect-error a default-extended admin id is not assignable to an account id
export const adminAsAccount: typeof Account.Id.Type = Admin.Id.make("1");
// @ts-expect-error an account id lacks the managers brand
export const accountAsManager: typeof Manager.Id.Type = Account.Id.make("2");
// @ts-expect-error a consumer-branded admin id is not an account id
export const brandedAsAccount: typeof Account.Id.Type = BrandedAdmin.Id.make("1");
// @ts-expect-error SuperAdminId is not AdminId
export const superAsAdmin: typeof BrandedAdmin.Id.Type = SuperAdmin.Id.make("7");
export const contradictory = Resource.extend(Account, "contradictory", {
  id: AdminId,
  // @ts-expect-error `id` and `inheritId: true` are contradictory
  inheritId: true,
});
