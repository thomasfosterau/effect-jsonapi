import { describe, expect, onTestFinished } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as ApiError from "./ApiError.js";
import * as Conformance from "./Conformance.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Middleware from "./Middleware.js";
import * as Query from "./Query.js";
import * as Relationship from "./Relationship.js";
import { make as Resource } from "./Resource.js";
import * as ResourceService from "./ResourceService.js";
import { platformLayer } from "./Registry.js";
import { stringify } from "./internal/json.js";
import { MEDIA_TYPE } from "./internal/media.js";
import * as P from "effect/Predicate";

const Person = Resource("people", { attributes: { name: Schema.NonEmptyString } });
const Tag = Resource("tags", { attributes: { label: Schema.String } });
const Article = Resource("articles", {
  attributes: { title: Schema.NonEmptyString, rank: Schema.Int },
  relationships: {
    author: Relationship.one(() => Person),
    editor: Relationship.optional(() => Person),
    tags: Relationship.many(() => Tag),
  },
});

class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
  status: 404,
  fields: { id: Schema.String },
}) {}
class PersonNotFound extends ApiError.make<PersonNotFound>()("PersonNotFound", {
  status: 404,
  fields: { id: Schema.String },
}) {}

const Api = HttpApi.make("blog")
  .add(
    Group.resource(Article, {
      errors: [ArticleNotFound],
      page: Query.Page.Offset,
      endpoints: { list: { filter: { author: Schema.optionalKey(Schema.String) } } },
    }),
  )
  .add(
    Group.make(
      Person,
      Endpoint.get(Person, { errors: [PersonNotFound], name: "show", path: "/authors/:id" }),
    ),
  );

const people = [
  Person.make({ id: Person.Id.make("1"), attributes: { name: "Dan" } }),
  Person.make({ id: Person.Id.make("2"), attributes: { name: "Tyler" } }),
];
const tags = [Tag.make({ id: Tag.Id.make("t1"), attributes: { label: "news" } })];
const article = (id: string, title: string, rank: number, author: string) =>
  Article.make({
    id: Article.Id.make(id),
    attributes: { title, rank },
    relationships: {
      author: { data: Person.ref(Person.Id.make(author)) },
      editor: { data: null },
      tags: { data: id === "1" ? [Tag.ref(Tag.Id.make("t1"))] : [] },
    },
  });

const serve = () => {
  const peopleService = ResourceService.memory(Person, {
    notFound: (id) => new PersonNotFound({ id }),
    initial: people,
  });
  const tagService = ResourceService.memory(Tag, {
    notFound: (id) => new ArticleNotFound({ id }),
    initial: tags,
  });
  const app = Layer.unwrap(
    Effect.gen(function* () {
      const peopleLive = yield* peopleService;
      const tagLive = yield* tagService;
      return HttpApiBuilder.layer(Api).pipe(
        Layer.provide(
          ResourceService.layer(
            Api,
            "articles",
            Article,
            ResourceService.memory(Article, {
              notFound: (id) => new ArticleNotFound({ id }),
              initial: [
                article("1", "Bravo", 2, "1"),
                article("2", "Alpha", 1, "2"),
                article("3", "Charlie", 3, "1"),
              ],
            }),
            {
              include: {
                people: ResourceService.includeTarget(peopleLive),
                tags: ResourceService.includeTarget(tagLive),
              },
            },
          ),
        ),
        Layer.provide(ResourceService.layer(Api, "people", Person, peopleLive)),
      );
    }),
  ).pipe(Layer.provide(Middleware.layer), Layer.provide(platformLayer));
  const { dispose, handler } = HttpRouter.toWebHandler(app);
  onTestFinished(() => dispose());
  return async (method: string, path: string, body: Schema.Json = null) => {
    const response = await handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: { accept: MEDIA_TYPE, "content-type": MEDIA_TYPE },
        body: body === null ? null : stringify(body),
      }),
    );
    return {
      status: response.status,
      location: response.headers.get("location"),
      body: response.status === 204 ? undefined : await response.json(),
    };
  };
};

describe("ResourceService.layer over the in-memory service", () => {
  it("serves a resource with its included members", async () => {
    const request = serve();
    const { status, body } = await request("GET", "/articles/1?include=author,tags");
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ type: "articles", id: "1", attributes: { title: "Bravo" } });
    expect(body.links).toEqual({ self: "/articles/1" });
    expect(body.included.map((r: { type: string; id: string }) => `${r.type}:${r.id}`)).toEqual([
      "people:1",
      "tags:t1",
    ]);
  });

  it("answers the service's not-found error", async () => {
    const request = serve();
    const { status, body } = await request("GET", "/articles/9");
    expect(status).toBe(404);
    expect(body.errors[0].code).toBe("article_not_found");
  });

  it("filters, sorts and pages a list, with pagination links", async () => {
    const request = serve();
    const { status, body } = await request(
      "GET",
      "/articles?filter[author]=1&sort=-rank&page[offset]=0&page[limit]=1",
    );
    expect(status).toBe(200);
    expect(body.data.map((r: { id: string }) => r.id)).toEqual(["3"]);
    expect(body.links.next).toBe(
      "/articles?filter[author]=1&sort=-rank&page[offset]=1&page[limit]=1",
    );
    expect(body.links.prev).toBeNull();

    const sorted = await request("GET", "/articles?sort=title");
    expect(sorted.body.data.map((r: { id: string }) => r.id)).toEqual(["2", "1", "3"]);
  });

  it("creates, updates and deletes", async () => {
    const request = serve();
    const created = await request("POST", "/articles", {
      data: {
        type: "articles",
        attributes: { title: "Delta", rank: 4 },
        relationships: { author: { data: { type: "people", id: "2" } } },
      },
    });
    expect(created.status).toBe(201);
    expect(created.location).toBe("/articles/4");
    expect(created.body.data.relationships).toMatchObject({
      editor: { data: null },
      tags: { data: [] },
    });

    const updated = await request("PATCH", "/articles/4", {
      data: { type: "articles", id: "4", attributes: { title: "Echo" } },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.attributes).toEqual({ title: "Echo", rank: 4 });

    expect((await request("DELETE", "/articles/4")).status).toBe(204);
    expect((await request("GET", "/articles/4")).status).toBe(404);
  });

  it("serves related resources and linkage", async () => {
    const request = serve();
    const author = await request("GET", "/articles/2/author");
    expect(author.status).toBe(200);
    expect(author.body.data).toMatchObject({ type: "people", id: "2" });

    const editor = await request("GET", "/articles/2/editor");
    expect(editor.body.data).toBeNull();

    const related = await request("GET", "/articles/1/tags");
    expect(related.body.data.map((r: { id: string }) => r.id)).toEqual(["t1"]);

    const linkage = await request("GET", "/articles/1/relationships/tags");
    expect(linkage.body.data).toEqual([{ type: "tags", id: "t1" }]);
  });

  it("writes relationships", async () => {
    const request = serve();
    const added = await request("POST", "/articles/2/relationships/tags", {
      data: [{ type: "tags", id: "t1" }],
    });
    expect(added.status).toBe(200);
    expect(added.body.data).toEqual([{ type: "tags", id: "t1" }]);

    const removed = await request("DELETE", "/articles/2/relationships/tags", {
      data: [{ type: "tags", id: "t1" }],
    });
    expect(removed.status).toBe(204);

    const replaced = await request("PATCH", "/articles/2/relationships/editor", {
      data: { type: "people", id: "1" },
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.data).toEqual({ type: "people", id: "1" });
    expect((await request("GET", "/articles/2/editor")).body.data.id).toBe("1");
  });

  it("dispatches a renamed, re-pathed endpoint by its operation", async () => {
    const request = serve();
    const { status, body } = await request("GET", "/authors/2");
    expect(status).toBe(200);
    expect(body.links.self).toBe("/authors/2");
  });
});

describe("ResourceService.layer", () => {
  it.effect("dies when the service lacks a member an endpoint calls", () => {
    const Lone = HttpApi.make("lone").add(
      Group.make(Person, Endpoint.get(Person), Endpoint.list(Person)),
    );
    const live = ResourceService.layer(Lone, "people", Person, {
      find: (id) => Effect.succeed(Person.make({ id, attributes: { name: "Dan" } })),
    });
    return Effect.map(Effect.exit(Layer.build(live).pipe(Effect.scoped)), (exit) => {
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toMatch(/"list" endpoint of "people" needs the service's `list`/);
    });
  });
});

// A fresh in-process server: the blog over new in-memory stores.
const live = Effect.fn("live")(function* () {
  const peopleLive = yield* ResourceService.memory(Person, {
    notFound: (id) => new PersonNotFound({ id }),
    initial: people,
  });
  const tagLive = yield* ResourceService.memory(Tag, {
    notFound: (id) => new ArticleNotFound({ id }),
    initial: tags,
  });
  return Layer.mergeAll(
    ResourceService.layer(
      Api,
      "articles",
      Article,
      ResourceService.memory(Article, {
        notFound: (id) => new ArticleNotFound({ id }),
        initial: [article("1", "Bravo", 2, "1"), article("2", "Alpha", 1, "2")],
      }),
      {
        include: {
          people: ResourceService.includeTarget(peopleLive),
          tags: ResourceService.includeTarget(tagLive),
        },
        missingTarget: (identifier) => new ArticleNotFound({ id: identifier.id }),
      },
    ),
    ResourceService.layer(Api, "people", Person, peopleLive),
  ).pipe(Layer.provideMerge(Middleware.layer));
});

const failedRules = (options: Conformance.Options) =>
  Effect.flatMap(live(), (layer) =>
    // SAFETY: `layer` and `Middleware.layer` provide every service the router
    // needs; the platform services `verify` names are never used.
    (
      Conformance.verify(Api, {
        tiers: ["spec"],
        ids: { articles: "1", people: "1" },
        ...options,
      }).pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<Conformance.Report>
    ).pipe(
      Effect.map((report) =>
        report.outcomes
          .filter((outcome) => P.isTagged(outcome, "Failed"))
          .map((outcome) => outcome.rule.id),
      ),
    ),
  );

describe("ResourceService.layer under the conformance kit", () => {
  it.effect("passes every spec read rule", () =>
    Effect.map(failedRules({}), (failed) => expect(failed).toEqual([])),
  );

  it.effect("passes every spec write rule", () =>
    Effect.map(
      failedRules({
        mutating: true,
        writes: {
          articles: {
            create: () => ({
              type: "articles",
              attributes: { title: "Probe", rank: 9 },
              relationships: { author: { data: { type: "people", id: "1" } } },
            }),
            update: () => ({ attributes: { title: "Probe (updated)" } }),
          },
        },
      }),
      (failed) => expect(failed).toEqual([]),
    ),
  );
});
