/**
 * Compound relationship documents on generated endpoints (#484):
 * `Endpoint.resource` / `Group.resource` thread `relationshipInclude` — the
 * top-level default and each relationship's override — into the `include`
 * option of the `getRelationship` endpoints they generate — and
 * `relationshipFields` likewise into their `fields` option (#489).
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
  attributes: { name: Schema.String, email: Schema.String },
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
    attributes: { name: "Ada", email: "ada@example.com" },
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

// Whether a relationship endpoint's query decodes the wire `input` into a
// value with the member `key` (a query that declares no such family drops it).
const decodesInto = (
  endpoint: HttpApiEndpoint.Top,
  input: Rec.ReadonlyRecord<string, string>,
  key: string,
): boolean => {
  // SAFETY: every endpoint under test declares a query codec.
  const query = endpoint.query as Schema.Codec<unknown, unknown>;
  const decoded = Schema.decodeUnknownExit(query)(input);
  return (
    Exit.isSuccess(decoded) &&
    // SAFETY: a query codec decodes to a struct.
    Rec.has(decoded.value as Rec.ReadonlyRecord<string, unknown>, key)
  );
};

// Whether a relationship endpoint's query accepts `?include=<paths>`.
const accepts = (endpoint: HttpApiEndpoint.Top, paths: string): boolean =>
  decodesInto(endpoint, { include: paths }, "include");

// The types whose `fields[TYPE]` a relationship endpoint's query declares: a
// fieldset naming one of the type's attributes decodes into `fields`.
const fieldsetAttribute: Rec.ReadonlyRecord<WireType | "articles", string> = {
  articles: "title",
  comments: "body",
  people: "name",
  companies: "name",
  revisions: "editedAt",
};
const declaresFieldsets = (endpoint: HttpApiEndpoint.Top): ReadonlyArray<string> =>
  Rec.keys(fieldsetAttribute).filter((type) =>
    decodesInto(endpoint, { [`fields[${type}]`]: fieldsetAttribute[type] }, "fields"),
  );

// Whether a relationship endpoint's success document admits an `included`
// member with none of its attributes — a sparse fieldset's answer.
const admitsPartial = (
  endpoint: HttpApiEndpoint.Top,
  data: Identifier | ReadonlyArray<Identifier>,
  type: WireType,
): boolean =>
  Exit.isSuccess(
    Schema.decodeUnknownExit(successOf(endpoint))(
      { data, included: [{ ...wire[type], attributes: {} }] },
      { onExcessProperty: "error" },
    ),
  );

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

  it("a `paginated` relationship legalises its own name, as a `many` does (#483)", () => {
    const endpoints = Endpoint.resource(Article, {
      relationshipInclude: true,
      page: { offset: Schema.optionalKey(Schema.NumberFromString) },
    });
    const history = named(endpoints, "historyRelationship");
    expect(accepts(history, "history")).toBe(true);
    expect(admitted(history, historyIds)).toEqual(["revisions"]);
    // Off by default, as on every other relationship.
    expect(accepts(named(Endpoint.resource(Article), "historyRelationship"), "history")).toBe(
      false,
    );
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

describe("`Endpoint.resource`'s `relationshipFields` (#489)", () => {
  it.each([
    ["no options", Endpoint.resource(Article)],
    ["`relationshipInclude` alone", Endpoint.resource(Article, { relationshipInclude: true })],
    [
      "a top-level `fields`",
      Endpoint.resource(Article, { relationshipInclude: true, fields: true }),
    ],
  ])("is off by default, under %s", (_, endpoints) => {
    const comments = named(endpoints, "commentsRelationship");
    expect(declaresFieldsets(comments)).toEqual([]);
    expect(admitsPartial(comments, commentIds, "comments")).toBe(false);
    // The `related` endpoints keep their own `fields`.
    expect(declaresFieldsets(named(endpoints, "comments"))).toContain("comments");
  });

  it("`true` declares a fieldset for every type the include paths reach", () => {
    const endpoints = Endpoint.resource(Article, {
      relationshipInclude: true,
      relationshipFields: true,
    });
    const comments = named(endpoints, "commentsRelationship");
    // Not `articles`: the parent is no resource object of the document.
    expect(declaresFieldsets(comments)).toEqual(["comments", "people"]);
    expect(admitsPartial(comments, commentIds, "comments")).toBe(true);
    expect(admitsPartial(comments, commentIds, "people")).toBe(true);
    const editor = named(endpoints, "editorRelationship");
    expect(declaresFieldsets(editor)).toEqual(["people", "companies"]);
    expect(admitsPartial(editor, editorId, "companies")).toBe(true);
    // A `paginated` relationship's paths are rooted at it, as a `many`'s
    // are (#483), so it declares the types they reach.
    expect(declaresFieldsets(named(endpoints, "historyRelationship"))).toEqual(["revisions"]);
  });

  it("follows a `paginated` relationship's include paths (#483)", () => {
    // A thread's comments are paginated; on their own relationship endpoint
    // `comments` and `comments.author` are legal, so both types are declared.
    const Thread = Resource.make("threads", {
      attributes: { subject: Schema.String },
      relationships: { comments: Relationship.paginated(() => Comment) },
    });
    const endpoints = Endpoint.resource(Thread, {
      relationshipInclude: true,
      relationshipFields: true,
    });
    const comments = named(endpoints, "commentsRelationship");
    expect(accepts(comments, "comments.author")).toBe(true);
    expect(declaresFieldsets(comments)).toEqual(["comments", "people"]);
    expect(admitsPartial(comments, commentIds, "comments")).toBe(true);
    expect(admitsPartial(comments, commentIds, "people")).toBe(true);
    // Without `relationshipFields`, none.
    expect(
      declaresFieldsets(
        named(Endpoint.resource(Thread, { relationshipInclude: true }), "commentsRelationship"),
      ),
    ).toEqual([]);
  });

  it("follows each relationship's include paths", () => {
    const endpoints = Endpoint.resource(Article, {
      relationshipInclude: { depth: 3 },
      relationshipFields: true,
      relationships: { comments: { relationshipInclude: { paths: ["comments"] } } },
    });
    expect(declaresFieldsets(named(endpoints, "commentsRelationship"))).toEqual(["comments"]);
    expect(declaresFieldsets(named(endpoints, "editorRelationship"))).toEqual([
      "people",
      "companies",
    ]);
  });

  it("a relationship's own `relationshipFields` overrides the top-level one", () => {
    const endpoints = Endpoint.resource(Article, {
      relationshipInclude: true,
      relationshipFields: true,
      relationships: { editor: { relationshipFields: false } },
    });
    expect(declaresFieldsets(named(endpoints, "commentsRelationship"))).toEqual([
      "comments",
      "people",
    ]);
    const editor = named(endpoints, "editorRelationship");
    expect(declaresFieldsets(editor)).toEqual([]);
    expect(admitsPartial(editor, editorId, "people")).toBe(false);
  });

  it("a relationship can opt in alone", () => {
    const endpoints = Endpoint.resource(Article, {
      relationshipInclude: true,
      relationships: { editor: { relationshipFields: true } },
    });
    expect(declaresFieldsets(named(endpoints, "editorRelationship"))).toEqual([
      "people",
      "companies",
    ]);
    expect(declaresFieldsets(named(endpoints, "commentsRelationship"))).toEqual([]);
  });

  it("declares none without `relationshipInclude`", () => {
    const endpoints = Endpoint.resource(Article, { relationshipFields: true });
    const comments = named(endpoints, "commentsRelationship");
    expect(declaresFieldsets(comments)).toEqual([]);
    expect(admitted(comments, commentIds)).toEqual([]);
  });
});

describe("a `Group.resource` relationship endpoint serving `included` (#484, #489)", () => {
  const Api = HttpApi.make("resourceRelationshipInclude").add(
    Group.resource(Article, {
      endpoints: { get: false, list: false, create: false, update: false, delete: false },
      relationships: { comments: false, history: false },
      relationshipInclude: true,
      relationshipFields: true,
    }),
  );

  const company = Company.make({ id: Company.Id.make("2"), attributes: { name: "Acme" } });
  const person = Person.make({
    id: Person.Id.make("9"),
    attributes: { name: "Ada", email: "ada@example.com" },
    relationships: { employer: { data: Company.ref(company.id) } },
  });

  const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
    handlers
      .handle("editor", () => Effect.succeed(Handlers.data(person)))
      // The generated handler's document admits `included` now that
      // `relationshipInclude` is on, and projected members now that
      // `relationshipFields` is.
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
            onResource: Handlers.project(query.fields),
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

  it("narrows the `included` members to `fields[TYPE]`", async () => {
    const response = await serve(
      "/articles/1/relationships/editor?include=editor,editor.employer&fields[people]=name",
    );
    expect(response.status).toBe(200);
    // `employer` is not named, so it goes (#494), and the company it linked
    // is exempt from full linkage (§Compound Documents).
    const { relationships: _employer, ...person } = wire.people;
    expect(response.body).toEqual({
      data: editorId,
      included: [{ ...person, attributes: { name: "Ada" } }, wire.companies],
    });
    // Named, it stays.
    const named = await serve(
      "/articles/1/relationships/editor?include=editor,editor.employer&fields[people]=name,employer",
    );
    expect(named.body).toEqual({
      data: editorId,
      included: [{ ...wire.people, attributes: { name: "Ada" } }, wire.companies],
    });
  });

  it("answers a fieldset for the parent's type with a 400", async () => {
    const response = await serve(
      "/articles/1/relationships/editor?include=editor&fields[articles]=title",
    );
    expect(response.status).toBe(400);
  });
});
