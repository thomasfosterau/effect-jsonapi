/**
 * Declaration-emit test: a consumer compiling with `declaration: true` must be
 * able to export the values this package builds without annotating them
 * (#348).
 *
 * Declaration emit writes an exported value's inferred type into the
 * consumer's `.d.ts`, so every type that inferred type mentions must be
 * nameable from the consumer's file. Against the bundled `dist/index.d.ts`
 * that is narrower than "exported somewhere": the bundler lowers each
 * `export * as Query from "./Query.js"` to a module-local
 * `declare namespace Query_d_exports { export { QuerySchema, … } }`, and the
 * TypeScript checker does not follow a namespace alias when it looks for a
 * name. A type is nameable only through a namespace the consumer's file
 * imports itself, or through a direct export of the package root. When
 * neither holds, the checker reports TS4023 — or, worse, inlines the type
 * structurally until it reaches a name it cannot spell, such as `effect`'s
 * `NodeInspectSymbol` in an inlined error class.
 *
 * Every export below imports only the namespaces it calls, as the issue's
 * reproduction does, so a type it needs from any other module must reach it
 * through the root's own type exports (`src/index.ts`). Two checks compile it
 * with `declaration: true`, which reports declaration diagnostics under
 * `noEmit` without writing any file: `tsconfig.dist.json` (`typecheck:dist`),
 * and `test/declaration-emit.test.ts`, which compiles it as a consumer that
 * resolves the package through `node_modules` and so also sees a name only
 * the bundle's shared chunk exports.
 *
 * Out of scope here (#385): a file that exports an endpoint over a resource
 * *imported from another file* also needs the schema-tier types
 * (`Resource.Resource`, `Resource.Id`, …) that file has no namespace import
 * for.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiClient } from "effect/http-api";
import {
  Endpoint,
  FlatQuery,
  Group,
  Include,
  Relationship,
  Resource,
} from "@thomasfosterau/effect-jsonapi";

const Company = Resource.make("companies", { attributes: { name: Schema.String } });
const Person = Resource.make("people", {
  attributes: { name: Schema.String },
  relationships: { employer: Relationship.one(() => Company) },
});
const Comment = Resource.make("comments", {
  attributes: { body: Schema.String },
  relationships: { author: Relationship.one(() => Person) },
});
const Article = Resource.make("articles", {
  attributes: { title: Schema.String },
  relationships: {
    author: Relationship.one(() => Person),
    comments: Relationship.many(() => Comment),
  },
});
const Node = Resource.make("nodes", { attributes: { label: Schema.String } });
const Editor = Resource.extend(Node, "editors", { inheritId: true });
const Reviewer = Resource.extend(Node, "reviewers", { inheritId: true });
const AnyNode = Resource.family(Node, [Editor, Reviewer]);

// The issue's reproduction.
export const plain = Endpoint.get(Article);
export const include = Endpoint.get(Article, { include: true });
export const fields = Endpoint.get(Article, { fields: true });
export const includeFields = Endpoint.get(Article, { include: true, fields: true });

// Every endpoint kind, with the query families that change its inferred type.
export const list = Endpoint.list(Article, { include: true, sort: true, fields: true });
export const surface = Endpoint.list(Article, {
  include: Include.make(Article, { author: Include.nested(Person, { employer: Company }) }),
  fields: true,
});
export const create = Endpoint.create(Article);
export const update = Endpoint.update(Article);
export const remove = Endpoint.delete(Article);
export const collection = Endpoint.collection([Article, Person], {
  name: "search",
  path: "/search",
  fields: true,
});
export const collectionInclude = Endpoint.collection([Article, Person], {
  name: "search",
  path: "/search",
  include: true,
});
export const polymorphic = Endpoint.polymorphic(AnyNode, { include: true, fields: true });
export const polymorphicInclude = Endpoint.polymorphic(AnyNode, { include: true });
export const related = Endpoint.related(Article, "comments", { include: true, fields: true });
export const relatedOne = Endpoint.related(Article, "author");
export const getRelationship = Endpoint.getRelationship(Article, "author");
export const updateRelationship = Endpoint.updateRelationship(Article, "comments");
export const addRelationship = Endpoint.addRelationship(Article, "comments");
export const removeRelationship = Endpoint.removeRelationship(Article, "comments");
export const operations = Endpoint.operations([Article], { idempotency: true });
export const endpoints = Endpoint.resource(Article);

// The group constructors and the schema-tier `included` derivation.
export const group = Group.resource(Article);
export const flat = Group.flat({
  resource: Person,
  list: FlatQuery.listInput({ maxLimit: 100 }),
  create: Schema.Struct({ name: Schema.String }),
  update: Schema.Struct({ id: Schema.String }),
});
export const included = Include.included(Article, { include: true });
export const includedFamily = Include.included(AnyNode.members, { include: true });

// A client: its methods' error channels carry the middlewares' error classes
// as instance types, which no endpoint value spells out.
const Api = HttpApi.make("api")
  .add(Group.resource(Article))
  .add(
    Group.make(
      "writes",
      Endpoint.create(Article, { idempotency: true }),
      Endpoint.operations([Article], { idempotency: true }),
    ),
  );
export const client = HttpApiClient.make(Api, { baseUrl: "https://example.test" });
export const fetchArticle = (id: typeof Article.Id.Type) =>
  Effect.gen(function* () {
    const api = yield* HttpApiClient.make(Api, { baseUrl: "https://example.test" });
    return yield* api.articles.get({ params: { id }, query: {} });
  });
export const createArticle = (payload: (typeof Article.createPayload)["Type"]) =>
  Effect.gen(function* () {
    const api = yield* HttpApiClient.make(Api, { baseUrl: "https://example.test" });
    return yield* api.writes.create({ payload, headers: {} });
  });
