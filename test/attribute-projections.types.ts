/**
 * Type-level tests for the per-attribute projection descriptors
 * (`Resource.attribute`): how a declared attribute lands on the resource object
 * versus the write projections.
 *
 *   - `resource: false` declares an **input-only** attribute: it is absent from
 *     the resource object, its documents, `AttributeKeys` and sparse fieldsets,
 *     but projected into `createInput` / `createPayload` (and the Atomic `add`
 *     operation) per `create`, and into `updateInput` / `updatePayload` per
 *     `update`.
 *   - `create: "optional"` projects as `Schema.optional` — the value may be an
 *     explicit `undefined` — exactly as the update projection does.
 *
 * This file is type-checked by `tsconfig.test.json`; the `@ts-expect-error`
 * annotations are the assertions. Every binding is exported so an unused-local
 * error can never stand in for the assertion an `@ts-expect-error` expects.
 */
import { Schema } from "effect"
import { Atomic, Query, Resource } from "@thomasfosterau/effect-jsonapi"

// Asserts that a value is assignable to `Expected`.
const assertType = <Expected>(_value: Expected): void => {}

// Whether two types are identical (not merely mutually assignable) — the
// tsconfig does not set `exactOptionalPropertyTypes`, so `{ x?: string }` and
// `{ x?: string | undefined }` are mutually assignable; comparing the field
// schemas' own `Type` tells them apart.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

// An upload: the binary `file` is accepted at create and never on the resource
// object; `secret` is accepted at create and update, never shown; `caption` is
// optional at create.
const Upload = Resource.make("uploads", {
  attributes: {
    fileName: Schema.NonEmptyString,
    file: Resource.attribute(Schema.Uint8Array, { resource: false, update: false }),
    secret: Resource.attribute(Schema.String, { resource: false }),
    caption: Resource.attribute(Schema.String, { create: "optional" })
  }
})

declare const upload: typeof Upload.Type
declare const bytes: Uint8Array

// ---------------------------------------------------------------------------
// The resource object omits input-only attributes
// ---------------------------------------------------------------------------

assertType<string>(upload.attributes.fileName)
// @ts-expect-error -- `file` is input-only: not on the resource object
assertType<Uint8Array>(upload.attributes.file)
// @ts-expect-error -- `secret` is input-only: not on the resource object
assertType<string>(upload.attributes.secret)

type Keys = Resource.AttributeKeys<typeof Upload>
const key: Keys = "fileName"
// @ts-expect-error -- input-only attributes are not attribute keys
const badKey: Keys = "file"

// The declared map keeps them; the resource-object map does not.
type Declared = keyof Resource.DeclaredAttributesOf<typeof Upload>
const declared: Declared = "file"
type OnResource = keyof Resource.AttributesOf<typeof Upload>
// @ts-expect-error -- `file` is declared, but not a resource-object attribute
const notOnResource: OnResource = "file"

// A sparse fieldset for the resource cannot name an input-only attribute.
const fieldset = Query.Fieldset(Upload)
type Field = (typeof fieldset.Type)[number]
const field: Field = "fileName"
// @ts-expect-error -- "file" is not a selectable field
const badField: Field = "file"

// ---------------------------------------------------------------------------
// The write projections carry input-only attributes per `create` / `update`
// ---------------------------------------------------------------------------

const createInput: typeof Upload.createInput.Type = { fileName: "a.png", file: bytes, secret: "s" }
// @ts-expect-error -- `file` is required at create
const createMissingFile: typeof Upload.createInput.Type = { fileName: "a.png", secret: "s" }

const createPayload: typeof Upload.createPayload.Type = {
  data: { type: "uploads", attributes: { fileName: "a.png", file: bytes, secret: "s" } }
}

// `update: "optional"` (the default) keeps `secret`; `update: false` drops `file`.
const updateInput: typeof Upload.updateInput.Type = { id: Upload.Id.make("1"), secret: "t" }
// @ts-expect-error -- `file` is create-only: not an update input
const updateWithFile: typeof Upload.updateInput.Type = { id: Upload.Id.make("1"), file: bytes }

// The Atomic `add` operation mirrors `createPayload`.
const addOperation = Atomic.add(Upload, { attributes: { fileName: "a.png", file: bytes, secret: "s" } })
assertType<Uint8Array>(addOperation.data.attributes.file)
// @ts-expect-error -- `file` is required in the add operation too
Atomic.add(Upload, { attributes: { fileName: "a.png", secret: "s" } })

// ---------------------------------------------------------------------------
// `create: "optional"` projects as `Schema.optional`, as the update side does
// ---------------------------------------------------------------------------

// The field schema is `Schema.optional<S>`: its own `Type` admits `undefined`
// (a strict `Schema.optionalKey<S>` would give plain `string`).
const captionIsOptional: Equals<(typeof Upload.createInput.fields.caption)["Type"], string | undefined> = true
const captionInPayload: Equals<
  (typeof Upload.createPayload.fields.data.fields.attributes.fields.caption)["Type"],
  string | undefined
> = true
const captionInAdd: Equals<
  Atomic.AddOperation<typeof Upload>["Type"]["data"]["attributes"]["caption"],
  string | undefined
> = true
// … and the same shape as the update projection gives it
const captionMatchesUpdate: Equals<
  (typeof Upload.createInput.fields.caption)["Type"],
  (typeof Upload.updateInput.fields.caption)["Type"]
> = true

// So a caller computing `caption: maybeUndefined` type-checks against both
// projections, exactly as the issue asks (and would under
// `exactOptionalPropertyTypes` too, since the value type includes `undefined`).
declare const maybeCaption: string | undefined
const createWithMaybe: typeof Upload.createInput.Type = {
  fileName: "a.png",
  file: bytes,
  secret: "s",
  caption: maybeCaption
}
const updateWithMaybe: typeof Upload.updateInput.Type = { id: Upload.Id.make("1"), caption: maybeCaption }
const addWithMaybe = Atomic.add(Upload, {
  attributes: { fileName: "a.png", file: bytes, secret: "s", caption: maybeCaption }
})

// `create: "required"` (the default) is untouched: no `undefined`.
const fileNameIsRequired: Equals<(typeof Upload.createInput.fields.fileName)["Type"], string> = true

// A bare `Schema.optionalKey(S)` attribute (no descriptor) is widened the same
// way at create — the update side already was — while a bare `Schema.optional(S)`
// is already that shape and stays as declared.
const Profile = Resource.make("profiles", {
  attributes: {
    handle: Schema.NonEmptyString,
    bio: Schema.optionalKey(Schema.String),
    motto: Schema.optional(Schema.String)
  }
})
const bioIsOptional: Equals<(typeof Profile.createInput.fields.bio)["Type"], string | undefined> = true
const bioMatchesUpdate: Equals<
  (typeof Profile.createInput.fields.bio)["Type"],
  (typeof Profile.updateInput.fields.bio)["Type"]
> = true
const bioInAdd: Equals<Atomic.AddOperation<typeof Profile>["Type"]["data"]["attributes"]["bio"], string | undefined> =
  true
const mottoUnchanged: Equals<typeof Profile.createInput.fields.motto, typeof Profile.fields.attributes.fields.motto> =
  true
declare const maybeBio: string | undefined
const profileCreate: typeof Profile.createInput.Type = { handle: "h", bio: maybeBio }
const profileAdd = Atomic.add(Profile, { attributes: { handle: "h", bio: maybeBio } })

// ---------------------------------------------------------------------------
// `resource` must be a literal
// ---------------------------------------------------------------------------

declare const hidden: boolean
// @ts-expect-error -- a non-literal boolean cannot decide the resource-object type
Resource.attribute(Schema.String, { resource: hidden })
// the literals are all fine, including through a `const` context
const shown = Resource.attribute(Schema.String, { resource: true })
const optionalOnResource = Resource.attribute(Schema.String, { resource: "optional" })
const inputOnly = Resource.attribute(Schema.String, { resource: false })

// ---------------------------------------------------------------------------
// `extend` inherits input-only attributes
// ---------------------------------------------------------------------------

const Image = Resource.extend(Upload, "images", { attributes: { width: Schema.Int } })
declare const image: typeof Image.Type

const imageCreate: typeof Image.createInput.Type = { fileName: "a.png", file: bytes, secret: "s", width: 4 }
// @ts-expect-error -- the inherited `file` stays required at create
const imageCreateMissingFile: typeof Image.createInput.Type = { fileName: "a.png", secret: "s", width: 4 }
// @ts-expect-error -- and stays off the resource object
assertType<Uint8Array>(image.attributes.file)

export {
  addOperation,
  addWithMaybe,
  badField,
  badKey,
  bioInAdd,
  bioIsOptional,
  bioMatchesUpdate,
  captionInAdd,
  captionInPayload,
  captionIsOptional,
  captionMatchesUpdate,
  createInput,
  createMissingFile,
  createPayload,
  createWithMaybe,
  declared,
  field,
  fileNameIsRequired,
  imageCreate,
  imageCreateMissingFile,
  inputOnly,
  key,
  mottoUnchanged,
  notOnResource,
  optionalOnResource,
  profileAdd,
  profileCreate,
  shown,
  updateInput,
  updateWithFile,
  updateWithMaybe
}
