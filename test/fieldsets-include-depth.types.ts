/**
 * Type-level tests for the sparse fieldsets `fields: true` declares (#311).
 *
 * `fields: true` declares a `fields[TYPE]` for the resource, its direct
 * relationship targets and, when `include` is on, every type a legal include
 * path reaches. The runtime half is `src/Query.fieldsets.test.ts`; this file
 * pins the decoded `fields` struct and the flat `fields[TYPE]` keys, so that a
 * type the endpoint can carry in `included` is a key a client can write and a
 * type it can never carry is not.
 *
 * This file is type-checked by `tsconfig.json`; the `@ts-expect-error`
 * annotations are the assertions. Every negative assertion is paired with a
 * positive control, so an assertion cannot pass because the whole expression
 * broke.
 */
import * as Schema from "effect/Schema";
import type { HttpApiEndpoint } from "effect/http-api";
import { Endpoint, Include, Query, Relationship, Resource } from "@thomasfosterau/effect-jsonapi";

/** Pins a value to an expected type without using it (`noUnusedLocals`). */
const assertType = <Expected>(_value: Expected): void => {};

// Whether two types are identical, not merely mutually assignable.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const Label = Resource.make("labels", { attributes: {} });
const Revision = Resource.make("revisions", { attributes: { editedAt: Schema.String } });
const Company = Resource.make("companies", { attributes: { name: Schema.String } });
const Person = Resource.make("people", {
  attributes: { name: Schema.String, email: Schema.String },
  relationships: { employer: Relationship.one(() => Company) },
});
const Comment = Resource.make("comments", {
  attributes: { body: Schema.String },
  relationships: {
    author: Relationship.one(() => Person),
    label: Relationship.optional(() => Label),
    revisions: Relationship.paginated(() => Revision),
  },
});
const Tag = Resource.make("tags", { attributes: { name: Schema.String } });
const Article = Resource.make("articles", {
  attributes: { title: Schema.String },
  relationships: {
    comments: Relationship.many(() => Comment),
    tags: Relationship.many(() => Tag),
  },
});

// The decoded `fields` struct and the wire record of a query schema.
type FieldsOf<Q extends { readonly Type: { readonly fields?: unknown } }> = NonNullable<
  Q["Type"]["fields"]
>;
type FieldsetTypes<Q extends { readonly Type: { readonly fields?: unknown } }> = keyof FieldsOf<Q>;

// ---------------------------------------------------------------------------
// `include: true` — every type the depth-2 graph reaches
// ---------------------------------------------------------------------------

const deep = Query.schema(Article, { include: true, fields: true });

assertType<
  Equals<FieldsetTypes<typeof deep>, "articles" | "comments" | "tags" | "people" | "labels">
>(true);

// The depth-2 type's key is accepted, and narrowed to its own attributes.
const deepFields: FieldsOf<typeof deep> = { people: ["name"], comments: ["body"] };
assertType<FieldsOf<typeof deep>>(deepFields);
assertType<FieldsOf<typeof deep>>({
  // @ts-expect-error -- `title` is not a `people` attribute
  people: ["title"],
});

// A type no include path reaches is still rejected: `revisions` is behind a
// paginated relationship, `companies` three hops away.
assertType<FieldsOf<typeof deep>>({
  // @ts-expect-error -- `revisions` is unreachable
  revisions: ["editedAt"],
});
assertType<FieldsOf<typeof deep>>({
  // @ts-expect-error -- `companies` is past depth 2
  companies: ["name"],
});

// The flat wire keys follow the same set.
assertType<typeof deep.Encoded>({ "fields[people]": "name" });
assertType<typeof deep.Encoded>({
  // @ts-expect-error -- no wire key for an unreachable type
  "fields[revisions]": "editedAt",
});

// `Query.FieldsetResources` itself, with and without an `include` option.
assertType<
  Equals<
    Query.FieldsetResources<typeof Article, true>["type"],
    "articles" | "comments" | "tags" | "people" | "labels"
  >
>(true);
assertType<
  Equals<Query.FieldsetResources<typeof Article>["type"], "articles" | "comments" | "tags">
>(true);

// ---------------------------------------------------------------------------
// `include` off, a `depth`, an allow-list and a surface
// ---------------------------------------------------------------------------

const shallow = Query.schema(Article, { fields: true });
assertType<Equals<FieldsetTypes<typeof shallow>, "articles" | "comments" | "tags">>(true);
assertType<FieldsOf<typeof shallow>>({ comments: ["body"] });
assertType<FieldsOf<typeof shallow>>({
  // @ts-expect-error -- no include path, so no `people` fieldset
  people: ["name"],
});

const depth1 = Query.schema(Article, { include: { depth: 1 }, fields: true });
assertType<Equals<FieldsetTypes<typeof depth1>, "articles" | "comments" | "tags">>(true);

const depth3 = Query.schema(Article, { include: { depth: 3 }, fields: true });
assertType<
  Equals<
    FieldsetTypes<typeof depth3>,
    "articles" | "comments" | "tags" | "people" | "labels" | "companies"
  >
>(true);

const listed = Query.schema(Article, {
  include: { paths: ["comments.author.employer"] },
  fields: true,
});
assertType<
  Equals<FieldsetTypes<typeof listed>, "articles" | "comments" | "tags" | "people" | "companies">
>(true);

const surface = Include.make(Article, { comments: Include.nested(Comment, { author: Person }) });
const declared = Query.schema(Article, { include: surface, fields: true });
assertType<Equals<FieldsetTypes<typeof declared>, "articles" | "comments" | "tags" | "people">>(
  true,
);

// ---------------------------------------------------------------------------
// A heterogeneous endpoint, a self-referencing graph, and an endpoint
// ---------------------------------------------------------------------------

const mixed = Query.schema([Tag, Comment], { include: true, fields: true });
assertType<
  Equals<
    FieldsetTypes<typeof mixed>,
    "tags" | "comments" | "people" | "labels" | "revisions" | "companies"
  >
>(true);

const Territory = Resource.make("territories", { attributes: { region: Schema.String } });
const employeeAttributes = { name: Schema.String };
interface Employee extends Resource.Resource<
  "employees",
  typeof employeeAttributes,
  {
    readonly reportsTo: Relationship.optional<Employee>;
    readonly territories: Relationship.many<typeof Territory>;
  }
> {}
const Employee: Employee = Resource.make("employees", {
  attributes: employeeAttributes,
  relationships: {
    reportsTo: Relationship.optional(() => Employee),
    territories: Relationship.many(() => Territory),
  },
});
const Order = Resource.make("orders", {
  attributes: { shipped: Schema.Boolean },
  relationships: { employee: Relationship.one(() => Employee) },
});
const orders = Query.schema(Order, { include: true, fields: true });
assertType<Equals<FieldsetTypes<typeof orders>, "orders" | "employees" | "territories">>(true);
// The northwind case: `territories` is a target of `employees`, not `orders`.
assertType<FieldsOf<typeof orders>>({ territories: ["region"] });

// An endpoint's query carries the same set.
const get = Endpoint.get(Article, { include: true, fields: true });
type GetFields = NonNullable<HttpApiEndpoint.Query<typeof get>["Type"]["fields"]>;
assertType<Equals<keyof GetFields, FieldsetTypes<typeof deep>>>(true);
