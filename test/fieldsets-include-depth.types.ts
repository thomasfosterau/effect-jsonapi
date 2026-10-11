/**
 * Type-level tests for the sparse fieldsets `fields: true` declares (#311).
 *
 * `fields: true` declares a `fields[TYPE]` for every type the response can
 * carry: the resource, its non-`paginated` direct relationship targets
 * (unless `include` is a declared `Include.Surface`) and, when `include` is
 * on, every type a legal include path reaches. A type reachable only through
 * a `paginated` relationship, or a direct target a surface leaves out, is not
 * declared (owner decision on #311, 0.17.0). The runtime half is
 * `src/Query.fieldsets.test.ts`, whose `expectFieldsets` also checks each
 * runtime key set against the type's; this file
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
    history: Relationship.paginated(() => Revision),
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

// A type no include path reaches is rejected: `revisions` is behind a
// paginated relationship (`history`, `comments.revisions`), `companies` three
// hops away.
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
assertType<
  Equals<Query.FieldsetResources<typeof Article, false>["type"], "articles" | "comments" | "tags">
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
assertType<FieldsOf<typeof shallow>>({
  // @ts-expect-error -- `history` is paginated, so no `revisions` fieldset
  revisions: ["editedAt"],
});
assertType<typeof shallow.Encoded>({ "fields[tags]": "name" });
assertType<typeof shallow.Encoded>({
  // @ts-expect-error -- no wire key for a paginated-only target
  "fields[revisions]": "editedAt",
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

// A declared surface: exactly the resource and what its paths reach (its
// `included` union), so the direct target `tags` it leaves out is dropped.
const surface = Include.make(Article, { comments: Include.nested(Comment, { author: Person }) });
const declared = Query.schema(Article, { include: surface, fields: true });
assertType<Equals<FieldsetTypes<typeof declared>, "articles" | "comments" | "people">>(true);
assertType<
  Equals<
    Query.FieldsetResources<typeof Article, typeof surface>["type"],
    FieldsetTypes<typeof declared>
  >
>(true);
assertType<FieldsOf<typeof declared>>({ people: ["name"] });
assertType<FieldsOf<typeof declared>>({
  // @ts-expect-error -- the surface leaves `tags` out of `included`
  tags: ["name"],
});
assertType<typeof declared.Encoded>({ "fields[people]": "name" });
assertType<typeof declared.Encoded>({
  // @ts-expect-error -- no wire key for a direct target the surface leaves out
  "fields[tags]": "name",
});
// A surface over every direct target declares them all.
const wide = Query.schema(Article, {
  include: Include.make(Article, { comments: Comment, tags: Tag }),
  fields: true,
});
assertType<Equals<FieldsetTypes<typeof wide>, "articles" | "comments" | "tags">>(true);

// ---------------------------------------------------------------------------
// A heterogeneous endpoint, a self-referencing graph, and an endpoint
// ---------------------------------------------------------------------------

const mixed = Query.schema([Tag, Comment], { include: true, fields: true });
assertType<
  Equals<FieldsetTypes<typeof mixed>, "tags" | "comments" | "people" | "labels" | "companies">
>(true);
assertType<FieldsOf<typeof mixed>>({
  // @ts-expect-error -- `Comment`'s `revisions` is paginated
  revisions: ["editedAt"],
});
// Under a surface, every member plus what the surface's paths reach: the
// direct target `labels` it leaves out is dropped.
const mixedSurface = Query.schema([Tag, Comment], {
  include: Include.make(Comment, { author: Person }),
  fields: true,
});
assertType<Equals<FieldsetTypes<typeof mixedSurface>, "tags" | "comments" | "people">>(true);
assertType<FieldsOf<typeof mixedSurface>>({
  // @ts-expect-error -- the surface leaves `labels` out of `included`
  labels: [],
});

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
const list = Endpoint.list(Article, { include: surface, fields: true });
type ListFields = NonNullable<HttpApiEndpoint.Query<typeof list>["Type"]["fields"]>;
assertType<Equals<keyof ListFields, FieldsetTypes<typeof declared>>>(true);
