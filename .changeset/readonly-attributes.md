---
"@thomasfosterau/effect-jsonapi": minor
---

Add per-attribute **read-only (server-set) attributes** (additive, no breaking changes):

- **`Resource.readOnlyAttribute(schema)`.** Marks an attribute as read-only: it stays in the
  resource object schema, its `Document`s, `attributeKeys`, `attributeAnnotations`, sparse `fields`
  and `include`, but is **excluded** from the create/update payloads (`createPayload` /
  `updatePayload`) and the flat create/update inputs (`createInput` / `updateInput`). Use it for
  server-computed or -derived state — version-chain timestamps (`createdAt`, `updatedAt`,
  `publishedAt`, `deletedAt`), counters — that appear in responses but must never be accepted as
  client input. A plain `Schema` attribute keeps today's read-write behaviour, so the feature is
  fully opt-in.

  ```ts
  const Article = Resource.make("articles", {
    attributes: {
      title: Schema.NonEmptyString,
      createdAt: Resource.readOnlyAttribute(Schema.Date) // resource + document only
    }
  })

  // Article.Type.attributes                  → { title, createdAt }
  // Article.createPayload.Type … attributes  → { title }
  // Article.updatePayload.Type … attributes  → { title? }
  // Article.createInput.Type                 → { title }
  // Article.updateInput.Type                 → { id, title? }
  ```

  Read-only attributes are carried through `Resource.extend`, so a subtype inherits them excluded
  from its own write projections. Apply `readOnlyAttribute` as the outermost wrapper (annotate the
  inner schema first). The supporting type-level helpers `Resource.ReadOnlyAttribute` and
  `Resource.WritableAttributes` are exported too.
