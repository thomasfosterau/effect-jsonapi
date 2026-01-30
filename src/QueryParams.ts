/**
 * Query parameter parsing for JSON:API
 * 
 * Handles: filter, sort, page, include, fields
 */

import * as Effect from "effect/Effect"

/**
 * Filter parameters
 * Example: filter[name]=John&filter[age]=30
 */
export interface FilterParams {
  readonly [key: string]: string | string[]
}

/**
 * Sort parameter
 * Example: sort=-created,name (descending by created, then ascending by name)
 */
export interface SortParam {
  readonly field: string
  readonly direction: "asc" | "desc"
}

/**
 * Page parameters
 * Example: page[number]=1&page[size]=10
 */
export interface PageParams {
  readonly [key: string]: string
}

/**
 * Include parameter - list of relationships to include
 * Example: include=author,comments
 */
export type IncludeParams = string[]

/**
 * Sparse fieldsets - which fields to include for each resource type
 * Example: fields[articles]=title,body&fields[people]=name
 */
export interface FieldsParams {
  readonly [resourceType: string]: string[]
}

/**
 * Parsed query parameters
 */
export interface QueryParams {
  readonly filter?: FilterParams
  readonly sort?: SortParam[]
  readonly page?: PageParams
  readonly include?: IncludeParams
  readonly fields?: FieldsParams
}

/**
 * Parse filter parameters from URL search params
 */
export const parseFilter = (searchParams: URLSearchParams): FilterParams => {
  const filter: Record<string, string | string[]> = {}
  
  for (const [key, value] of searchParams.entries()) {
    const match = key.match(/^filter\[(.+)\]$/)
    if (match) {
      const filterKey = match[1]
      if (filter[filterKey]) {
        if (Array.isArray(filter[filterKey])) {
          (filter[filterKey] as string[]).push(value)
        } else {
          filter[filterKey] = [filter[filterKey] as string, value]
        }
      } else {
        filter[filterKey] = value
      }
    }
  }
  
  return filter
}

/**
 * Parse sort parameter
 * Example: "-created,name" -> [{field: "created", direction: "desc"}, {field: "name", direction: "asc"}]
 */
export const parseSort = (sortParam: string | null): SortParam[] => {
  if (!sortParam) return []
  
  return sortParam.split(",").map(field => {
    const trimmed = field.trim()
    if (trimmed.startsWith("-")) {
      return { field: trimmed.slice(1), direction: "desc" as const }
    }
    return { field: trimmed, direction: "asc" as const }
  })
}

/**
 * Parse page parameters from URL search params
 */
export const parsePage = (searchParams: URLSearchParams): PageParams => {
  const page: Record<string, string> = {}
  
  for (const [key, value] of searchParams.entries()) {
    const match = key.match(/^page\[(.+)\]$/)
    if (match) {
      page[match[1]] = value
    }
  }
  
  return page
}

/**
 * Parse include parameter
 * Example: "author,comments.author" -> ["author", "comments.author"]
 */
export const parseInclude = (includeParam: string | null): IncludeParams => {
  if (!includeParam) return []
  
  return includeParam.split(",").map(s => s.trim()).filter(s => s.length > 0)
}

/**
 * Parse fields parameters from URL search params
 * Example: fields[articles]=title,body -> { articles: ["title", "body"] }
 */
export const parseFields = (searchParams: URLSearchParams): FieldsParams => {
  const fields: Record<string, string[]> = {}
  
  for (const [key, value] of searchParams.entries()) {
    const match = key.match(/^fields\[(.+)\]$/)
    if (match) {
      const resourceType = match[1]
      fields[resourceType] = value.split(",").map(s => s.trim()).filter(s => s.length > 0)
    }
  }
  
  return fields
}

/**
 * Parse all query parameters from a URL
 */
export const parseQueryParams = (url: string | URL): QueryParams => {
  const urlObj = typeof url === "string" ? new URL(url, "http://localhost") : url
  const searchParams = urlObj.searchParams
  
  return {
    filter: parseFilter(searchParams),
    sort: parseSort(searchParams.get("sort")),
    page: parsePage(searchParams),
    include: parseInclude(searchParams.get("include")),
    fields: parseFields(searchParams)
  }
}

/**
 * Effect-based query parameter parser
 */
export const parseQueryParamsEffect = (
  url: string | URL
): Effect.Effect<QueryParams, never, never> =>
  Effect.succeed(parseQueryParams(url))
