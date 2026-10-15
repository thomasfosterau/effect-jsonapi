/**
 * Declaration-emit test, the group-only half (#348): a module that builds its
 * API from `Group.resource` alone imports neither `Endpoint`, `Query`,
 * `Middleware` nor `Idempotency`, so every type the generated endpoints'
 * inferred types mention from those namespaces must be nameable through each
 * module's subpath (#385), or the deprecated root type aliases. See
 * `declaration-emit.types.ts` for why, and for the checks that compile both
 * files with `declaration: true`.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiClient } from "effect/http-api";
import { Group, Relationship, Resource } from "@thomasfosterau/effect-jsonapi";
import { ArticleNotFound } from "./declaration-emit-errors.types.js";

const Person = Resource.make("people", { attributes: { name: Schema.String } });
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

export const generated = Group.resource(Article);
export const included = Group.resource(Article, {
  include: true,
  fields: false,
  errors: [ArticleNotFound],
});
export const tuned = Group.resource(Article, { include: true, fields: true, idempotency: true });

const Api = HttpApi.make("api").add(tuned);
export const client = HttpApiClient.make(Api, { baseUrl: "https://example.test" });
export const createArticle = (payload: (typeof Article.createPayload)["Type"]) =>
  Effect.gen(function* () {
    const api = yield* HttpApiClient.make(Api, { baseUrl: "https://example.test" });
    return yield* api.articles.create({ payload, headers: {} });
  });
