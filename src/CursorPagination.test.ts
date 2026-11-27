/**
 * A collection that implements the Cursor Pagination profile end to end:
 * `page[size]` / `page[after]` / `page[before]`, the profile's errors, its
 * `meta.page` members, required `prev` / `next`, and the profile on the media
 * type.
 */
import { it } from "@effect/vitest";
import { describe, expect, onTestFinished } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as Conformance from "./Conformance.js";
import * as CursorPagination from "./CursorPagination.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import * as Middleware from "./Middleware.js";
import { platformLayer } from "./Registry.js";
import * as Resource from "./Resource.js";
import { MEDIA_TYPE } from "./internal/media.js";

const Article = Resource.make("articles", { attributes: { title: Schema.String } });

const Api = HttpApi.make("blog").add(
  Group.make(
    Article,
    Endpoint.list(Article, {
      page: CursorPagination.page(),
      meta: CursorPagination.CollectionMeta,
      profiles: [CursorPagination.PROFILE_URI],
      errors: CursorPagination.Errors,
    }),
  ),
);

const options = { maxSize: 3, defaultSize: 2 };

// Five articles in id order; an item's cursor is its id.
const ids = ["1", "2", "3", "4", "5"];
const article = (id: string) =>
  Article.make({
    id: Article.Id.make(id),
    attributes: { title: `Article ${id}` },
    meta: CursorPagination.itemMeta(id),
  });

const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers.handle("list", ({ query }) =>
    Effect.gen(function* () {
      const page = yield* CursorPagination.resolve(query.page ?? {}, options);
      const index = (cursor: string, parameter: "page[after]" | "page[before]") =>
        Option.match(
          Arr.findFirstIndex(ids, (id) => id === cursor),
          {
            onNone: () => Effect.fail(new CursorPagination.InvalidCursor({ parameter })),
            onSome: Effect.succeed,
          },
        );
      const start = Option.isSome(page.after)
        ? (yield* index(page.after.value, "page[after]")) + 1
        : 0;
      const end = Option.isSome(page.before)
        ? yield* index(page.before.value, "page[before]")
        : ids.length;
      // under `page[before]` the page is the items nearest the cursor
      const window = ids.slice(start, end);
      const items = Option.isSome(page.before)
        ? window.slice(-page.size)
        : window.slice(0, page.size);
      const from = start + window.indexOf(items[0] ?? "");
      return Handlers.collection(items.map(article), {
        meta: { page: { total: ids.length } },
        links: CursorPagination.links("/articles", page, {
          first: Arr.head(items),
          last: Arr.last(items),
          hasPrev: Option.some(Arr.isReadonlyArrayNonEmpty(items) ? from > 0 : start > 0),
          hasNext: Option.some(
            Arr.isReadonlyArrayNonEmpty(items)
              ? from + items.length < ids.length
              : end < ids.length,
          ),
        }),
      });
    }),
  ),
);

const get = async (path: string) => {
  const { dispose, handler } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide(ArticlesLive),
      Layer.provide(Middleware.layer),
      Layer.provide(platformLayer),
    ),
  );
  onTestFinished(() => dispose());
  const response = await handler(
    new Request(`http://localhost${path}`, { headers: { accept: MEDIA_TYPE } }),
  );
  // SAFETY: every response the api answers is a JSON document.
  const body = (await response.json()) as Schema.Json;
  return { status: response.status, contentType: response.headers.get("content-type"), body };
};

const pageOf = (body: Schema.Json): ReadonlyArray<string> =>
  Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
  )(body).data.map(({ id }) => id);

describe("a cursor-paginated collection", () => {
  it("serves the first page at the default size, naming the profile", async () => {
    const { status, contentType, body } = await get("/articles");
    expect(status).toBe(200);
    expect(contentType).toBe(`${MEDIA_TYPE};profile="${CursorPagination.PROFILE_URI}"`);
    expect(pageOf(body)).toEqual(["1", "2"]);
    expect(body).toMatchObject({
      data: [{ meta: { page: { cursor: "1" } } }, { meta: { page: { cursor: "2" } } }],
      meta: { page: { total: 5 } },
      links: {
        self: "/articles?page[size]=2",
        prev: null,
        next: "/articles?page[size]=2&page[after]=2",
      },
    });
  });

  it("pages after and before a cursor", async () => {
    const after = await get("/articles?page[size]=2&page[after]=2");
    expect(pageOf(after.body)).toEqual(["3", "4"]);
    expect(after.body).toMatchObject({
      links: {
        prev: "/articles?page[size]=2&page[before]=3",
        next: "/articles?page[size]=2&page[after]=4",
      },
    });

    const before = await get("/articles?page[size]=2&page[before]=3");
    expect(pageOf(before.body)).toEqual(["1", "2"]);
    expect(before.body).toMatchObject({ links: { prev: null } });

    const last = await get("/articles?page[size]=3&page[after]=3");
    expect(pageOf(last.body)).toEqual(["4", "5"]);
    expect(last.body).toMatchObject({ links: { next: null } });
  });

  it("answers an empty page past the end with no next page", async () => {
    const { body } = await get("/articles?page[after]=5");
    expect(pageOf(body)).toEqual([]);
    expect(body).toMatchObject({
      links: { prev: "/articles?page[size]=2&page[before]=5", next: null },
    });
  });

  it("refuses a size over the maximum with the profile's error", async () => {
    const { status, body } = await get("/articles?page[size]=4");
    expect(status).toBe(400);
    expect(body).toMatchObject({
      errors: [
        {
          status: "400",
          source: { parameter: "page[size]" },
          links: {
            type: "https://jsonapi.org/profiles/ethanresnick/cursor-pagination/max-size-exceeded",
          },
          meta: { page: { maxSize: 3 } },
        },
      ],
    });
  });

  it("refuses a size that is not a positive base-10 integer", async () => {
    const answers = await Promise.all(
      ["0", "1e1", "-1", "two"].map((size) => get(`/articles?page[size]=${size}`)),
    );
    expect(answers.map(({ status }) => status)).toEqual([400, 400, 400, 400]);
    expect(answers.map(({ body }) => body)).toMatchObject(
      Arr.replicate({ errors: [{ source: { parameter: "page[size]" } }] }, 4),
    );
  });

  it("refuses a range request and an unknown cursor", async () => {
    const range = await get("/articles?page[after]=1&page[before]=4");
    expect(range.status).toBe(400);
    expect(range.body).toMatchObject({
      errors: [
        {
          links: {
            type: "https://jsonapi.org/profiles/ethanresnick/cursor-pagination/range-pagination-not-supported",
          },
        },
      ],
    });
    const unknown = await get("/articles?page[after]=nope");
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ errors: [{ source: { parameter: "page[after]" } }] });
  });
});

describe("resolve", () => {
  it.effect("defaults a range request to the maximum size when served", () =>
    Effect.gen(function* () {
      const page = yield* CursorPagination.resolve(
        { after: "1", before: "5" },
        { ...options, range: true },
      );
      expect(page).toEqual({ size: 3, after: Option.some("1"), before: Option.some("5") });
    }),
  );

  it("reads a max-size error back from its document", () => {
    const error = new CursorPagination.MaxSizeExceeded({ maxSize: 3 });
    const wire = Schema.encodeSync(CursorPagination.MaxSizeExceeded.wire)(error);
    expect(Schema.decodeSync(CursorPagination.MaxSizeExceeded.wire)(wire)).toMatchObject({
      maxSize: 3,
    });
  });
});

// in report order: the spec tier first
const conformanceRules = [
  "spec/pagination/links-enumerate-collection",
  "profile/cursor-pagination/prev-next",
  "profile/cursor-pagination/page-size",
  "profile/cursor-pagination/invalid-size",
  "profile/cursor-pagination/max-size-exceeded",
];

// A run of the rules in process, its handlers and middleware from `live`.
const verifyOver = <ROut>(live: Layer.Layer<ROut>) =>
  // SAFETY: `live` provides every service the router needs; the platform
  // services `verify` names are never used.
  Conformance.verify(Api, { only: conformanceRules }).pipe(
    Effect.provide(live),
    Effect.scoped,
  ) as Effect.Effect<Conformance.Report>;

describe("the profile's conformance rules", () => {
  it.live("pass against the collection, with the spec's pagination walk", () =>
    Effect.gen(function* () {
      const report = yield* verifyOver(ArticlesLive.pipe(Layer.provideMerge(Middleware.layer)));
      expect(report.outcomes.map((outcome) => [outcome.rule.id, outcome._tag])).toEqual(
        conformanceRules.map((id) => [id, "Passed"]),
      );
    }),
  );
});
