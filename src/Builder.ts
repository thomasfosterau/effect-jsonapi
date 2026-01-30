/**
 * Builder utilities for constructing JSON:API responses
 */

import * as Effect from "effect/Effect"
import type * as Schema from "./Schema"

/**
 * Create a resource object
 */
export const resource = (
  type: string,
  id: string,
  attributes?: Record<string, unknown>,
  options?: {
    relationships?: Record<string, Schema.Relationship>
    links?: Schema.Links
    meta?: Record<string, unknown>
  }
): Schema.ResourceObject => ({
  type,
  id,
  attributes,
  relationships: options?.relationships,
  links: options?.links,
  meta: options?.meta
})

/**
 * Create a resource identifier
 */
export const resourceIdentifier = (
  type: string,
  id: string,
  meta?: Record<string, unknown>
): Schema.ResourceIdentifier => ({
  type,
  id,
  meta
})

/**
 * Create a to-one relationship
 */
export const toOneRelationship = (
  data: Schema.ResourceIdentifier | null,
  options?: {
    links?: Schema.Links
    meta?: Record<string, unknown>
  }
): Schema.Relationship => ({
  data,
  links: options?.links,
  meta: options?.meta
})

/**
 * Create a to-many relationship
 */
export const toManyRelationship = (
  data: Schema.ResourceIdentifier[],
  options?: {
    links?: Schema.Links
    meta?: Record<string, unknown>
  }
): Schema.Relationship => ({
  data,
  links: options?.links,
  meta: options?.meta
})

/**
 * Create a successful document with a single resource
 */
export const successOne = (
  resource: Schema.ResourceObject,
  options?: {
    included?: Schema.ResourceObject[]
    links?: Schema.Links
    meta?: Record<string, unknown>
    jsonapi?: Schema.JsonApiObject
  }
): Schema.Document => ({
  data: resource,
  included: options?.included,
  links: options?.links,
  meta: options?.meta,
  jsonapi: options?.jsonapi
})

/**
 * Create a successful document with multiple resources
 */
export const successMany = (
  resources: Schema.ResourceObject[],
  options?: {
    included?: Schema.ResourceObject[]
    links?: Schema.Links
    meta?: Record<string, unknown>
    jsonapi?: Schema.JsonApiObject
  }
): Schema.Document => ({
  data: resources,
  included: options?.included,
  links: options?.links,
  meta: options?.meta,
  jsonapi: options?.jsonapi
})

/**
 * Create an error object
 */
export const error = (
  options: {
    id?: string
    status?: string
    code?: string
    title?: string
    detail?: string
    source?: Schema.ErrorSource
    meta?: Record<string, unknown>
  }
): Schema.ErrorObject => options

/**
 * Create an error document
 */
export const errorDocument = (
  errors: Schema.ErrorObject[],
  options?: {
    meta?: Record<string, unknown>
    jsonapi?: Schema.JsonApiObject
  }
): Schema.Document => ({
  errors,
  meta: options?.meta,
  jsonapi: options?.jsonapi
})

/**
 * Effect-based builders that return Effect values
 */

/**
 * Create a successful Effect with a single resource
 */
export const successOneEffect = <E = never, R = never>(
  resource: Schema.ResourceObject,
  options?: Parameters<typeof successOne>[1]
): Effect.Effect<Schema.Document, E, R> =>
  Effect.succeed(successOne(resource, options))

/**
 * Create a successful Effect with multiple resources
 */
export const successManyEffect = <E = never, R = never>(
  resources: Schema.ResourceObject[],
  options?: Parameters<typeof successMany>[1]
): Effect.Effect<Schema.Document, E, R> =>
  Effect.succeed(successMany(resources, options))

/**
 * Create an error Effect
 */
export const errorEffect = <E = never, R = never>(
  errors: Schema.ErrorObject[],
  options?: Parameters<typeof errorDocument>[1]
): Effect.Effect<Schema.Document, E, R> =>
  Effect.succeed(errorDocument(errors, options))
