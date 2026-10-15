---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking (types): a read endpoint that declares `fields` binds a document whose resource attributes are optional by default, so `Handlers.project(query.fields)` fits it and `?fields[TYPE]=` can be answered as §Sparse Fieldsets requires.** Before, the default document required every attribute. A handler that projected a fieldset did not compile, and when forced it answered 500 (`ResponseEncodeError`) as soon as a client excluded a required attribute.

The change applies to the primary data and to every `included` member of a type a `fields[TYPE]` can name, which is the set `Query.FieldsetResources` computes. Each attribute becomes an optional key, and one already optional stays as declared. `type`, `id`, `relationships`, `links` and `meta` are unchanged. It holds for `Endpoint.get`, `list`, `related`, `collection` and `polymorphic`, and for the `get`, `list` and related endpoints `Endpoint.resource` / `Group.resource` generate, which declare `fields` by default. `Endpoint.RelatedSuccess` takes a matching `Fields` parameter, which defaults to `false`.

Clients see the change: an `HttpApiClient` for such an endpoint decodes those attributes as optional (`doc.data.attributes.title: string | undefined`). A handler that leaves out a required attribute now compiles and encodes, where it used to answer 500. To keep strict attributes, either leave `fields` off (`fields: false`), or keep it and pass the resource's own document as `success` (`success: Article.document()`, or `Article.collection()` for `list`). An endpoint without `fields` is unchanged, on the wire and in its types.
