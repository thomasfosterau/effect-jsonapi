/**
 * effect-jsonapi - A library for defining and implementing JSON:API compliant APIs in Effect
 * 
 * @packageDocumentation
 */

// Schema definitions
export * from "./Schema"

// Builder utilities
export * from "./Builder"

// Query parameter parsing
export * from "./QueryParams"

// HTTP integration
export * from "./Http"

// Serialization
export * from "./Serializer"

/**
 * Common constants
 */
export const JSONAPI_VERSION = "1.1" as const
export const JSONAPI_MEDIA_TYPE = "application/vnd.api+json" as const
