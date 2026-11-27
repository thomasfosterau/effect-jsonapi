# The client

## Narrowing `included` by the requested include paths

The spec guarantees that a server "MUST NOT include unrequested resource objects", so the client knows _statically_ what `included` can contain — `Client.narrowIncluded` exposes that:

```ts
const include = ["author"] as const;

const doc =
  yield *
  client.articles
    .get({
      params: { id: Article.Id.make("1") },
      query: { include },
    })
    .pipe(Client.narrowIncluded(Article, include));

doc.included;
// ^ ReadonlyArray<Person> — not Person | Comment | Tag.
//   doc.included[0].attributes.firstName is accessible without narrowing on `type`.
```

Dotted paths include the intermediate resources (`["comments.author"]` → `Comment | Person`), and requesting nothing narrows `included` to `never`. This is a type-level operation with no runtime cost; the response is still decoded against the endpoint's full schema, so a non-compliant server fails loudly instead of lying.

## Reading error documents

A failure the api declares arrives as its typed error (`Effect.catchTag` above). A failure it does not — an opaque 5xx, a gateway's HTML, a truncated body — arrives as an `HttpClientError`, and `Client.errorDocument` reads whatever JSON:API error document it carries:

```ts
const message =
  yield *
  Effect.map(Client.errorDocument(cause), (document) =>
    Option.match(document, {
      onNone: () => "The server could not be reached",
      onSome: Client.errorMessage, // first `detail`, else `title`, else a constant
    }),
  );
```

The decode is genuinely best-effort: a non-conforming body degrades to `Option.none()` rather than throwing a second error inside the error path. `Client.decodeErrorDocument(body)` is the same decoder reached from a **body** rather than a response. `body` is the raw text, an already-parsed `Schema.Json` value or a `Client.ErrorDocument` you already hold, such as `ApiError.toDocument(error)`. It is a supported entry point, not an internal of the cause-based one, so a façade that synthesises responses locally and never holds an `HttpClientError` decodes through exactly the same seam as the network transport. That is what makes a façade-served error and a network-served error for the same URL indistinguishable to the client. A worked client is in [`examples/blog/client.ts`](../examples/blog/client.ts).

## The client helpers: error responses, hydration, page cursors

The consuming side of a JSON:API `HttpApi` grows the same handful of helpers in every application: a client whose failures arrive decoded, readers for the collection document's page math, a resolver from relationship linkage to the `included` resources behind it, and the `page[offset]` / `page[limit]` cursor a list page carries in its own URL. `Client` carries them.

```ts
import { Effect, Option } from "effect";
import { Client } from "@thomasfosterau/effect-jsonapi";

// Every call the server answered with an error response fails as a decoded
// `Client.ErrorResponse` — status, message, the error document when there was
// one — instead of the raw HttpClientError. Transport faults pass through.
const client = yield * Client.make(Api, { baseUrl: "https://example.test", decodeErrors: true });
const people =
  yield *
  client.people.list({ query: { page: { offset: 0, limit: 10 } } }).pipe(
    // The client's static error type cannot name `Client.ErrorResponse`, so
    // match it at runtime with `Client.isErrorResponse`.
    Effect.mapError((error) =>
      Client.isErrorResponse(error)
        ? new PageError({ status: error.status, message: error.message })
        : error,
    ),
  );

// the page math, from the real unpaged total the server reports
const total = Client.readTotalCount(people); // meta.totalCount, 0 when absent
const more = Client.hasNextPage(0, 10, total); // correct at an exact multiple of the page size
```

`Client.hydrate` resolves a document's linkage against its `included` member, typed by the resource definition: a to-one relationship is an `Option` of its target, a to-many an array in linkage order, a dotted path — the two-hop `authors.contributor` shape, where the middle resource is a relator carrying the credit's shape rather than a name — resolves to the resources at the end of it. A ref the include walk didn't hoist (or the viewer may not see) is skipped, never a failure, so `included` is legitimately a subset of the linkage.

```ts
const book = Client.hydrate(Book, document); // `included` indexed once
const authors = book.walk("authors.contributor"); // ReadonlyArray<Person>, deduplicated
const publisher = book.related("publisher"); // Option<Person>
```

The page cursor is one reader and a few href builders, so no page hands a user-controlled number onward unbounded and no filtered list drops its filter on page 2:

```ts
const cursor = Client.readPageCursor(url, { defaultLimit: 24, maxLimit: 100 }); // { offset, limit }, clamped
const href = Client.filteredPageHref("/people", Client.stripUndefined({ q })); // href(offset): bare path on page 1
const next = Client.canonicalPageHref("/people", pairs, { offset: 24, limit: 24 }); // the server's own link spelling
const window = Client.pageWindow(cursor, total); // first, last, siblings, gaps — for the control to render
```

## Walking every page

`Client.pages` follows a collection's `links.next` until the server sends none, as a `Stream` of the endpoint's documents; `Client.items` flattens them to the resources. The next href is the server's own, so the same walk covers `page[offset]`, `page[number]` and an opaque `page[cursor]`: its parameters are decoded through the endpoint's query schema and passed to the same typed call, so every page is decoded with its `included` intact.

```ts
const list = Endpoint.list(Article, { page: Query.Page.Offset });

const articles = Client.items(
  list, // the endpoint, for its query schema
  (query) => client.articles.list({ query }),
  { page: { limit: 50 } }, // the first page's query
  { maxPages: 20 }, // optional guard
);
```

Pages are requested one at a time as the stream is pulled, so `Stream.take` stops the requests too. A failed page fails the stream with whatever the call failed with (a `Client.ErrorResponse` with `decodeErrors`), and a `links.next` whose query the endpoint can't decode fails it with the `SchemaError`.
