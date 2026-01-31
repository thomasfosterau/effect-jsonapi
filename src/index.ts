/**
 * effect-jsonapi - Type-safe JSON:API v1.1 schema definitions using Effect Schema
 * 
 * Based on the JSON:API v1.1 specification
 * https://jsonapi.org/format/1.1/
 * 
 * @packageDocumentation
 */

import * as S from "effect/Schema"

/**
 * Links object - URLs for navigating related resources
 * 
 * A link can be represented as:
 * - a string containing the link's URL
 * - an object with the following members:
 *   - `href` (required) - the link's URL
 *   - `rel` - the link relation type
 *   - `describedby` - a link to a description document
 *   - `title` - a human-readable title for the link
 *   - `type` - the media type of the linked resource
 *   - `hreflang` - the language(s) of the linked resource
 *   - `meta` - non-standard meta-information about the link
 * 
 * @see https://jsonapi.org/format/1.1/#document-links
 */
export const Link = S.Union(
  S.String,
  S.Struct({
    href: S.String,
    rel: S.optional(S.String),
    describedby: S.optional(S.Union(S.String, S.Array(S.String))),
    title: S.optional(S.String),
    type: S.optional(S.String),
    hreflang: S.optional(S.Union(S.String, S.Array(S.String))),
    meta: S.optional(S.Record({ key: S.String, value: S.Unknown }))
  })
)

export type Link = S.Schema.Type<typeof Link>

/**
 * Resource Identifier with ID - identifies a saved resource by type and id
 * 
 * A "resource identifier object" with a server-assigned identifier.
 * 
 * @see https://jsonapi.org/format/1.1/#document-resource-identifier-objects
 */
export const ResourceIdentifierWithId = S.Struct({
  type: S.String,
  id: S.String,
  meta: S.optional(S.Record({ key: S.String, value: S.Unknown }))
})

export type ResourceIdentifierWithId = S.Schema.Type<typeof ResourceIdentifierWithId>

/**
 * Resource Identifier with LID - identifies an unsaved resource by type and lid
 * 
 * A "resource identifier object" with a client-generated local identifier.
 * 
 * @see https://jsonapi.org/format/1.1/#document-resource-identifier-objects
 */
export const ResourceIdentifierWithLid = S.Struct({
  type: S.String,
  lid: S.String,
  meta: S.optional(S.Record({ key: S.String, value: S.Unknown }))
})

export type ResourceIdentifierWithLid = S.Schema.Type<typeof ResourceIdentifierWithLid>

/**
 * Resource Identifier - identifies a specific resource by type and id or lid
 * 
 * A "resource identifier object" identifies an individual resource.
 * Can have either `id` (for saved resources) or `lid` (for unsaved resources).
 * 
 * @see https://jsonapi.org/format/1.1/#document-resource-identifier-objects
 */
export const ResourceIdentifier = S.Union(
  ResourceIdentifierWithId,
  ResourceIdentifierWithLid
)

export type ResourceIdentifier = S.Schema.Type<typeof ResourceIdentifier>

/**
 * Relationship object - describes relationships between resources
 * 
 * A "relationship object" describes a relationship between resources.
 * It can contain:
 * - `links` - URLs for fetching the relationship
 * - `data` - Resource linkage (identifier(s) or null)
 * - `meta` - Non-standard meta-information about the relationship
 * 
 * @see https://jsonapi.org/format/1.1/#document-resource-object-relationships
 */
export const Relationship = <
  Identifier extends S.Schema.Any = typeof ResourceIdentifier
>(
  identifier?: Identifier
) => S.Struct({
  data: S.optional(S.Union(
    identifier ?? ResourceIdentifier,
    S.Array(identifier ?? ResourceIdentifier),
    S.Null
  )),
  links: S.optional(S.Record({ key: S.String, value: Link })),
  meta: S.optional(S.Record({ key: S.String, value: S.Unknown }))
})

/**
 * Resource Object with ID - a saved resource with server-assigned identifier
 * 
 * @see https://jsonapi.org/format/1.1/#document-resource-objects
 */
export const ResourceObjectWithId = <
  Type extends S.Schema.Any = typeof S.String,
  Id extends S.Schema.Any = typeof S.String,
  Attributes extends S.Schema.Any = S.Schema<Record<string, unknown>>,
  Relationships extends S.Schema.Any = S.Schema<Record<string, unknown>>,
  ResourceLinks extends S.Schema.Any = S.Schema<Record<string, Link>>,
  Meta extends S.Schema.Any = S.Schema<Record<string, unknown>>
>(options?: {
  type?: Type
  id?: Id
  attributes?: Attributes
  relationships?: Relationships
  links?: ResourceLinks
  meta?: Meta
}) => {
  return S.Struct({
    type: options?.type ?? S.String,
    id: options?.id ?? S.String,
    attributes: S.optional(
      options?.attributes ?? S.Record({ key: S.String, value: S.Unknown })
    ),
    relationships: S.optional(
      options?.relationships ?? S.Record({ key: S.String, value: S.Unknown })
    ),
    links: S.optional(options?.links ?? S.Record({ key: S.String, value: Link })),
    meta: S.optional(
      options?.meta ?? S.Record({ key: S.String, value: S.Unknown })
    )
  })
}

/**
 * Resource Object with LID - an unsaved resource with client-generated identifier
 * 
 * @see https://jsonapi.org/format/1.1/#document-resource-objects
 */
export const ResourceObjectWithLid = <
  Type extends S.Schema.Any = typeof S.String,
  Lid extends S.Schema.Any = typeof S.String,
  Attributes extends S.Schema.Any = S.Schema<Record<string, unknown>>,
  Relationships extends S.Schema.Any = S.Schema<Record<string, unknown>>,
  ResourceLinks extends S.Schema.Any = S.Schema<Record<string, Link>>,
  Meta extends S.Schema.Any = S.Schema<Record<string, unknown>>
>(options?: {
  type?: Type
  id?: Lid
  attributes?: Attributes
  relationships?: Relationships
  links?: ResourceLinks
  meta?: Meta
}) => {
  return S.Struct({
    type: options?.type ?? S.String,
    lid: options?.id ?? S.String,
    attributes: S.optional(
      options?.attributes ?? S.Record({ key: S.String, value: S.Unknown })
    ),
    relationships: S.optional(
      options?.relationships ?? S.Record({ key: S.String, value: S.Unknown })
    ),
    links: S.optional(options?.links ?? S.Record({ key: S.String, value: Link })),
    meta: S.optional(
      options?.meta ?? S.Record({ key: S.String, value: S.Unknown })
    )
  })
}

/**
 * Creates a Resource Object schema with optional type constraints
 * 
 * A "resource object" represents a resource.
 * Can have either `id` (for saved resources) or `lid` (for unsaved resources).
 * 
 * @see https://jsonapi.org/format/1.1/#document-resource-objects
 * 
 * @example
 * ```typescript
 * import * as S from "effect/Schema"
 * import * as JsonApi from "effect-jsonapi"
 * 
 * const User = JsonApi.ResourceObject({
 *   type: S.Literal("users"),
 *   id: S.UUID,
 *   attributes: S.Struct({
 *     name: S.String,
 *     email: S.String
 *   }),
 *   relationships: S.Struct({
 *     posts: JsonApi.Relationship()
 *   })
 * })
 * ```
 */
export const ResourceObject = <
  Type extends S.Schema.Any = typeof S.String,
  Id extends S.Schema.Any = typeof S.String,
  Attributes extends S.Schema.Any = S.Schema<Record<string, unknown>>,
  Relationships extends S.Schema.Any = S.Schema<Record<string, unknown>>,
  ResourceLinks extends S.Schema.Any = S.Schema<Record<string, Link>>,
  Meta extends S.Schema.Any = S.Schema<Record<string, unknown>>
>(options?: {
  type?: Type
  id?: Id
  attributes?: Attributes
  relationships?: Relationships
  links?: ResourceLinks
  meta?: Meta
}) => {
  return S.Union(
    ResourceObjectWithId(options),
    ResourceObjectWithLid(options)
  )
}

/**
 * Error Source - indicates which part of the request caused the error
 * 
 * An error source object can contain:
 * - `pointer` - A JSON Pointer to the value in the request document that caused the error
 * - `parameter` - A string indicating which URI query parameter caused the error
 * - `header` - A string indicating the name of a single request header which caused the error
 * 
 * @see https://jsonapi.org/format/1.1/#error-objects
 */
export const ErrorSource = S.Struct({
  pointer: S.optional(S.String),
  parameter: S.optional(S.String),
  header: S.optional(S.String)
})

export type ErrorSource = S.Schema.Type<typeof ErrorSource>

/**
 * Error Object - provides additional information about problems encountered while performing an operation
 * 
 * Error objects provide additional information about problems encountered while performing an operation.
 * 
 * Members:
 * - `id` - A unique identifier for this particular occurrence of the problem
 * - `status` - The HTTP status code applicable to this problem, expressed as a string value
 * - `code` - An application-specific error code, expressed as a string value
 * - `title` - A short, human-readable summary of the problem (should not change between occurrences)
 * - `detail` - A human-readable explanation specific to this occurrence of the problem
 * - `source` - An object containing references to the primary source of the error
 * - `meta` - Non-standard meta-information about the error
 * 
 * @see https://jsonapi.org/format/1.1/#error-objects
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
 * JSON:API Object - describes the server's implementation
 * 
 * A JSON:API document may include information about its implementation.
 * If present, this object can contain:
 * - `version` - The highest JSON:API version supported
 * - `meta` - Non-standard meta-information
 * 
 * @see https://jsonapi.org/format/1.1/#document-jsonapi-object
 */
export const JsonApiObject = S.Struct({
  version: S.optional(S.String),
  meta: S.optional(S.Record({ key: S.String, value: S.Unknown }))
})

export type JsonApiObject = S.Schema.Type<typeof JsonApiObject>

/**
 * Default Resource Object schema (for use in Document schemas)
 * Uses the base ResourceObject factory with default parameters
 */
const DefaultResourceObject = ResourceObject()

/**
 * JSON:API Document - the top-level structure of every JSON:API response
 * 
 * A document must contain at least one of the following top-level members:
 * - `data` - The document's "primary data"
 * - `errors` - An array of error objects
 * - `meta` - A meta object that contains non-standard meta-information
 * 
 * A document may also contain:
 * - `jsonapi` - An object describing the server's implementation
 * - `links` - A links object related to the primary data
 * - `included` - An array of resource objects that are related to the primary data
 * 
 * The members `data` and `errors` must not coexist in the same document.
 * 
 * @see https://jsonapi.org/format/1.1/#document-top-level
 */
export const Document = <
  Data extends S.Schema.Any = typeof DefaultResourceObject
>(dataSchema?: Data) => {
  const resourceSchema = dataSchema ?? DefaultResourceObject
  return S.Struct({
    data: S.optional(S.Union(
      resourceSchema,
      S.Array(resourceSchema),
      S.Null
    )),
    errors: S.optional(S.Array(ErrorObject)),
    meta: S.optional(S.Record({ key: S.String, value: S.Unknown })),
    jsonapi: S.optional(JsonApiObject),
    links: S.optional(S.Record({ key: S.String, value: Link })),
    included: S.optional(S.Array(resourceSchema))
  })
}
