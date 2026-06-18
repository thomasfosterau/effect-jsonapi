/**
 * String codecs for JSON:API query parameter values.
 *
 * @internal
 */
import { Schema, SchemaTransformation } from "effect"

/**
 * A comma-separated list codec: `"a,b,c"` ↔ `["a", "b", "c"]`.
 *
 * Item validation (e.g. closed literal sets) is performed by the item schema
 * after splitting.
 */
export interface CommaSeparated<S extends Schema.Top> extends Schema.decodeTo<
  Schema.$Array<S>,
  Schema.String,
  never,
  never
> {}

export const CommaSeparated = <S extends Schema.Top>(item: S): CommaSeparated<S> =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.Array(item),
      SchemaTransformation.transform<ReadonlyArray<S["Encoded"]>, string>({
        decode: (value) => (value === "" ? [] : value.split(",")) as ReadonlyArray<S["Encoded"]>,
        encode: (items) => items.map(String).join(",")
      })
    )
  )

/**
 * A sort term: an attribute name and a direction.
 */
export interface SortTerm<Field extends string> {
  readonly field: Field
  readonly direction: "asc" | "desc"
}

/**
 * The schema of a decoded sort list.
 */
export interface Sort<Field extends string> extends Schema.decodeTo<
  Schema.$Array<
    Schema.Struct<{
      readonly field: Schema.Literals<ReadonlyArray<Field>>
      readonly direction: Schema.Literals<["asc", "desc"]>
    }>
  >,
  Schema.String,
  never,
  never
> {}

/**
 * JSON:API `sort` codec: `"-createdAt,title"` ↔
 * `[{ field: "createdAt", direction: "desc" }, { field: "title", direction: "asc" }]`.
 *
 * Per https://jsonapi.org/format/1.1/#fetching-sorting, a `-` prefix requests
 * descending order.
 */
export const Sort = <const Field extends string>(fields: ReadonlyArray<Field>): Sort<Field> => {
  const item = Schema.Struct({
    field: Schema.Literals(fields as ReadonlyArray<Field>),
    direction: Schema.Literals(["asc", "desc"] as ["asc", "desc"])
  })
  type Encoded = ReadonlyArray<typeof item.Encoded>
  return Schema.String.pipe(
    Schema.decodeTo(
      Schema.Array(item),
      SchemaTransformation.transform<Encoded, string>({
        decode: (value) =>
          (value === "" ? [] : value.split(",")).map((term) =>
            term.startsWith("-")
              ? { field: term.slice(1), direction: "desc" as const }
              : { field: term, direction: "asc" as const }
          ) as unknown as Encoded,
        encode: (terms) => terms.map((term) => (term.direction === "desc" ? `-${term.field}` : term.field)).join(",")
      })
    )
  )
}

/**
 * Reshapes a flat record with bracket keys into nested groups:
 * `{ "page[offset]": "10", include: "a" }` → `{ page: { offset: "10" }, include: "a" }`.
 */
export const nest = (flat: { readonly [key: string]: unknown }): Record<string, unknown> => {
  const nested: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(flat)) {
    if (value === undefined) continue
    const match = /^([^[\]]+)\[([^[\]]+)\]$/.exec(key)
    if (match === null) {
      nested[key] = value
    } else {
      const group = (nested[match[1]!] ??= {}) as Record<string, unknown>
      group[match[2]!] = value
    }
  }
  return nested
}

/**
 * Inverse of {@link nest}: flattens nested groups back to bracket keys.
 */
export const flatten = (nested: { readonly [key: string]: unknown }): Record<string, unknown> => {
  const flat: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(nested)) {
    if (value === undefined) continue
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [sub, subValue] of Object.entries(value)) {
        if (subValue === undefined) continue
        flat[`${key}[${sub}]`] = subValue
      }
    } else {
      flat[key] = value
    }
  }
  return flat
}
