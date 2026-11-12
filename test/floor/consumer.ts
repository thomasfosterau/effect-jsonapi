/**
 * A typed `Client.make` consumer, compiled against the lowest `effect` the
 * peer range admits (#586). On effect 4.0.x the `~Success` of a
 * `Group.resource` endpoint resolves to `any`, so every response type is lost
 * without an error at the call site; the assertions below turn that silent
 * loss into a compile error. Never executed.
 */
import { Effect, Schema } from "effect";
import { HttpApi } from "effect/http-api";
import { Client, Group, Resource } from "@thomasfosterau/effect-jsonapi";

const Article = Resource.make("articles", {
  attributes: { title: Schema.String },
});

const Api = HttpApi.make("blog").add(Group.resource(Article));

type IsAny<T> = 0 extends 1 & T ? true : false;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <_T extends true>(): void => {};

// The call site's result keeps the resource's attribute types.
export const program = Effect.gen(function* () {
  const client = yield* Client.make(Api, { baseUrl: "http://localhost" });
  const list = yield* client.articles.list({ query: {} });
  const title = list.data[0]!.attributes.title;
  assert<Equal<IsAny<typeof list>, false>>();
  // Sparse fieldsets may omit an attribute, hence the `undefined`.
  assert<Equal<Exclude<typeof title, undefined>, string>>();
  // On effect 4.0.x `title` is `any`, so this directive is unused and tsc
  // reports TS2578: that is the failure this file exists to catch.
  // @ts-expect-error -- `title` is a string, not a number
  const wrong: number = title;
  return wrong;
});
