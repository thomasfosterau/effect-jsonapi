/**
 * Declaration-emit test: a consumer compiling with `declaration: true` must be
 * able to export the values this package builds without annotating them
 * (#348).
 *
 * Declaration emit writes an exported value's inferred type into the
 * consumer's `.d.ts`, so every type that inferred type mentions must be
 * nameable from the consumer's file. That is narrower than "exported
 * somewhere": the TypeScript checker does not follow a namespace alias
 * (`export * as Query from "./Query.js"`) when it looks for a name. A type is
 * nameable only through a namespace the consumer's file imports itself, or
 * through a module that exports it directly — since #385, its module's own
 * subpath (`@thomasfosterau/effect-jsonapi/Query`), and before that the root's
 * type aliases (`src/index.ts`, now deprecated). When neither holds, the
 * checker reports TS2883 / TS4023 — or, worse, inlines the type structurally
 * until it reaches a name it cannot spell, such as `effect`'s
 * `NodeInspectSymbol` in an inlined error class.
 *
 * Every export below imports only the namespaces it calls, as the issue's
 * reproduction does. Two checks compile it with `declaration: true`, which
 * reports declaration diagnostics under `noEmit` without writing any file:
 * `tsconfig.dist.json` (`typecheck:dist`), and `test/declaration-emit.test.ts`,
 * which compiles it as a consumer that resolves the package through
 * `node_modules` and its `exports` map — with and without the root aliases —
 * alongside an endpoint, a group and a client over resources imported from
 * another file (#385).
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
export const getRelationshipInclude = Endpoint.getRelationship(Article, "comments", {
  include: true,
});
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
