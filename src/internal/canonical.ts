/**
 * The canonical query string: one key order and one percent-encoding for
 * every query family, so a decoded query has exactly one wire spelling
 * (`Query.canonical`, the pagination link builders, and Legation's
 * subscription / cache identities all go through here).
 *
 * @internal
 */
import { SchemaAST } from "effect"
import { compareCodePoints, isFilterKey, keySegments } from "./filter.js"

/** One flat `(key, value)` query pair, both sides un-encoded. */
export type Pair = readonly [key: string, value: string]

/**
 * The canonical order of the families: `include`, `fields[*]`, `filter[*]`,
 * `sort`, `page[*]`, then anything else. The ranks are spaced so a caller
 * can slot a family's pairs into an already-ordered list.
 */
export const rank = (key: string): number =>
  key === "include"
    ? 0
    : key.startsWith("fields[")
      ? 1
      : isFilterKey(key)
        ? 2
        : key === "sort"
          ? 3
          : key.startsWith("page[")
            ? 4
            : 5

const byKey = (a: Pair, b: Pair): number => compareCodePoints(a[0], b[0])

// Whether a `filter[...]` key is in the grammar's group form (three bracket
// segments): `filter[g0][group][conjunction]`, `filter[c0][condition][path]`.
const isGroupFormKey = (key: string): boolean => (keySegments(key)?.length ?? 0) >= 3

/**
 * The wire keys a schema declares, in declaration order — the property
 * signatures of its encoded (flat) shape — or none when the encoded side is
 * not an object literal.
 */
export const declaredKeys = (ast: SchemaAST.AST): ReadonlyArray<string> => {
  const encoded = SchemaAST.toEncoded(ast)
  return encoded._tag === "Objects" ? encoded.propertySignatures.map((signature) => String(signature.name)) : []
}

// The pairs of one encoded key: a scalar is one pair; an array is one pair
// per item — the repeated-key spelling `UrlParams.toRecord` decodes back to
// an array — except `include`, whose comma form is the schema's own encoding
// of the set (the query schema already joins it; a consumer's flat schema
// may not have). `undefined` and `null` have no wire form and are omitted.
const pairsOf = (key: string, value: unknown): ReadonlyArray<Pair> => {
  if (value === undefined || value === null) return []
  if (typeof value === "string") return [[key, value]]
  if (Array.isArray(value)) {
    return key === "include" ? [[key, value.map(String).join(",")]] : value.map((item) => [key, String(item)])
  }
  return [[key, String(value)]]
}

/**
 * Orders the pairs of an encoded flat query canonically:
 *
 * 1. `include`
 * 2. `fields[*]`, sorted by key (code-point order)
 * 3. `filter[*]`, in the grammar's canonical order: shorthand keys sorted by
 *    key (code-point order — the order the filter encoder already emits,
 *    which also settles the per-key escape hatch), the group form in the
 *    encoder's pre-order (ids are meaningful, so it is never re-sorted)
 * 4. `sort`
 * 5. `page[*]`, in the order the page strategy declares its keys (`offset,
 *    limit` / `number, size` / `cursor, size` — the order the pagination
 *    link builders emit), keys the schema does not declare after them, sorted
 * 6. everything else (a consumer's own flat keys), sorted by key
 *
 * `undefined` and `null` values are omitted; an empty string is kept
 * (`key=`); an array is the repeated key, one pair per item in order
 * (`include` excepted: the comma form). Sorting is stable, so a repeated
 * key's items keep their order.
 */
export const orderPairs = (
  flat: { readonly [key: string]: unknown },
  declared: ReadonlyArray<string> = []
): ReadonlyArray<Pair> => {
  const families: Array<Array<Pair>> = [[], [], [], [], [], []]
  for (const [key, value] of Object.entries(flat)) {
    families[rank(key)]!.push(...pairsOf(key, value))
  }
  const [include, fields, filter, sort, page, other] = families as [
    Array<Pair>,
    Array<Pair>,
    Array<Pair>,
    Array<Pair>,
    Array<Pair>,
    Array<Pair>
  ]
  fields.sort(byKey)
  if (!filter.some(([key]) => isGroupFormKey(key))) filter.sort(byKey)
  const position = (key: string): number => {
    const index = declared.indexOf(key)
    return index === -1 ? Number.POSITIVE_INFINITY : index
  }
  page.sort((a, b) => position(a[0]) - position(b[0]) || byKey(a, b))
  other.sort(byKey)
  return [...include, ...fields, ...filter, ...sort, ...page, ...other]
}

// RFC 3986 percent-encoding (`encodeURIComponent`: spaces are `%20`, never
// `+`; commas `%2C`), with the family brackets left readable in keys.
const encodeKey = (key: string): string => encodeURIComponent(key).replace(/%5B/g, "[").replace(/%5D/g, "]")

/**
 * Serialises ordered pairs to a query string (no leading `?`): each key and
 * value percent-encoded, `[` / `]` left unescaped in keys, pairs joined with
 * `&`.
 */
export const serialise = (pairs: Iterable<Pair>): string =>
  Array.from(pairs, ([key, value]) => `${encodeKey(key)}=${encodeURIComponent(value)}`).join("&")

/**
 * Slots a page cursor's pairs into an already canonically ordered pair list:
 * any `page[*]` pairs the list carries are replaced, and the cursor takes the
 * `page` family's position (after `sort`, before a consumer's own keys).
 */
export const withPagePairs = (query: ReadonlyArray<Pair>, page: ReadonlyArray<Pair>): ReadonlyArray<Pair> => {
  const before: Array<Pair> = []
  const after: Array<Pair> = []
  for (const pair of query) {
    const r = rank(pair[0])
    if (r < 4) before.push(pair)
    else if (r > 4) after.push(pair)
  }
  return [...before, ...page, ...after]
}
