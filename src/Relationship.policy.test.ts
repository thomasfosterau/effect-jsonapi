/**
 * The linkage policy of `Relationship.toOne` / `toMany`: each policy the spec
 * permits is declarable, served through an endpoint, and read back with the
 * same schemas a client decodes with.
 */
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as Atomic from "./Atomic.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import * as Include from "./Include.js";
import * as Middleware from "./Middleware.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";
import { platformLayer } from "./Registry.js";
import { MEDIA_TYPE } from "./internal/media.js";

const Person = Resource.make("people", { attributes: { name: Schema.String } });
const Comment = Resource.make("comments", { attributes: { body: Schema.String } });
const Article = Resource.make("articles", {
  attributes: { title: Schema.String },
  relationships: {
    author: Relationship.toOne(() => Person, { linkage: "whenIncluded" }),
    reviewer: Relationship.toOne(() => Person, { nullable: true, linkage: "never" }),
    editor: Relationship.toOne(() => Person, { nullable: true, linkage: "optional" }),
    comments: Relationship.toMany(() => Comment, { paginationLinks: true }),
    watchers: Relationship.toMany(() => Person, { linkage: "never", writable: true }),
    history: Relationship.toMany(() => Comment, { writable: false }),
  },
});

const decodeResource = Schema.decodeUnknownSync(Article);
const decodeCreate = Schema.decodeUnknownSync(Article.createPayload);
const decodeUpdate = Schema.decodeUnknownSync(Article.updatePayload);

const bare = { type: "articles", id: "1", attributes: { title: "Hello" } } as const;
const linksOnly = { links: { related: "/articles/1/reviewer" } };
const watchers = { links: { related: "/articles/1/watchers" } };
const page = { data: [{ type: "comments", id: "5" }] };
const history = { data: [] };

describe("the presets", () => {
  it("are the inline and links-only policies", () => {
    const policy = ({
      linkage,
      includable,
      writable,
      paginationLinks,
    }: Relationship.Descriptor) => ({
      linkage,
      includable,
      writable,
      paginationLinks,
    });
    const inline = { linkage: "always", includable: true, writable: true, paginationLinks: false };
    expect(policy(Relationship.one(() => Person))).toEqual(inline);
    expect(policy(Relationship.optional(() => Person))).toEqual(inline);
    expect(policy(Relationship.many(() => Person))).toEqual(inline);
    expect(policy(Relationship.toOne(() => Person))).toEqual(inline);
    expect(policy(Relationship.toMany(() => Person))).toEqual(inline);
    expect(policy(Relationship.paginated(() => Person))).toEqual({
      linkage: "never",
      includable: false,
      writable: false,
      paginationLinks: false,
    });
  });

  it("toOne picks its kind from `nullable`", () => {
    expect(Relationship.toOne(() => Person).kind).toBe("one");
    expect(Relationship.toOne(() => Person, { nullable: true }).kind).toBe("optional");
  });
});

describe("the resource object", () => {
  it("reads linkage that a policy lets the server leave out", () => {
    const decoded = decodeResource({
      ...bare,
      relationships: {
        author: { links: { related: "/articles/1/author" } },
        reviewer: linksOnly,
        comments: page,
        watchers,
        history,
      },
    });
    expect(decoded.relationships?.author).toEqual({ links: { related: "/articles/1/author" } });
    // `editor` (`optional`) is left out altogether
    expect(decoded.relationships?.editor).toBeUndefined();
  });

  it("still requires what the policy keeps", () => {
    // `comments` and `history` carry linkage on every response
    expect(() =>
      decodeResource({ ...bare, relationships: { reviewer: linksOnly, watchers, history } }),
    ).toThrow(/comments/);
    // a links-only relationship needs its `related` link
    expect(() =>
      decodeResource({
        ...bare,
        relationships: { reviewer: {}, comments: page, watchers, history },
      }),
    ).toThrow(/links/);
  });

  it("reads pagination links on a to-many that pages its linkage", () => {
    const decoded = decodeResource({
      ...bare,
      relationships: {
        reviewer: linksOnly,
        comments: { ...page, links: { next: "/articles/1/relationships/comments?page[offset]=1" } },
        watchers,
        history,
      },
    });
    expect(decoded.relationships?.comments.links?.next).toBe(
      "/articles/1/relationships/comments?page[offset]=1",
    );
  });
});

describe("includable", () => {
  it('leaves `linkage: "never"` and `includable: false` out of the include paths', () => {
    expect(Resource.includePaths(Article, 1)).toEqual(["author", "editor", "comments", "history"]);
    expect(Resource.directTargets(Article).map((target) => target.type)).toEqual([
      "people",
      "comments",
    ]);
  });

  it("is refused through a surface", () => {
    expect(() => Include.make(Article, { reviewer: Person } as never)).toThrow(/is not includable/);
  });
});

describe("writable", () => {
  it("reads every write with its linkage, whatever the response policy", () => {
    const created = decodeCreate({
      data: {
        type: "articles",
        attributes: { title: "Hello" },
        relationships: {
          author: { data: { type: "people", id: "9" } },
          watchers: { data: [{ type: "people", id: "9" }] },
        },
      },
    });
    expect(created.data.relationships.watchers?.data).toEqual([{ type: "people", id: "9" }]);
    // a write that sends no linkage sets nothing
    expect(() =>
      decodeCreate({
        data: { type: "articles", attributes: { title: "Hello" }, relationships: { author: {} } },
      }),
    ).toThrow(/data/);
  });

  it("refuses a relationship declared `writable: false`", () => {
    const update = (relationships: Schema.Json) =>
      decodeUpdate({ data: { type: "articles", id: "1", relationships } });
    expect(() => update({ history: { data: [] } })).toThrow(/history/);
    // a links-only to-one is still set by its linkage
    expect(update({ reviewer: { data: null } }).data.relationships?.reviewer).toEqual({
      data: null,
    });
  });

  it("drops a relationship that cannot be written from the atomic operations", () => {
    const decode = Schema.decodeUnknownSync(Atomic.RequestDocument([Article]));
    const add = (relationships: Schema.Json) =>
      decode({
        "atomic:operations": [
          {
            op: "add",
            data: { type: "articles", attributes: { title: "x" }, relationships },
          },
        ],
      });
    expect(() => add({ author: { data: { type: "people", id: "9" } } })).not.toThrow();
    expect(() =>
      add({ author: { data: { type: "people", id: "9" } }, history: { data: [] } }),
    ).toThrow(/history/);
  });
});

describe("declarations the spec rules out", () => {
  it("are refused", () => {
    expect(() => Relationship.toMany(() => Person, { linkage: "never", includable: true })).toThrow(
      /cannot be `includable`/,
    );
    expect(() =>
      Relationship.toMany(() => Person, { linkage: "never", paginationLinks: true }),
    ).toThrow(/cannot carry `paginationLinks`/);
    expect(() =>
      Relationship.toOne(() => Person, { linkage: "whenIncluded", includable: false }),
    ).toThrow(/needs `includable`/);
  });
});

describe("serving linkage only when included", () => {
  const Api = HttpApi.make("blog").add(
    Group.make(Article, Endpoint.get(Article, { include: true })),
  );

  const person = Person.make({ id: Person.Id.make("9"), attributes: { name: "Ada" } });

  const request = async (url: string) => {
    const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
      handlers.handle("get", ({ query }) => {
        const included = query.include?.includes("author") === true;
        const relationships = { reviewer: linksOnly, comments: { data: [] }, watchers, history };
        const article = Article.make({
          id: Article.Id.make("1"),
          attributes: { title: "Hello" },
          relationships: included
            ? { ...relationships, author: { data: { type: "people", id: person.id } } }
            : relationships,
        });
        return Effect.succeed(Handlers.data(article, included ? { included: [person] } : {}));
      }),
    );
    const appLayer = HttpApiBuilder.layer(Api).pipe(
      Layer.provide(ArticlesLive),
      Layer.provide(Middleware.layer),
      Layer.provide(platformLayer),
    );
    const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
    onTestFinished(() => dispose());
    const response = await handler(new Request(url, { headers: { accept: MEDIA_TYPE } }));
    return { status: response.status, body: (await response.json()) as unknown };
  };

  it("sends `data` for an included path and leaves it out otherwise", async () => {
    const plain = await request("http://localhost/articles/1");
    expect(plain.status).toBe(200);
    expect(plain.body).not.toHaveProperty("data.relationships.author");

    const compound = await request("http://localhost/articles/1?include=author");
    expect(compound.status).toBe(200);
    expect(compound.body).toMatchObject({
      data: { relationships: { author: { data: { type: "people", id: "9" } } } },
      included: [{ type: "people", id: "9" }],
    });
    // what the server sent, the client reads back
    expect(() => Schema.decodeUnknownSync(Article.document())(compound.body)).not.toThrow();
  });
});
