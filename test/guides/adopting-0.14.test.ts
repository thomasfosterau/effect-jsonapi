/**
 * The "after" code of docs/guides/adopting-0.14.md, executed.
 *
 * The guide shows an existing consumer how to replace the scaffolding the
 * consuming applications wrote around 0.13 (their own include spec, include
 * walk, fieldset projection, error-document decoder and Accept parser) with
 * the 0.14 surfaces. Every snippet the guide presents as the replacement is
 * exercised here against the behaviour the applications' own tests pinned
 * (website's `apps/api/tests/document.test.ts`, `include-targets.test.ts`,
 * `packages/api/tests/negotiate.test.ts`, `jsonapi.test.ts`), so the guide
 * cannot describe a call shape that does not compile or a property that does
 * not hold.
 */
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Array as Arr, Effect, Layer, Option, Order, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import {
  ApiError,
  Client,
  Endpoint,
  Group,
  Handlers,
  Include,
  MEDIA_TYPE,
  Middleware,
  Query,
  Relationship,
  Resource,
} from "@thomasfosterau/effect-jsonapi";

// ---------------------------------------------------------------------------
// The resources of the guide: a bibliography and its entries, mutually
// related — website's `bibliographies` family.
// ---------------------------------------------------------------------------

// A cycle needs the explicit annotation the README's "Mutually recursive
// resources" section describes: one interface per resource, naming the
// relationship record.
const bibliographyAttributes = { title: Schema.NonEmptyString, note: Schema.String };
const entryAttributes = { citation: Schema.NonEmptyString };

interface Bibliography extends Resource.Resource<
  "bibliographies",
  typeof bibliographyAttributes,
  { readonly entries: Relationship.many<BibliographyEntry> }
> {}
interface BibliographyEntry extends Resource.Resource<
  "bibliography-entries",
  typeof entryAttributes,
  { readonly bibliography: Relationship.one<Bibliography> }
> {}

const Bibliography: Bibliography = Resource.make("bibliographies", {
  attributes: bibliographyAttributes,
  relationships: { entries: Relationship.many(() => BibliographyEntry) },
});
const BibliographyEntry: BibliographyEntry = Resource.make("bibliography-entries", {
  attributes: entryAttributes,
  relationships: { bibliography: Relationship.one(() => Bibliography) },
});

// ---------------------------------------------------------------------------
// 1. The include surface, declared once
// ---------------------------------------------------------------------------

const BIBLIOGRAPHY_INCLUDE = Include.make(Bibliography, {
  entries: Include.nested(BibliographyEntry, { bibliography: Bibliography }),
});
const BIBLIOGRAPHY_ENTRY_INCLUDE = Include.make(BibliographyEntry, {
  bibliography: Include.nested(Bibliography, { entries: BibliographyEntry }),
});

describe("1. Include.make replaces IncludeSpec / nested / includablePaths / includedUnion", () => {
  it("projects the whitelist, at every depth, in walk order", () => {
    expect(BIBLIOGRAPHY_INCLUDE.paths).toEqual(["entries", "entries.bibliography"]);
    expect(BIBLIOGRAPHY_ENTRY_INCLUDE.paths).toEqual(["bibliography", "bibliography.entries"]);
    // the whole dotted path is matched, never its head
    expect(BIBLIOGRAPHY_INCLUDE.has("entries")).toBe(true);
    expect(BIBLIOGRAPHY_INCLUDE.has("entries.bibliography")).toBe(true);
    expect(BIBLIOGRAPHY_INCLUDE.has("entries.nope")).toBe(false);
  });

  it("projects the `included` union, deduplicated by schema identity", () => {
    // Both hops contribute: an entry AND the bibliography behind it
    expect(BIBLIOGRAPHY_INCLUDE.included.members).toHaveLength(2);
    expect(BIBLIOGRAPHY_INCLUDE.included.members).toContain(BibliographyEntry);
    expect(BIBLIOGRAPHY_INCLUDE.included.members).toContain(Bibliography);
  });

  it("is the one option `get`, `list` and `Group.resource` take", () => {
    const group = Group.resource(Bibliography, {
      include: BIBLIOGRAPHY_INCLUDE,
      page: Query.Page.Offset,
      relationships: false,
    });
    expect(Arr.sort(Object.keys(group.endpoints), Order.String)).toEqual([
      "create",
      "delete",
      "get",
      "list",
      "update",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. The walk: Handlers.resolveIncluded over a registry keyed by type
// ---------------------------------------------------------------------------

const bibliography = Bibliography.make({
  id: Bibliography.Id.make("b1"),
  attributes: { title: "Reading list", note: "" },
  relationships: {
    entries: {
      data: [
        BibliographyEntry.ref(BibliographyEntry.Id.make("e1")),
        BibliographyEntry.ref(BibliographyEntry.Id.make("e2")),
      ],
    },
  },
});
const entries = [
  BibliographyEntry.make({
    id: BibliographyEntry.Id.make("e1"),
    attributes: { citation: "Doe 2020" },
    relationships: { bibliography: { data: Bibliography.ref(Bibliography.Id.make("b1")) } },
  }),
  BibliographyEntry.make({
    id: BibliographyEntry.Id.make("e2"),
    attributes: { citation: "Roe 2021" },
    relationships: { bibliography: { data: Bibliography.ref(Bibliography.Id.make("b1")) } },
  }),
];

describe("2. Handlers.resolveIncluded replaces planIncludes / include-targets", () => {
  it("is one loader call per type per level, deduplicated against the document", async () => {
    const calls: Array<{ readonly type: string; readonly ids: ReadonlyArray<string> }> = [];
    // ONE registry, keyed by JSON:API `type` — website's INCLUDE_TARGETS,
    // each entry the family's own batched `getMany`.
    const targets = {
      bibliographies: (ids: ReadonlyArray<string>) => {
        calls.push({ type: "bibliographies", ids });
        return Effect.succeed([bibliography].filter((b) => ids.includes(b.id)));
      },
      "bibliography-entries": (ids: ReadonlyArray<string>) => {
        calls.push({ type: "bibliography-entries", ids });
        return Effect.succeed(entries.filter((e) => ids.includes(e.id)));
      },
    } satisfies Handlers.IncludeTargets;

    const included = await Effect.runPromise(
      Handlers.resolveIncluded(bibliography, ["entries", "entries.bibliography"], targets, {
        concurrency: 4,
        depth: 3, // website's MAX_INCLUDE_DEPTH — the package default, spelled out
      }),
    );
    // walk order, one entry per (type, id); the bibliography is the primary
    // resource, so the second hop resolves back into the document and adds
    // nothing to `included`
    expect(included?.map((r) => `${r.type}:${r.id}`)).toEqual([
      "bibliography-entries:e1",
      "bibliography-entries:e2",
    ]);
    // one batched call for the two entries; the second level asks for
    // nothing, because `b1` is already in the document
    expect(calls).toEqual([{ type: "bibliography-entries", ids: ["e1", "e2"] }]);
  });

  it("returns `undefined` when nothing was asked for, so the member is omitted", async () => {
    const included = await Effect.runPromise(Handlers.resolveIncluded(bibliography, undefined, {}));
    expect(included).toBeUndefined();
    expect("included" in Handlers.data(bibliography, { included })).toBe(false);
  });

  it("validates runtime paths against the surface with Query.validateIncludePaths", async () => {
    const rejected = await Effect.runPromise(
      Query.validateIncludePaths(["entries.nope"], {
        includable: BIBLIOGRAPHY_INCLUDE.paths,
        maxDepth: 3,
      }).pipe(Effect.flip),
    );
    expect(rejected).toBeInstanceOf(ApiError.UnsupportedIncludePath);
    // the 400 carries the whole legal set — website #1623's `allowed`
    expect(ApiError.toDocument(rejected).errors[0]?.meta).toEqual({
      path: "entries.nope",
      includablePaths: ["entries", "entries.bibliography"],
    });
    // and names the rejected parameter, as the decode-time 400 does
    expect(ApiError.toDocument(rejected).errors[0]?.source).toEqual({ parameter: "include" });
  });
});

// ---------------------------------------------------------------------------
// 3. The per-resource pass: project + withMeta, composed
// ---------------------------------------------------------------------------

describe("3. Handlers.compose(project, withMeta) replaces projectFields / withViewerMeta", () => {
  it("runs once per resource, in every slot of the document", () => {
    const viewer = { role: "admin" as const };
    // website's `defaultCapabilities`: `canEdit` / `canDelete` on the viewer's role
    const capabilities = Handlers.withMeta(() => ({
      canEdit: viewer.role === "admin",
      canDelete: viewer.role === "admin",
    }));
    const onResource = Handlers.compose(
      Handlers.project({ bibliographies: ["title"] }),
      capabilities,
    );
    const document = Handlers.data(bibliography, { included: entries, onResource });
    expect(document.data.attributes).toEqual({ title: "Reading list" });
    expect(document.data.meta).toEqual({ canEdit: true, canDelete: true });
    // `included` members get the same pass — a document cannot describe one
    // type two ways depending on the slot
    expect(document.included?.[0]?.meta).toEqual({ canEdit: true, canDelete: true });
    // a type with no requested set keeps every field (the spec's default)
    expect(document.included?.[0]?.attributes).toEqual({ citation: "Doe 2020" });
  });

  it("emits no `meta` member when the computation yields nothing", () => {
    const noCapabilities = Handlers.withMeta(() => undefined);
    expect("meta" in Handlers.data(bibliography, { onResource: noCapabilities }).data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Reading error documents on the client
// ---------------------------------------------------------------------------

describe("4. Client.errorDocument / errorMessage replace decodeErrorBody / errorDocumentMessage", () => {
  it("decodes a conformant body and degrades on anything else", () => {
    const body = JSON.stringify(
      ApiError.toDocument(new ApiError.Conflict({ detail: "Title taken" })),
    );
    const decoded = Client.decodeErrorDocument(body);
    expect(Option.isSome(decoded)).toBe(true);
    expect(Option.map(decoded, Client.errorMessage)).toEqual(Option.some("Title taken"));
    // a gateway's HTML, a truncated body: no document, no throw
    expect(Option.isNone(Client.decodeErrorDocument("<html>502</html>"))).toBe(true);
    expect(Option.isNone(Client.decodeErrorDocument('{"errors":[{"stat'))).toBe(true);
  });

  it("falls back to a constant when the document says nothing readable", () => {
    expect(Client.errorMessage({ errors: [{ status: "503" }] })).toBe(Client.DEFAULT_ERROR_MESSAGE);
    expect(Client.errorMessage({ errors: [{ status: "404", title: "Not Found" }] })).toBe(
      "Not Found",
    );
  });

  it("reads the document off a failed call, or none for a transport fault", async () => {
    const message = (cause: unknown) =>
      Effect.map(Client.errorDocument(cause), (document) =>
        Option.match(document, {
          onNone: () => "Request could not be completed",
          onSome: Client.errorMessage,
        }),
      );
    expect(await Effect.runPromise(message(new Error("offline")))).toBe(
      "Request could not be completed",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Content negotiation predicates
// ---------------------------------------------------------------------------

describe("5. Middleware.negotiate replaces the hand-rolled Accept / Content-Type parser", () => {
  it("answers the §5 questions the application's parser answered", () => {
    // clean instance → acceptable; every instance parameterised → 406
    expect(Middleware.acceptIsAcceptable("application/vnd.api+json")).toBe(true);
    expect(Middleware.acceptIsAcceptable('application/vnd.api+json;charset="utf-8"')).toBe(false);
    // `q` is a weight, not a media type parameter; a `q=0` instance is a refusal
    expect(Middleware.acceptIsAcceptable("application/vnd.api+json;q=0.8, text/html")).toBe(true);
    expect(Middleware.acceptIsAcceptable("application/vnd.api+json;q=0")).toBe(false);
    // `ext` / `profile` are the two allowed parameters; unknown ext URIs are not
    expect(
      Middleware.contentTypeIsAcceptable(
        'application/vnd.api+json;profile="https://example.com/p"',
      ),
    ).toBe(true);
    expect(
      Middleware.contentTypeIsAcceptable('application/vnd.api+json;ext="https://example.com/x"'),
    ).toBe(false);
    expect(
      Middleware.contentTypeIsAcceptable('application/vnd.api+json;ext="https://example.com/x"', {
        extensions: ["https://example.com/x"],
      }),
    ).toBe(true);
  });

  it("returns the spec error a framework hook renders", () => {
    const error = Middleware.negotiate({ contentType: "application/vnd.api+json;charset=utf-8" });
    expect(error).toBeInstanceOf(ApiError.UnsupportedMediaType);
    expect(ApiError.toDocument(error!).errors[0]?.status).toBe("415");
    expect(Middleware.negotiate({ accept: "application/vnd.api+json;foo=bar" })).toBeInstanceOf(
      ApiError.NotAcceptable,
    );
    expect(Middleware.negotiate({ accept: "*/*" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The wire: a rejected path answers 400 with `meta.includablePaths`
// ---------------------------------------------------------------------------

describe("the 400 for a rejected include path publishes the legal set", () => {
  const Api = HttpApi.make("bibliographies").add(
    Group.make(
      Bibliography,
      Endpoint.get(Bibliography, { include: BIBLIOGRAPHY_INCLUDE }),
      Endpoint.list(Bibliography, { include: BIBLIOGRAPHY_INCLUDE, page: Query.Page.Offset }),
    ),
  );
  const Live = HttpApiBuilder.group(Api, "bibliographies", (handlers) =>
    handlers
      .handle("get", () => Effect.succeed(Handlers.data(bibliography)))
      .handle("list", () => Effect.succeed(Handlers.collection([bibliography]))),
  );
  const request = async (url: string) => {
    const appLayer = HttpApiBuilder.layer(Api as never).pipe(
      Layer.provide(Live),
      Layer.provide(Middleware.layer),
    ) as unknown as Layer.Layer<never, never, HttpRouter.HttpRouter>;
    const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
    onTestFinished(() => dispose());
    const response = await handler(new Request(url, { headers: { accept: MEDIA_TYPE } }));
    return { status: response.status, body: (await response.json()) as any };
  };

  it("names `include` and lists the includable paths", async () => {
    const response = await request("http://localhost/bibliographies/b1?include=entries.nope");
    expect(response.status).toBe(400);
    expect(response.body.errors[0]).toMatchObject({
      status: "400",
      source: { parameter: "include" },
      meta: { includablePaths: ["entries", "entries.bibliography"] },
    });
  });

  it("serves the declared depth on a collection too", async () => {
    const response = await request(
      "http://localhost/bibliographies?include=entries.bibliography&page[limit]=10",
    );
    expect(response.status).toBe(200);
  });
});
