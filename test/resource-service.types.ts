/**
 * Type-level tests for `ResourceService`: a service is typed by its
 * resource, and `layer` accepts only failures the group declares.
 *
 * This file is type-checked by `tsconfig.json`; the `@ts-expect-error`
 * annotations are the assertions, each paired with a positive control.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpApi } from "effect/http-api";
import * as ApiError from "../src/ApiError.js";
import * as Group from "../src/Group.js";
import * as Resource from "../src/Resource.js";
import * as ResourceService from "../src/ResourceService.js";

const Article = Resource.make("articles", { attributes: { title: Schema.String } });

class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
  status: 404,
  fields: { id: Schema.String },
}) {}
class Undeclared extends ApiError.make<Undeclared>()("Undeclared", {
  status: 418,
  fields: {},
}) {}

const Api = HttpApi.make("blog").add(
  Group.resource(Article, { errors: [ArticleNotFound], relationships: false }),
);

const declared: ResourceService.Service<typeof Article, ArticleNotFound> = {
  find: (id) => Effect.fail(new ArticleNotFound({ id })),
  create: (data) =>
    Effect.succeed(Article.make({ id: Article.Id.make("1"), attributes: data.attributes })),
};
ResourceService.layer(Api, "articles", Article, declared);

const undeclared: ResourceService.Service<typeof Article, Undeclared> = {
  find: () => Effect.fail(new Undeclared({})),
};
// @effect-diagnostics missingEffectError:off
// @ts-expect-error a failure the group does not declare would answer 500
ResourceService.layer(Api, "articles", Article, undeclared);
// @effect-diagnostics missingEffectError:error

ResourceService.layer(Api, "articles", Article, {
  // @ts-expect-error `find` takes the resource's branded id
  find: (id: number) => Effect.die(id),
});
