/**
 * String codecs for JSON:API query parameter values.
 *
 * @internal
 */
import { Option, Record as Rec, Schema, SchemaTransformation } from "effect";
import { define } from "./define.js";
import { vocabularyAnnotations } from "./vocabulary.js";

/**
 * A comma-separated list codec: `"a,b,c"` ↔ `["a", "b", "c"]`.
 *
 * Item validation (e.g. closed literal sets) is performed by the item schema
 * after splitting.
 *
 * An empty segment — the whole string (`""`), a double comma (`"a,,b"`), or a
 * leading/trailing comma (`",a"` / `"a,"`) — is dropped rather than handed to
 * the item schema as an item: `"a,,b"` and `"a,b,"` both decode as `["a",
 * "b"]`. The comma grammar has no way to spell an intentional empty item, so
 * a gap reads as a client's stray separator, not as a member of the set; the
 * alternative (handing the item schema `""`) would just fail with "not a
 * valid item name" for what is really a formatting slip.
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
        decode: (value) =>
          value.split(",").filter((segment) => segment !== "") as ReadonlyArray<S["Encoded"]>,
        encode: (items) => items.map(String).join(","),
      }),
    ),
  );

/**
 * The wire form of a repeatable comma-separated parameter.
 *
 * JSON:API's comma grammar (`?include=a,b`) and the repeated-key spelling
 * (`?include=a&include=b`) denote the same set, and `UrlParams.toRecord`
 * decodes a repeated key to an **array** rather than a string. Accept both:
 * an array is joined back to the canonical comma form, which the item codec
 * then splits exactly as before. Encoding always emits the single comma form,
 * so nothing a client is handed changes shape.
 */
export interface Repeatable extends Schema.decodeTo<
  Schema.String,
  Schema.Union<readonly [Schema.String, Schema.$Array<Schema.String>]>,
  never,
  never
> {}

export const Repeatable: Repeatable = Schema.Union([
  Schema.String,
  Schema.Array(Schema.String),
]).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform<string, string | ReadonlyArray<string>>({
      decode: (value) => (Array.isArray(value) ? value.join(",") : (value as string)),
      encode: (value) => value,
    }),
  ),
) as Repeatable;

/**
 * Composes {@link Repeatable} under a comma-list item codec — the result of
 * {@link CommaSeparated} or {@link Sort} — so the composite accepts either
 * wire spelling of the same list (`"a,b"` or `["a", "b"]`) and always encodes
 * back to the single canonical comma form.
 *
 * `Repeatable` alone is applied at the *flat* wire struct in `Query.schema`
 * (paired there with a separate, plain `CommaSeparated` / `Sort` field on the
 * *nested* side — the flat/nested split already normalises the repeated-key
 * spelling to a comma string before the nested field ever sees it). The
 * standalone constructors (`Query.Include`, `Query.Fieldset`, `Query.Sort`)
 * have no such split — they are one schema, decoded directly from the wire
 * value — so they compose `Repeatable` under their item codec here instead.
 */
export const repeatable = <S extends Schema.Top>(
  item: S,
): Schema.decodeTo<S, Repeatable, never, never> =>
  Repeatable.pipe(Schema.decodeTo(item)) as Schema.decodeTo<S, Repeatable, never, never>;

/**
 * The schema of a decoded sort list.
 */
export interface Sort<Field extends string> extends Schema.decodeTo<
  Schema.$Array<
    Schema.Struct<{
      readonly field: Schema.Literals<ReadonlyArray<Field>>;
      readonly direction: Schema.Literals<["asc", "desc"]>;
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
    // The sortable set rides on the literal schema as the `sort` vocabulary,
    // so the 400 for an unknown field carries `meta.sortableFields` (see
    // `errorMeta`), and an empty set makes `sort` unsupported (#282). An
    // empty set's rejection says so rather than "Expected never".
    field: Schema.Literals(fields as ReadonlyArray<Field>).annotate(
      vocabularyAnnotations(
        { family: "sort", values: fields },
        "This endpoint supports no sortable fields.",
      ),
    ),
    direction: Schema.Literals(["asc", "desc"] as ["asc", "desc"]),
  });
  type Encoded = ReadonlyArray<typeof item.Encoded>;
  return Schema.String.pipe(
    Schema.decodeTo(
      Schema.Array(item),
      SchemaTransformation.transform<Encoded, string>({
        decode: (value) =>
          value
            .split(",")
            .filter((term) => term !== "")
            .map((term) =>
              term.startsWith("-")
                ? { field: term.slice(1), direction: "desc" as const }
                : { field: term, direction: "asc" as const },
            ) as unknown as Encoded,
        encode: (terms) =>
          terms
            .map((term) => (term.direction === "desc" ? `-${term.field}` : term.field))
            .join(","),
      }),
    ),
  );
};

const bracketKey = /^([^[\]]+)\[([^[\]]+)\]$/;

/**
 * Reshapes a flat record with bracket keys into nested groups:
 * `{ "page[offset]": "10", include: "a" }` → `{ page: { offset: "10" }, include: "a" }`.
 *
 * Only one level is reshaped: `a[b]` joins group `a`; any other key — bare,
 * deeper (`a[b][c]`), empty-bracketed (`a[]`) — is copied under its own
 * spelling. A bracket key whose group name a bare key already holds
 * (`?x=1&x[y]=2`, in either order) is likewise copied under its own spelling,
 * so the bare value is kept and nothing is overwritten or thrown; the nested
 * struct then drops whichever spelling it doesn't declare. Every key is
 * written as an own property, so `__proto__` is an ordinary name here.
 */
export const nest = <V>(flat: { readonly [key: string]: V }) => {
  const nested: Record<string, V | Record<string, V>> = {};
  // Whether a bare key holds `name`, wherever it sits in `flat`.
  const holdsBare = (name: string): boolean =>
    Option.getOrUndefined(Rec.get(flat, name)) !== undefined;
  for (const [key, value] of Rec.toEntries(flat)) {
    if (value === undefined) continue;
    const [, name, member] = bracketKey.exec(key) ?? [];
    if (name === undefined || member === undefined || holdsBare(name)) {
      define(nested, key, value);
    } else {
      // No bare key holds the name, so an own entry under it is a group this
      // loop made.
      const group = Option.getOrElse(Rec.get(nested, name), () => {
        const made = {};
        define(nested, name, made);
        return made;
      }) as Record<string, V>;
      define(group, member, value);
    }
  }
  return nested;
};

/**
 * Inverse of {@link nest}: flattens nested groups back to bracket keys.
 */
export const flatten = (nested: { readonly [key: string]: unknown }) => {
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(nested)) {
    if (value === undefined) continue;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [sub, subValue] of Object.entries(value)) {
        if (subValue === undefined) continue;
        define(flat, `${key}[${sub}]`, subValue);
      }
    } else {
      define(flat, key, value);
    }
  }
  return flat;
};
