---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking (types only):** the "option omitted" sentinel of the generic option parameters is `never`, no longer `undefined` (#533). This covers:

- the `page` / `filter` parameters of `Endpoint.list`, `collection`, `related`, `getRelationship` and `resource`, and of `Endpoint.ResourceEndpoint`, `ResourceEndpoints` and `ResourceOptions`;
- `Group.resource`'s `Page` / `Filter`, and the `Surface` of `Group.flat`, `Group.flatReadOnly`, `Group.FlatOptions` and `Group.FlatReadOnlyOptions`;
- `Endpoint.polymorphic`'s and `Resource.Family`'s `Base`, `Resource.attribute`'s `Clearable`, and `Resource.extend`'s and `Resource.ExtendedId`'s custom id;
- `Query.Include`'s `options`, and `Query.Options`' `page` / `filter` members, which no longer take `undefined`; `Query.QuerySchema`, `NestedFields`, `FlatFields` and `FlatSchema` read a `never` `page` / `filter` as absent;
- `Handlers.paginatedRelationship`'s `Self`;
- `Idempotency.HeadersFor` / `Applied`, which now require an `Idempotency.Option`;
- `Assemble.unpaginatedCollection`'s `Self` / `M`, and `Assemble.UnpaginatedCollectionOptions` and `UnpaginatedCollectionDocument`. Their "maybe passed" state (`string | undefined`, `Meta | undefined`), which made the document's `links` / `meta` optional, is gone: a document has `links` exactly when a `self` is passed, and `meta` exactly when a `meta` is.

Code that relies on inference is unaffected: omitting an option derives the same query, document, id and `clearable` types as before. Two kinds of code change:

- **An explicit `undefined` type argument** for one of these parameters is now a constraint error. Omit the type argument, or pass `never`: `Endpoint.ResourceEndpoints<…, Sort, never, never, Meta>`, `Resource.ExtendedId<BaseId, "editors", false>`, `Idempotency.HeadersFor<false>`, `Assemble.UnpaginatedCollectionDocument<R, never, Meta>`.
- **An explicit or maybe-`undefined` value** for one of these options (`{ page: undefined }` and `{ filter: undefined }` in `Endpoint.*`, `Group.resource` or `Query.schema`; `{ include: undefined }` in `Group.flat*`; `{ self: undefined }` in `Handlers.paginatedRelationship`; `{ clearable: undefined }`; `{ self: maybeSelf }` / `{ meta: maybeMeta }` in `Assemble.unpaginatedCollection`) no longer stands for "omitted". Under `exactOptionalPropertyTypes` it is a compile error. Leave the key out instead, passing it only when it is defined:

  ```ts
  // before: Endpoint.list(Article, { page: maybePage })
  const listArticles =
    maybePage === undefined ? Endpoint.list(Article) : Endpoint.list(Article, { page: maybePage });

  // before: Assemble.unpaginatedCollection(rows, { self: options.self })
  const document =
    options.self === undefined
      ? Assemble.unpaginatedCollection(rows)
      : Assemble.unpaginatedCollection(rows, { self: options.self });
  ```

`Relationship.StorageKey` and `Relationship.Paginated`'s `order` are unchanged: their sentinel is the type of a runtime property, tracked separately.
