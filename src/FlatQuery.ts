/**
 * The **flat** list-input grammar: the bounded page cursor, the `?sort=`
 * string, the `filter[ids]` list, the slug attribute and the list-input
 * factory that merges them — the pure-schema half of a contract whose list
 * inputs are one flat struct (`{ limit, offset, status, sort }`) consumed
 * directly by the application's operations, rather than composed through
 * `Query.schema`'s nested families.
 *
 * `Query.flatList` puts such a struct on the wire (`page[…]` / `filter[…]`
 * bracketed, the open `?include=` added); this module is where the struct's
 * own fields come from. Every bound is enforced *in the schema*, so an
 * over-wide page, a fourth sort key or an over-long id list is a decode-time
 * 400 before any operation runs, never something an operation has to defend
 * against.
 *
 * Nothing here depends on the HTTP surface, so the module is reachable from
 * the schema-only entry point (`@thomasfosterau/effect-jsonapi/schema`) — a
 * client-safe models package can declare its list inputs with it.
 *
 * @since 0.16.0
 */
// The pure-schema pieces (the page window, UUID and id-list codecs, slugs, the
// tri-state reader) come from `@thomasfosterau/effect-ext`'s Schema subpaths
// (#552), which resolve `effect` alone. This module keeps their public names,
// plain-value option objects and declared `Schema.*` types, so no
// effect-ext type reaches the published declarations.
import * as MutableHashSet from "effect/MutableHashSet";
import * as Bounded from "@thomasfosterau/effect-ext/Bounded";
import * as Ids from "@thomasfosterau/effect-ext/Ids";
import * as TriState from "@thomasfosterau/effect-ext/TriState";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Resource from "./Resource.js";

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * A bounded pagination `offset`: a non-negative integer.
 *
 * @since 0.16.0
 * @category schemas
 */
export const PageOffset: Schema.Finite = Bounded.PageOffset;

/**
 * The decoded type of a {@link PageOffset}: a non-negative integer.
 *
 * @since 0.18.0
 * @category models
 */
export type PageOffset = typeof PageOffset.Type;

/**
 * A bounded pagination `limit`: a positive integer no greater than
 * `maxLimit`. One cap, enforced uniformly across every list input built from
 * it, so a hostile request can't drive an unbounded `LIMIT`.
 *
 * @since 0.16.0
 * @category schemas
 */
export const pageLimit = (maxLimit: number): Schema.Finite => Bounded.pageLimit(maxLimit);

/**
 * Options of {@link pagination}.
 *
 * @since 0.16.0
 * @category models
 */
export interface PaginationOptions {
  /** The most rows one page may ask for. */
  readonly maxLimit: number;
  /**
   * The page size decoded when the caller names none. Defaults to `50`.
   * Pass `false` to make both keys **required** instead (no defaults) —
   * for a contract whose every list request must spell its window.
   */
  readonly defaultLimit?: number | false;
}

/**
 * The page-cursor fields with decoding defaults: the shape every list
 * operation consumes, `limit` and `offset` concrete whether or not the caller
 * sent them.
 *
 * @since 0.16.0
 * @category models
 */
export type DefaultedPagination = {
  readonly offset: Schema.withDecodingDefaultKey<Schema.Finite>;
  readonly limit: Schema.withDecodingDefaultKey<Schema.Finite>;
};

/**
 * The page-cursor fields with no defaults: both keys required.
 *
 * @since 0.16.0
 * @category models
 */
export type RequiredPagination = {
  readonly offset: Schema.Finite;
  readonly limit: Schema.Finite;
};

/**
 * The `{ offset, limit }` fields of a flat list input, bounded by
 * `maxLimit`. With a `defaultLimit` (the default, `50`) both keys are
 * optional on input and concrete once decoded (`offset` defaults to `0`);
 * with `defaultLimit: false` both are required.
 *
 * Numbers on both sides: the flat struct is the call-site / operation
 * contract, and `Query.flatList` puts it on the wire, where
 * `HttpApiEndpoint` coerces the bracket leaves to and from their string form.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { FlatQuery } from "@thomasfosterau/effect-jsonapi"
 *
 * const ListArticles = Schema.Struct({
 *   ...FlatQuery.pagination({ maxLimit: 100 }),
 *   status: Schema.optionalKey(Schema.String)
 * })
 * console.log(Schema.decodeUnknownSync(ListArticles)({}))
 * // → { offset: 0, limit: 50 }
 * console.log(Schema.decodeUnknownSync(ListArticles)({ limit: 5, offset: 10, status: "open" }))
 * // → { offset: 10, limit: 5, status: "open" }
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export function pagination(
  options: PaginationOptions & { readonly defaultLimit: false },
): RequiredPagination;
export function pagination(options: PaginationOptions): DefaultedPagination;
export function pagination(options: PaginationOptions): RequiredPagination | DefaultedPagination {
  const { maxLimit, defaultLimit } = options;
  if (defaultLimit === false) return Bounded.requiredPagination({ maxLimit });
  return Bounded.pagination({ maxLimit, defaultLimit: Option.fromUndefinedOr(defaultLimit) });
}
// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

/**
 * The most sort keys one request may carry. Past "primary axis, secondary
 * axis, explicit tiebreak" an ordering is essentially never what a caller
 * wanted, and every extra key is another `ORDER BY` term the database sorts
 * the candidate set on.
 *
 * @since 0.16.0
 * @category constants
 */
export const MAX_SORT_FIELDS = 3;

/**
 * Which way one sort key orders.
 *
 * @since 0.16.0
 * @category models
 */
export type SortDirection = "asc" | "desc";

/**
 * One decoded sort key: the public field name plus its direction.
 *
 * @since 0.16.0
 * @category models
 */
export interface SortField {
  readonly field: string;
  readonly direction: SortDirection;
}

/**
 * A single sort key's name: a JSON:API member name as camelCase attribute
 * keys spell them. Deliberately narrow, so the per-resource allow-list
 * downstream only ever sees plausible field names.
 */
const FIELD = "[A-Za-z][A-Za-z0-9]*";

/**
 * The whole `sort` value: one to {@link MAX_SORT_FIELDS} `-`-prefixable field
 * names, comma-separated, no surrounding whitespace. An empty value, a
 * trailing comma, a fourth key or a dotted name all fail the check.
 */
const SORT_PATTERN = new RegExp(`^-?${FIELD}(?:,-?${FIELD}){0,${MAX_SORT_FIELDS - 1}}$`);

const SortFields = Schema.Array(
  Schema.Struct({
    field: Schema.String,
    direction: Schema.Literals(["asc", "desc"]),
  }),
);

/**
 * Parses a grammar-valid `sort` string into its ordered keys, dropping a
 * repeat of a field already seen: `?sort=title,-title` is not ambiguous to a
 * database (rows tied on `title` are tied on `-title` too), so the first
 * occurrence wins rather than the request failing.
 */
const parseSortFields = (value: string): ReadonlyArray<SortField> => {
  const seen = MutableHashSet.empty<string>();
  const fields: Array<SortField> = [];
  Arr.forEach(value.split(","), (key) => {
    const descending = key.startsWith("-");
    const field = descending ? key.slice(1) : key;
    if (MutableHashSet.has(seen, field)) return;
    MutableHashSet.add(seen, field);
    fields.push({ field, direction: descending ? "desc" : "asc" });
  });
  return fields;
};

const formatSortFields = (fields: ReadonlyArray<SortField>): string =>
  fields.map(({ field, direction }) => (direction === "desc" ? `-${field}` : field)).join(",");

/**
 * The `?sort=` query input: a JSON:API sort string on the wire, the ordered
 * {@link SortField} list once decoded.
 *
 * The schema bounds the *grammar* — field-name syntax and at most
 * {@link MAX_SORT_FIELDS} keys — and deliberately does not know which fields
 * a resource may be sorted by: that allow-list lives with the columns it maps
 * onto (`ApiError.UnsupportedSortField` is the rejection). Accepts
 * `string | string[]` on the wire (a repeated key joins with the comma the
 * grammar already uses) and always encodes the single comma-joined string.
 *
 * Where the sortable set *is* known at schema-build time, `Query.Sort`
 * rejects an unknown field at decode instead.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { FlatQuery } from "@thomasfosterau/effect-jsonapi"
 *
 * console.log(Schema.decodeUnknownSync(FlatQuery.SortParam)("-createdAt,title"))
 * // → [ { field: "createdAt", direction: "desc" }, { field: "title", direction: "asc" } ]
 * console.log(Schema.decodeUnknownSync(FlatQuery.SortParam)(["-createdAt", "title"]))
 * // → [ { field: "createdAt", direction: "desc" }, { field: "title", direction: "asc" } ]
 * ```
 *
 * @since 0.16.0
 * @category schemas
 */
export const SortParam: Schema.Codec<
  ReadonlyArray<SortField>,
  string | ReadonlyArray<string>
> = Schema.Union([Schema.String, Schema.Array(Schema.String)]).pipe(
  Schema.decodeTo(
    Schema.String.check(Schema.isPattern(SORT_PATTERN)),
    SchemaTransformation.transform<string, string | ReadonlyArray<string>>({
      decode: (value) => (P.isString(value) ? value : value.join(",")),
      encode: (value) => value,
    }),
  ),
  Schema.decodeTo(
    SortFields,
    SchemaTransformation.transform<ReadonlyArray<SortField>, string>({
      decode: parseSortFields,
      encode: formatSortFields,
    }),
  ),
);

/**
 * The decoded {@link SortParam}.
 *
 * @since 0.16.0
 * @category models
 */
export type SortParam = typeof SortParam.Type;

/**
 * The `sort` field a flat list input spreads in, spelled once so every list
 * input shares one definition: `{ sort: Schema.optional(FlatQuery.SortParam) }`.
 *
 * @since 0.16.0
 * @category models
 */
export const sortField = {
  sort: Schema.optional(SortParam),
} as const;

// ---------------------------------------------------------------------------
// Id lists
// ---------------------------------------------------------------------------

/**
 * A UUID string.
 *
 * @since 0.16.0
 * @category schemas
 */
export const Uuid: Schema.String = Ids.Uuid;

/**
 * The decoded type of a {@link Uuid}: a UUID string.
 *
 * @since 0.18.0
 * @category models
 */
export type Uuid = typeof Uuid.Type;

/**
 * The most ids one `filter[ids]` may carry by default.
 *
 * @since 0.16.0
 * @category constants
 */
export const DEFAULT_MAX_ID_LIST: 100 = Bounded.DEFAULT_MAX_ID_LIST;

/**
 * A comma-separated list of UUIDs as a `filter[ids]` value carries on the
 * wire (`?filter[ids]=<uuid>,<uuid>`), decoded to a non-empty array of at
 * most `maxLength` — the shape a family resolving a bounded, caller-known
 * id set (a byline, a gallery) uses to load them in one round trip. Accepts
 * the repeated-key spelling too.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { FlatQuery } from "@thomasfosterau/effect-jsonapi"
 *
 * const ids = FlatQuery.idList({ maxLength: 2 })
 * console.log(
 *   Schema.decodeUnknownSync(ids)(
 *     "5f0c3f9a-8a18-4f6e-9b2e-7a8a1b2c3d4e,7d1e4c2b-3a5f-4b8c-9d0e-1f2a3b4c5d6e"
 *   ).length
 * )
 * // → 2
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const idList = (options?: {
  readonly maxLength?: number;
}): Schema.Codec<ReadonlyArray<string>, string | ReadonlyArray<string>> =>
  Bounded.idList({ maxLength: Option.fromUndefinedOr(options?.maxLength) });

/**
 * {@link idList} at its default bound.
 *
 * @since 0.16.0
 * @category schemas
 */
export const IdList: Schema.Codec<
  ReadonlyArray<string>,
  string | ReadonlyArray<string>
> = Bounded.IdList;

/**
 * The `ids` field a list input spreads in to accept `?filter[ids]=`:
 * `{ ids: Schema.optional(FlatQuery.IdList) }`. Name it in
 * `Query.flatList`'s `filters` to bracket it on the wire.
 *
 * @since 0.16.0
 * @category models
 */
export const idListField = {
  ids: Schema.optional(IdList),
} as const;

// ---------------------------------------------------------------------------
// List inputs
// ---------------------------------------------------------------------------

/**
 * `A & B` with `B`'s keys winning, as one object type.
 *
 * @since 0.16.0
 * @category type-level
 */
export type MergedFields<A, B> = {
  readonly [K in keyof A | keyof B]: K extends keyof B ? B[K] : K extends keyof A ? A[K] : never;
};

/**
 * The fields {@link listInput} always carries: the page cursor plus the
 * optional `sort` keys.
 *
 * @since 0.16.0
 * @category models
 */
export type ListInputBaseFields = DefaultedPagination & typeof sortField;

/**
 * A flat list input: the defaulted page cursor ({@link pagination}), the
 * optional `sort` keys ({@link sortField}), and whatever entity-specific
 * filter fields the family adds. The one shape every `List<X>` struct shares,
 * so each family only spells out its own fields.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { FlatQuery } from "@thomasfosterau/effect-jsonapi"
 *
 * const ListArticles = FlatQuery.listInput({ maxLimit: 100 }, {
 *   status: Schema.optionalKey(Schema.String)
 * })
 * console.log(Schema.decodeUnknownSync(ListArticles)({ sort: "-title", status: "open" }))
 * // → { offset: 0, limit: 50, sort: [ { field: "title", direction: "desc" } ], status: "open" }
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const listInput = <const Fields extends Schema.Struct.Fields = Record<never, never>>(
  options: PaginationOptions,
  extraFields?: Fields,
): Schema.Struct<MergedFields<ListInputBaseFields, Fields>> =>
  Schema.Struct({
    ...pagination(options),
    ...sortField,
    ...extraFields,
  } as MergedFields<ListInputBaseFields, Fields>);

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/**
 * Lowercase kebab-case: letters, digits, single hyphens between segments.
 * Exported so a route matcher can match the same shape without a second,
 * driftable copy of the regex.
 *
 * @since 0.16.0
 * @category constants
 */
export const SLUG_PATTERN: RegExp = Ids.SLUG_PATTERN;

/**
 * Options of {@link slug}.
 *
 * @since 0.16.0
 * @category models
 */
export interface SlugOptions {
  /** The longest slug accepted. Defaults to `200`. */
  readonly maxLength?: number;
  /**
   * Path segments a slug may never equal — the static sibling routes
   * (`create`, `edit`, `search`) a slug would otherwise shadow and make
   * unreachable.
   */
  readonly reserved?: ReadonlyArray<string>;
}

/**
 * A human-readable slug: 1 to `maxLength` characters of {@link SLUG_PATTERN},
 * not a reserved path segment. Uniqueness is the database's concern, not the
 * schema's.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { FlatQuery } from "@thomasfosterau/effect-jsonapi"
 *
 * const Slug = FlatQuery.slug({ reserved: ["create", "edit"] })
 * console.log(Schema.decodeUnknownSync(Slug)("my-post-title"))
 * // → my-post-title
 * console.log(Schema.is(Slug)("edit"), Schema.is(Slug)("Not A Slug"))
 * // → false false
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const slug = (options?: SlugOptions): Schema.String =>
  Ids.slug({
    maxLength: Option.fromUndefinedOr(options?.maxLength),
    reserved: Option.fromUndefinedOr(options?.reserved),
  });

/**
 * {@link slug} with no reserved segments.
 *
 * @since 0.16.0
 * @category schemas
 */
export const Slug: Schema.String = Ids.Slug;

/**
 * The `slug` attribute as a `Resource.attribute` descriptor: an optional
 * resource key (omitted entirely when absent — a resource with no slug never
 * emits `slug: null`) whose value, when present, is nullable at create and
 * clearable at update (a `null` update clears it). Spread into a
 * `Resource.make` attributes map to opt a resource in.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { FlatQuery, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Post = Resource.make("posts", {
 *   attributes: {
 *     title: Schema.NonEmptyString,
 *     ...FlatQuery.slugResourceFields(FlatQuery.Slug)
 *   }
 * })
 * console.log(Resource.attributeKeys(Post))
 * // → [ "title", "slug" ]
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const slugResourceFields = <S extends Schema.String>(schema: S) =>
  ({
    slug: Resource.attribute(Schema.NullOr(schema), {
      resource: "optional",
      create: "optional",
      clearable: true,
    }),
  }) as const;

/**
 * The `slug` field as a **create-input** shape (`Schema.optional`,
 * non-null), for a hand-written `Create` struct whose form adapters pass
 * `value | undefined`.
 *
 * @since 0.16.0
 * @category constructors
 */
export const slugCreateFields = <S extends Schema.String>(schema: S) =>
  ({ slug: Schema.optional(schema) }) as const;

// ---------------------------------------------------------------------------
// Tri-state updates
// ---------------------------------------------------------------------------

/**
 * The value an update actually **supplies** for a clearable, tri-state field
 * (`Schema.optionalKey(Schema.OptionFromNullOr(X))` — key absent: carry the
 * stored value forward; `Option.none()`: clear; `Option.some(v)`: set),
 * collapsing the two states that supply no value.
 *
 * Use it only where those two genuinely behave alike — a side effect that
 * runs only when a value is *set*, such as re-checking a slug's uniqueness.
 * Never on a write path, where "carry forward" and "clear" must produce
 * different column values.
 *
 * @example
 * ```ts
 * import { Option } from "effect"
 * import { FlatQuery } from "@thomasfosterau/effect-jsonapi"
 *
 * console.log(FlatQuery.suppliedValue(undefined), FlatQuery.suppliedValue(Option.some("x")))
 * // → { _id: "Option", _tag: "None" } { _id: "Option", _tag: "Some", value: "x" }
 * ```
 *
 * @since 0.16.0
 * @category utils
 */
export const suppliedValue: <A>(field?: Option.Option<A>) => Option.Option<A> =
  TriState.suppliedValue;
