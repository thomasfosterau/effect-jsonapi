/**
 * Compound relationship documents on generated endpoints (#484):
 * `Endpoint.resource` / `Group.resource` thread `relationshipInclude` — the
 * top-level default and each relationship's override — into the `include`
 * option of the `getRelationship` endpoints they generate.
 *
 * The type-level half is the `Endpoint.resource` section of
 * `test/relationship-include.types.ts`.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import type { HttpApiEndpoint } from "effect/http-api";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import * as Include from "./Include.js";
import * as Middleware from "./Middleware.js";
import * as Relationship from "./Relationship.js";
import { platformLayer } from "./Registry.js";
import * as Resource from "./Resource.js";

const Revision = Resource.make("revisions", { attributes: { editedAt: Schema.String } });
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
    comments: Relationship.many(() => Comment),
    editor: Relationship.optional(() => Person),
    history: Relationship.paginated(() => Revision),
  },
});

// One wire resource object of each type.
const wire = {
  comments: {
    type: "comments",
    id: "5",
    attributes: { body: "First" },
    relationships: { author: { data: { type: "people", id: "9" } } },
  },
  people: {
    type: "people",
    id: "9",
    attributes: { name: "Ada" },
    relationships: { employer: { data: { type: "companies", id: "2" } } },
  },
  companies: { type: "companies", id: "2", attributes: { name: "Acme" } },
  revisions: { type: "revisions", id: "3", attributes: { editedAt: "2026-01-01" } },
} as const;
type WireType = keyof typeof wire;
const types: ReadonlyArray<WireType> = Rec.keys(wire);

// The generated endpoint named `name`.
const named = (endpoints: ReadonlyArray<HttpApiEndpoint.Top>, name: string) =>
  Option.getOrElse(
    Arr.findFirst(endpoints, (candidate) => candidate.identifier === name),
    () => expect.unreachable(`no generated endpoint "${name}"`),
  );

const successOf = (endpoint: HttpApiEndpoint.Top) =>
  // SAFETY: every endpoint under test declares exactly one success schema, a
  // JSON:API document codec; decoding unknown input is what it is for.
  [...endpoint.success][0] as Schema.Codec<unknown, unknown>;

// Resource linkage as a relationship document's primary data.
interface Identifier {
  readonly type: string;
  readonly id: string;
}

// The types a relationship endpoint's success document admits in `included`.
const admitted = (
  endpoint: HttpApiEndpoint.Top,
  data: Identifier | ReadonlyArray<Identifier>,
): ReadonlyArray<WireType> =>
  types.filter((type) =>
    Exit.isSuccess(
      Schema.decodeUnknownExit(successOf(endpoint))(
        { data, included: [wire[type]] },
        { onExcessProperty: "error" },
      ),
    ),
  );

// Whether a relationship endpoint's query decodes `?include=<paths>` into an
// `include` (a query that declares none drops the key).
const accepts = (endpoint: HttpApiEndpoint.Top, paths: string): boolean => {
  // SAFETY: every endpoint under test declares a query codec.
  const query = endpoint.query as Schema.Codec<unknown, unknown>;
  const decoded = Schema.decodeUnknownExit(query)({ include: paths });
  return (
    Exit.isSuccess(decoded) &&
    // SAFETY: a query codec decodes to a struct.
    Rec.has(decoded.value as Rec.ReadonlyRecord<string, unknown>, "include")
  );
};

const commentIds = [{ type: "comments", id: "5" }];
const editorId = { type: "people", id: "9" };
const historyIds = [{ type: "revisions", id: "3" }];

describe("`Endpoint.resource`'s `relationshipInclude` (#484)", () => {
  it.each([
    ["no options", Endpoint.resource(Article)],
    ["a top-level `include`", Endpoint.resource(Article, { include: true })],
  ])("is off by default, under %s", (_, endpoints) => {
    const comments = named(endpoints, "commentsRelationship");
    expect(accepts(comments, "comments")).toBe(false);
    expect(admitted(comments, commentIds)).toEqual([]);
    expect(
      Schema.decodeUnknownSync(successOf(comments))(
        { data: commentIds },
        { onExcessProperty: "error" },
      ),
    ).toEqual({ data: commentIds });
    // The `related` endpoints keep their own `include`.
    expect(accepts(named(endpoints, "comments"), "author")).toBe(true);
  });

  it("`true` turns `?include=` on for every generated relationship endpoint", () => {
    const endpoints = Endpoint.resource(Article, { relationshipInclude: true });
    const comments = named(endpoints, "commentsRelationship");
    expect(accepts(comments, "comments.author")).toBe(true);
    expect(accepts(comments, "editor")).toBe(false);
    expect(admitted(comments, commentIds)).toEqual(["comments", "people"]);
    const editor = named(endpoints, "editorRelationship");
    expect(accepts(editor, "editor.employer")).toBe(true);
    expect(admitted(editor, editorId)).toEqual(["people", "companies"]);
  });

  it("a `paginated` relationship legalises no path, and does not throw", () => {
    const endpoints = Endpoint.resource(Article, {
      relationshipInclude: true,
      page: { offset: Schema.optionalKey(Schema.NumberFromString) },
    });
    const history = named(endpoints, "historyRelationship");
    expect(accepts(history, "history")).toBe(false);
    expect(admitted(history, historyIds)).toEqual([]);
  });

  it("follows a top-level `{ depth }`", () => {
    const endpoints = Endpoint.resource(Article, { relationshipInclude: { depth: 3 } });
    const comments = named(endpoints, "commentsRelationship");
    expect(accepts(comments, "comments.author.employer")).toBe(true);
    expect(admitted(comments, commentIds)).toEqual(["comments", "people", "companies"]);
  });

  it("a relationship's own `relationshipInclude` overrides the top-level one", () => {
    const surface = Include.make(Article, { editor: Person });
    const endpoints = Endpoint.resource(Article, {
      relationshipInclude: true,
      relationships: {
        comments: { relationshipInclude: { paths: ["comments"] } },
        editor: { relationshipInclude: surface },
        history: { relationshipInclude: false },
      },
    });
    const comments = named(endpoints, "commentsRelationship");
    expect(accepts(comments, "comments")).toBe(true);
    expect(accepts(comments, "comments.author")).toBe(false);
    expect(admitted(comments, commentIds)).toEqual(["comments"]);
    const editor = named(endpoints, "editorRelationship");
    expect(accepts(editor, "editor")).toBe(true);
    expect(accepts(editor, "editor.employer")).toBe(false);
    expect(admitted(editor, editorId)).toEqual(["people"]);
    expect(accepts(named(endpoints, "historyRelationship"), "")).toBe(false);
  });

  it("a relationship can opt in alone", () => {
    const endpoints = Endpoint.resource(Article, {
      relationships: { editor: { relationshipInclude: true } },
    });
    expect(accepts(named(endpoints, "editorRelationship"), "editor")).toBe(true);
    expect(accepts(named(endpoints, "commentsRelationship"), "comments")).toBe(false);
  });
});

describe("a `Group.resource` relationship endpoint serving `included` (#484)", () => {
  const Api = HttpApi.make("resourceRelationshipInclude").add(
    Group.resource(Article, {
      endpoints: { get: false, list: false, create: false, update: false, delete: false },
      relationships: { comments: false, history: false },
      relationshipInclude: true,
    }),
  );

  const company = Company.make({ id: Company.Id.make("2"), attributes: { name: "Acme" } });
  const person = Person.make({
    id: Person.Id.make("9"),
    attributes: { name: "Ada" },
    relationships: { employer: { data: Company.ref(company.id) } },
  });

  const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
    handlers
      .handle("editor", () => Effect.succeed(Handlers.data(person)))
      // The generated handler's document admits `included` now that
      // `relationshipInclude` is on.
      .handle("editorRelationship", ({ query }) =>
        Effect.succeed(
          Handlers.linkage(Person.ref(person.id), {
            included:
              query.include === undefined
                ? undefined
                : [
                    ...(query.include.includes("editor") ? [person] : []),
                    ...(query.include.includes("editor.employer") ? [company] : []),
                  ],
          }),
        ),
      )
      .handle("updateEditorRelationship", () =>
        Effect.succeed(Handlers.linkage(Person.ref(person.id))),
      ),
  );

  const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Any));
  const serve = async (url: string) => {
    const appLayer = HttpApiBuilder.layer(Api).pipe(
      Layer.provide(ArticlesLive),
      Layer.provide(Middleware.layer),
      Layer.provide(platformLayer),
    );
    const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
    const response = await handler(new Request(`http://localhost${url}`)).finally(dispose);
    const text = await response.text();
    return { status: response.status, body: text === "" ? undefined : decodeJson(text) };
  };

  it("answers `include=editor,editor.employer` with the editor and its employer", async () => {
    const response = await serve("/articles/1/relationships/editor?include=editor,editor.employer");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: editorId,
      included: [wire.people, wire.companies],
    });
  });

  it("answers no `include` with a plain linkage document", async () => {
    expect(await serve("/articles/1/relationships/editor")).toEqual({
      status: 200,
      body: { data: editorId },
    });
  });

  it("answers a path outside the relationship with a 400", async () => {
    const response = await serve("/articles/1/relationships/editor?include=comments");
    expect(response.status).toBe(400);
  });
});
