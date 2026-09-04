---
"@thomasfosterau/effect-jsonapi": minor
---

**Input-only (write-only) attributes, and optional create attributes that accept `undefined`.**

- `Resource.attribute(schema, { resource: false })` declares an attribute that is **accepted as
  input but never on the resource object** — an upload's binary, a password, a one-time token — so a
  write-only field is declarable in one place (#47). The attribute is absent from the resource
  `Schema.Struct` (at runtime and in the types: `ResourceFields["attributes"]` is now
  `Schema.Struct<ResourceAttributes<Attributes>>`), its documents, `AttributeKeys`, `attributeKeys`,
  `attributeAnnotations`, sparse fieldsets and `filterable` / `sortable`, while it still projects into
  `createPayload` / `createInput` and `updatePayload` / `updateInput` per its `create` / `update`
  settings, and into the atomic `add` / `update` operations.

  ```ts
  const Upload = Resource.make("uploads", {
    attributes: {
      fileName: Schema.NonEmptyString,
      file: Resource.attribute(FileSchema, { resource: false, update: false }) // create-only binary
    }
  })
  // Upload.Type.attributes  → { fileName }          Upload.createInput.Type → { fileName, file }
  ```

  The map _as declared_ stays reachable as `Upload.declaredAttributes` / `Resource.declaredAttributes(R)`
  (`Resource.DeclaredAttributesOf<R>`); `Resource.attributes(R)` keeps returning the resource-object
  map. `Resource.extend` inherits input-only attributes; name-only families keep intersecting
  resource-object fields. `Resource.make` throws, naming the attribute, for `resource: false` combined
  with both `create: false` and `update: false` (declares nothing), or with a `filter` / `sort`
  declaration (not on the resource object, so nothing to filter or sort by). `AttributeConfig` gains a
  trailing `Resource` parameter (defaulting to `true`).

- `create: "optional"` now projects as `Schema.optional(S)` — the key may be absent, or present with
  a value or an explicit `undefined` — instead of the strict `Schema.optionalKey(S)`, matching what
  `updateInput` / `updatePayload` already do (#48). A caller building `{ x: maybeUndefined }` (a form
  adapter computing `x: input.x?.trim() || undefined`) now type-checks against `createInput` under
  `exactOptionalPropertyTypes` as it already did against `updateInput`. This is a **type widening** of
  `createInput` / `createPayload` (and the atomic `add` operation) for optional attributes: the field
  schema is `Schema.optional<S>` rather than `Schema.optionalKey<S>`, so its `Type` is
  `S["Type"] | undefined`. On a JSON wire an explicit `undefined` and an absent key are the same
  thing. Code that pinned the `optionalKey` shape needs the wider type; nothing that decoded before
  is rejected now.
