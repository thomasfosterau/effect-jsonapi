---
"@thomasfosterau/effect-jsonapi": minor
---

Add **per-attribute projection descriptors** — control how each attribute appears in the resource
object versus the four write projections (additive, no breaking changes):

- **`Resource.attribute(schema, options)`.** Declares a per-attribute projection. Options (all
  optional; the defaults reproduce a plain `Schema` attribute):

  - `resource` — presence in the resource object schema + documents: `true` (default) or
    `"optional"` (an optional key).
  - `create` — presence in `createPayload` / `createInput`: `"required"` (default), `"optional"`,
    or `false` (excluded).
  - `update` — presence in `updatePayload` / `updateInput`: `"optional"` (default, tri-state) or
    `false` (excluded).
  - `clearable` — whether the update projection additionally accepts `null` to clear; defaults to
    whether the schema is `Schema.NullOr`.

- **`Resource.readOnlyAttribute(schema)`.** Shorthand for a server-set attribute —
  `attribute(schema, { create: false, update: false })`: present in the resource object and
  documents, excluded from every write projection. Use it for version-chain timestamps
  (`createdAt`, `updatedAt`, …), counters and other server-computed state.

  ```ts
  const Article = Resource.make("articles", {
    attributes: {
      title: Schema.NonEmptyString,
      createdAt: Resource.readOnlyAttribute(Schema.Date),
      slug: Resource.attribute(Schema.String, { update: false }),
      summary: Resource.attribute(Schema.NullOr(Schema.String), { create: "optional" })
    }
  })

  // Article.Type.attributes                  → { title, createdAt, slug, summary }
  // Article.createPayload … data.attributes  → { title, slug, summary? }   (no createdAt)
  // Article.updatePayload … data.attributes  → { title?, summary? }        (no createdAt, no slug)
  ```

A plain `Schema` attribute keeps today's read-write behaviour, so the feature is fully opt-in. The
descriptor rides on the attribute's schema value, so it flows through `attributeKeys`,
`attributeAnnotations`, sparse `fields` and `include`, is carried through `Resource.extend`, and is
respected by the Atomic `add` / `update` operations — consistently with the create/update payloads.
The type-level projection helpers `Resource.Attribute`, `Resource.AttributeConfig`,
`Resource.CreateAttributes` and `Resource.UpdateAttributes` (and the runtime
`Resource.createAttributeFields` / `Resource.updateAttributeFields`) are exported too.
