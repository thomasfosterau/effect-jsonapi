/**
 * JSON:API Schema definitions using Effect Schema
 * 
 * Based on the JSON:API v1.1 specification
 * https://jsonapi.org/format/
 */

import * as S from "effect/Schema"

/**
 * Links object - URLs for navigating related resources
 */
export const Links = S.Record({
  key: S.String,
  value: S.Union(
    S.String,
    S.Struct({
      href: S.String,
      meta: S.optional(S.Record({ key: S.String, value: S.Unknown }))
    })
  )
})

export type Links = S.Schema.Type<typeof Links>

/**
 * Resource Identifier - identifies a specific resource by type and id
 */
export const ResourceIdentifier = S.Struct({
  type: S.String,
  id: S.String,
  meta: S.optional(S.Record({ key: S.String, value: S.Unknown }))
})

export type ResourceIdentifier = S.Schema.Type<typeof ResourceIdentifier>

/**
 * Relationship - describes a relationship to another resource
 */
export const Relationship = S.Struct({
  data: S.optional(S.Union(
    ResourceIdentifier,
    S.Array(ResourceIdentifier),
    S.Null
  )),
  links: S.optional(Links),
  meta: S.optional(S.Record({ key: S.String, value: S.Unknown }))
})

export type Relationship = S.Schema.Type<typeof Relationship>

/**
 * Resource Object - the primary data structure in JSON:API
 */
export const ResourceObject = S.Struct({
  type: S.String,
  id: S.String,
  attributes: S.optional(S.Record({ key: S.String, value: S.Unknown })),
  relationships: S.optional(S.Record({ key: S.String, value: Relationship })),
  links: S.optional(Links),
  meta: S.optional(S.Record({ key: S.String, value: S.Unknown }))
})

export type ResourceObject = S.Schema.Type<typeof ResourceObject>

/**
 * Resource Object for Create Requests - id is optional for client-generated create requests
 */
export const ResourceObjectCreate = S.Struct({
  type: S.String,
  id: S.optional(S.String),
  attributes: S.optional(S.Record({ key: S.String, value: S.Unknown })),
  relationships: S.optional(S.Record({ key: S.String, value: Relationship })),
  links: S.optional(Links),
  meta: S.optional(S.Record({ key: S.String, value: S.Unknown }))
})

export type ResourceObjectCreate = S.Schema.Type<typeof ResourceObjectCreate>

/**
 * Error Source - pointer to the source of an error
 */
export const ErrorSource = S.Struct({
  pointer: S.optional(S.String),
  parameter: S.optional(S.String),
  header: S.optional(S.String)
})

export type ErrorSource = S.Schema.Type<typeof ErrorSource>

/**
 * Error Object - represents an error in JSON:API format
 */
export const ErrorObject = S.Struct({
  id: S.optional(S.String),
  status: S.optional(S.String),
  code: S.optional(S.String),
  title: S.optional(S.String),
  detail: S.optional(S.String),
  source: S.optional(ErrorSource),
  meta: S.optional(S.Record({ key: S.String, value: S.Unknown }))
})

export type ErrorObject = S.Schema.Type<typeof ErrorObject>

/**
 * JSON:API Version Object
 */
export const JsonApiObject = S.Struct({
  version: S.optional(S.String),
  meta: S.optional(S.Record({ key: S.String, value: S.Unknown }))
})

export type JsonApiObject = S.Schema.Type<typeof JsonApiObject>

/**
 * JSON:API Document - the top-level structure of every response
 */
export const Document = S.Struct({
  data: S.optional(S.Union(
    ResourceObject,
    S.Array(ResourceObject),
    S.Null
  )),
  errors: S.optional(S.Array(ErrorObject)),
  meta: S.optional(S.Record({ key: S.String, value: S.Unknown })),
  jsonapi: S.optional(JsonApiObject),
  links: S.optional(Links),
  included: S.optional(S.Array(ResourceObject))
})

export type Document = S.Schema.Type<typeof Document>

/**
 * JSON:API Document for Create Requests - allows resources without id
 */
export const DocumentCreate = S.Struct({
  data: S.optional(S.Union(
    ResourceObjectCreate,
    S.Array(ResourceObjectCreate),
    S.Null
  )),
  errors: S.optional(S.Array(ErrorObject)),
  meta: S.optional(S.Record({ key: S.String, value: S.Unknown })),
  jsonapi: S.optional(JsonApiObject),
  links: S.optional(Links),
  included: S.optional(S.Array(ResourceObject))
})

export type DocumentCreate = S.Schema.Type<typeof DocumentCreate>
