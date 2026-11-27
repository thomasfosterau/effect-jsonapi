import { it } from "@effect/vitest";
import { assert, describe, expect } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { HttpApiGroup } from "effect/http-api";
import { HttpApi, HttpApiClient } from "effect/http-api";
import * as Client from "./Client.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import { MEDIA_TYPE } from "./internal/media.js";
import * as Query from "./Query.js";
import * as Resource from "./Resource.js";
import { stringify } from "./internal/json.js";

const Article = Resource.make("articles", { attributes: { title: Schema.String } });
const byOffset = Endpoint.list(Article, { page: Query.Page.Offset });
const byCursor = Endpoint.list(Article, { page: Query.Page.Cursor });
const OffsetApi = HttpApi.make("offset").add(Group.make(Article, byOffset));
const CursorApi = HttpApi.make("cursor").add(Group.make(Article, byCursor));

const article = (id: number) => ({
  type: "articles",
  id: String(id),
  attributes: { title: `#${id}` },
});

/** A server answering each request with the page `page` picks for its URL, recording the URLs. */
interface Page {
  readonly ids: ReadonlyArray<number>;
  readonly next: Option.Option<string>;
}
const empty: Page = { ids: [], next: Option.none() };

const server = (sent: Array<string>, page: (url: URL) => Page): HttpClient.HttpClient =>
  HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
    const url = Option.getOrElse(
      HttpClientRequest.toUrl(request),
      () => new URL("http://unbuildable.invalid"),
    );
    sent.push(url.href);
    const { ids, next } = page(url);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          stringify({ data: ids.map(article), links: { next: Option.getOrNull(next) } }),
          {
            status: 200,
            headers: { "content-type": MEDIA_TYPE },
          },
        ),
      ),
    );
  });

const offsetPages =
  (total: number) =>
  (url: URL): Page => {
    const offset = Number(url.searchParams.get("page[offset]") ?? "0");
    const limit = Number(url.searchParams.get("page[limit]") ?? "2");
    const ids = Array.from(
      { length: Math.max(0, Math.min(limit, total - offset)) },
      (_, i) => offset + i,
    );
    return {
      ids,
      next: Option.liftPredicate(
        `/articles?page[offset]=${offset + limit}&page[limit]=${limit}`,
        () => offset + limit < total,
      ),
    };
  };

/** Collects `stream(client)` with `http` as the transport. */
const collect = <Groups extends HttpApiGroup.Constraint, A, E>(
  api: HttpApi.HttpApi<string, Groups>,
  http: HttpClient.HttpClient,
  stream: (client: HttpApiClient.Client<Groups>) => Stream.Stream<A, E>,
): Effect.Effect<
  Array<A>,
  E,
  Exclude<HttpApiGroup.MiddlewareClient<Groups>, HttpClient.HttpClient>
> =>
  Effect.flatMap(Client.make(api, { baseUrl: "http://localhost" }), (client) =>
    Stream.runCollect(stream(client)),
  ).pipe(Effect.provideService(HttpClient.HttpClient, http));

describe("Client.pages", () => {
  it.effect("follows links.next until it is null, one request per page", () =>
    Effect.gen(function* () {
      const sent: Array<string> = [];
      const documents = yield* collect(OffsetApi, server(sent, offsetPages(5)), (client) =>
        Client.pages(byOffset, (query) => client.articles.list({ query }), { page: { limit: 2 } }),
      );
      expect(documents.map((document) => document.data.map((resource) => resource.id))).toEqual([
        ["0", "1"],
        ["2", "3"],
        ["4"],
      ]);
      expect(sent).toHaveLength(3);
    }),
  );

  it.effect("needs no page arithmetic: an opaque cursor is passed back as the server sent it", () =>
    Effect.gen(function* () {
      const sent: Array<string> = [];
      const cursors = HashMap.make<ReadonlyArray<readonly [string, Page]>>(
        [
          "",
          {
            ids: [1],
            next: Option.some("https://elsewhere.test/articles?page[cursor]=b%2Fc&page[size]=1"),
          },
        ],
        ["b/c", { ids: [2], next: Option.none() }],
      );
      const resources = yield* collect(
        CursorApi,
        server(sent, (url) =>
          HashMap.get(cursors, url.searchParams.get("page[cursor]") ?? "").pipe(
            Option.getOrElse(() => empty),
          ),
        ),
        (client) =>
          Client.items(byCursor, (query) => client.articles.list({ query }), { page: { size: 1 } }),
      );
      expect(resources.map((resource) => resource.id)).toEqual(["1", "2"]);
      expect(new URL(sent[1] ?? "").searchParams.get("page[cursor]")).toBe("b/c");
    }),
  );

  it.effect("stops requesting at maxPages", () =>
    Effect.gen(function* () {
      const sent: Array<string> = [];
      const resources = yield* collect(OffsetApi, server(sent, offsetPages(100)), (client) =>
        Client.items(
          byOffset,
          (query) => client.articles.list({ query }),
          { page: { limit: 2 } },
          { maxPages: 2 },
        ),
      );
      expect(resources.map((resource) => resource.id)).toEqual(["0", "1", "2", "3"]);
      expect(sent).toHaveLength(2);
    }),
  );

  it.effect("fails with the SchemaError when links.next carries a query the endpoint rejects", () =>
    Effect.gen(function* () {
      const sent: Array<string> = [];
      const exit = yield* Effect.exit(
        collect(
          OffsetApi,
          server(sent, () => ({ ids: [1], next: Option.some("/articles?page[offset]=minus-one") })),
          (client) => Client.pages(byOffset, (query) => client.articles.list({ query }), {}),
        ),
      );
      assert(Exit.isFailure(exit));
      expect(Schema.isSchemaError(Cause.squash(exit.cause))).toBe(true);
      expect(sent).toHaveLength(1);
    }),
  );
});
