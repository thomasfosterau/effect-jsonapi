/**
 * The JSON:API v1.1 rules the constructors enforce at compile time, beside
 * the wire-level ones in `compliance.test.ts`. Every `@ts-expect-error` is an
 * assertion: an unused one is itself a compile error.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import {
  ApiError,
  Document,
  Endpoint,
  Group,
  Middleware,
  Relationship,
  Resource,
} from "@thomasfosterau/effect-jsonapi";

const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } });

const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString },
  relationships: {
    author: Relationship.optional(() => Person),
    comments: Relationship.paginated(() => Person),
  },
});

class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
  status: 404,
}) {}

// Only `ApiError.make` classes can be declared as an endpoint's errors, so
// every error body is an error document.
export const declaredError = Endpoint.get(Article, { errors: [ArticleNotFound] });
const PlainError = Schema.Struct({ message: Schema.String });
// @ts-expect-error -- a plain schema is no JSON:API error
export const plainError = Endpoint.get(Article, { errors: [PlainError] });

// A success document holds `data` and never `errors`; an error document the reverse.
// @ts-expect-error -- no `errors` member beside `data`
export const errorsBesideData = Document.DataDocument(Article).fields.errors;
// @ts-expect-error -- no `data` member beside `errors`
export const dataBesideErrors = Document.ErrorDocument().fields.data;

// Ids are branded per type, so one type's id is never another's.
// @ts-expect-error -- a person's id is not an article's
export const crossedId: typeof Article.Id.Type = Person.Id.make("9");

// POST and DELETE on a relationship are constructible only for to-many.
// @ts-expect-error -- `author` is to-one
export const addToOne = Endpoint.addRelationship(Article, "author");
// @ts-expect-error -- `author` is to-one
export const removeToOne = Endpoint.removeRelationship(Article, "author");

// The protocol middleware is attached to every endpoint, so its handlers
// build no complete layer until `Middleware.layer` is provided.
const Api = HttpApi.make("compliance").add(Group.make(Article, Endpoint.get(Article)));
const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers.handle("get", () => Effect.die("unused")),
);
const wired = ArticlesLive.pipe(Layer.provideMerge(Middleware.layer));
export const unwiredNeedsMiddleware: [
  Middleware.ContentNegotiation | Middleware.SchemaErrors,
] extends [Layer.Services<typeof ArticlesLive>]
  ? true
  : false = true;
export const wiredNeedsNothing: [Layer.Services<typeof wired>] extends [never] ? true : false =
  true;
