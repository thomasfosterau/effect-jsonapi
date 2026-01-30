/**
 * Serialization utilities for converting data to JSON:API resource objects
 */

import * as Effect from "effect/Effect"
import type * as Schema from "./Schema"

/**
 * Configuration for serializing a resource
 */
export interface SerializerConfig<T> {
  readonly type: string
  readonly getId: (data: T) => string
  readonly getAttributes?: (data: T) => Record<string, unknown>
  readonly getRelationships?: (data: T) => Record<string, Schema.Relationship>
  readonly getLinks?: (data: T) => Schema.Links
  readonly getMeta?: (data: T) => Record<string, unknown>
}

/**
 * Serialize data to a JSON:API resource object
 */
export const serialize = <T>(
  config: SerializerConfig<T>,
  data: T
): Schema.ResourceObject => ({
  type: config.type,
  id: config.getId(data),
  attributes: config.getAttributes?.(data),
  relationships: config.getRelationships?.(data),
  links: config.getLinks?.(data),
  meta: config.getMeta?.(data)
})

/**
 * Serialize multiple items to JSON:API resource objects
 */
export const serializeMany = <T>(
  config: SerializerConfig<T>,
  data: T[]
): Schema.ResourceObject[] =>
  data.map(item => serialize(config, item))

/**
 * Effect-based serialization
 */
export const serializeEffect = <T, E = never, R = never>(
  config: SerializerConfig<T>,
  data: T
): Effect.Effect<Schema.ResourceObject, E, R> =>
  Effect.succeed(serialize(config, data))

/**
 * Effect-based serialization for multiple items
 */
export const serializeManyEffect = <T, E = never, R = never>(
  config: SerializerConfig<T>,
  data: T[]
): Effect.Effect<Schema.ResourceObject[], E, R> =>
  Effect.succeed(serializeMany(config, data))

/**
 * Create a serializer function from a config
 */
export const createSerializer = <T>(config: SerializerConfig<T>) => ({
  serialize: (data: T) => serialize(config, data),
  serializeMany: (data: T[]) => serializeMany(config, data),
  serializeEffect: (data: T) => serializeEffect(config, data),
  serializeManyEffect: (data: T[]) => serializeManyEffect(config, data)
})

/**
 * Helper to create a simple serializer for entities with id property
 */
export const createSimpleSerializer = <T extends { id: string }>(
  type: string,
  getAttributes?: (data: T) => Record<string, unknown>
): ReturnType<typeof createSerializer<T>> =>
  createSerializer({
    type,
    getId: (data) => data.id,
    getAttributes
  })
