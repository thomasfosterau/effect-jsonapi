---
"@thomasfosterau/effect-jsonapi": minor
---

The client-side helpers three consuming applications each re-implemented in their web app's api layer, as an extension of `Client`:

- **Decoded error responses** — `Client.make(api, { decodeErrors: true })` fails every call the server answered with an error response as a `Client.ErrorResponse` (its status, a readable message, the JSON:API error document when the body carried one) instead of the raw `HttpClientError`; transport faults pass through unchanged. `Client.failWithErrorResponse` is the same seam standalone, `Client.toErrorResponse` the reader behind it, `Client.isErrorResponse` the guard.
- **Document readers** — `Client.ResourceDocument<R>` / `Client.CollectionDocument<R>` (the wire form, `Document.Wire`), `Client.readTotalCount` and `Client.hasNextPage` (correct at an exact multiple of the page size).
- **Call-site inputs** — `Client.LooseInput<T>`, `Client.stripUndefined` and `Client.decodeInput(schema)`, which strips explicitly-`undefined` members before decoding a flat list or command input with its defaults and bounds.
- **`included` hydration, typed by the resource definition** — `Client.indexIncluded` (once per document), `Client.related(resource, data, key, index)` (an `Option` of the target for a to-one relationship, an array in linkage order for a to-many; an unresolved ref is skipped, never a failure), `Client.walk(resource, data, "authors.contributor", index)` (a dotted path hop by hop to the last hop's resources, deduplicated) and `Client.hydrate(resource, document)` binding both to one document.
- **Page cursors** — `Client.readPageCursor` (`page[offset]` / `page[limit]` off a URL, search params or query string, per-field fallbacks, the limit clamped, a custom key for a page with two lists), `Client.pageHref` (replace the cursor, keep everything else), `Client.filteredPageHref` / `Client.windowedPageHref` (the two `href(offset)` builders index pages use), `Client.canonicalPageHref` (the cursor spliced into `Query.canonicalPairs` output, the spelling a server's collection links use) and `Client.pageWindow` (the page-link window arithmetic behind a pagination control).
