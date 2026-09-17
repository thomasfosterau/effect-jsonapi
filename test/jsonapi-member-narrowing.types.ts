/**
 * Type-level tests for the `jsonapi` option on the `Handlers` document
 * builders (`data` / `collection` / `linkage`).
 *
 * The return type narrows on whether the option was passed: `jsonapi` is
 * present (and required) in the return type when `{ jsonapi: ... }` is given,
 * and absent from the return type entirely when it isn't — so reading
 * `.jsonapi` back off a built document never needs a cast, in either
 * direction.
 *
 * This file is type-checked by `tsconfig.test.json`; the `@ts-expect-error`
 * annotations are the assertions. Every binding is exported so an unused-local
 * error can never stand in for the assertion an `@ts-expect-error` expects.
 */
import { Schema } from "effect"
import { Document, Handlers, Resource } from "@thomasfosterau/effect-jsonapi"

const Article = Resource.make("articles", { attributes: { title: Schema.NonEmptyString } })
const article = Article.make({ id: Article.Id.make("1"), attributes: { title: "Hi" } })

// ---------------------------------------------------------------------------
// Handlers.data
// ---------------------------------------------------------------------------

// Negative control: `jsonapi` reads back without a cast when it was passed.
export const dataWithJsonapi = Handlers.data(article, { jsonapi: Document.v1_1 })
export const dataWithJsonapiVersion: string | undefined = dataWithJsonapi.jsonapi.version

export const dataWithoutJsonapi = Handlers.data(article)
// @ts-expect-error -- no `jsonapi` option was passed, so the return type has no `jsonapi` member
export const dataMissingJsonapi = dataWithoutJsonapi.jsonapi

// ---------------------------------------------------------------------------
// Handlers.collection
// ---------------------------------------------------------------------------

export const collectionWithJsonapi = Handlers.collection([article], { jsonapi: Document.v1_1 })
export const collectionWithJsonapiVersion: string | undefined = collectionWithJsonapi.jsonapi.version

export const collectionWithoutJsonapi = Handlers.collection([article])
// @ts-expect-error -- no `jsonapi` option was passed, so the return type has no `jsonapi` member
export const collectionMissingJsonapi = collectionWithoutJsonapi.jsonapi

// ---------------------------------------------------------------------------
// Handlers.linkage
// ---------------------------------------------------------------------------

export const linkageWithJsonapi = Handlers.linkage({ type: "people", id: "9" }, { jsonapi: Document.v1_1 })
export const linkageWithJsonapiVersion: string | undefined = linkageWithJsonapi.jsonapi.version

export const linkageWithoutJsonapi = Handlers.linkage({ type: "people", id: "9" })
// @ts-expect-error -- no `jsonapi` option was passed, so the return type has no `jsonapi` member
export const linkageMissingJsonapi = linkageWithoutJsonapi.jsonapi
