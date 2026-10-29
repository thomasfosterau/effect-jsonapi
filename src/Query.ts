/**
 * Typed JSON:API query parameters.
 *
 * Models the spec's query parameter families as typed schemas derived from a
 * resource definition:
 *
 *   - `include`   — compound document inclusion paths (`?include=author,comments.author`)
 *   - `fields`    — sparse fieldsets (`?fields[articles]=title,body`)
 *   - `sort`      — sort fields (`?sort=-createdAt,title`)
 *   - `page`      — pagination (`?page[offset]=0&page[limit]=10`)
 *   - `filter`    — filtering (`?filter[status]=open&filter[age][gt]=18`, the
 *                   filter grammar over the resource's declaration, or a
 *                   user-defined per-key map)
 *
 * On the wire these are flat, bracket-keyed string parameters; handlers see an
 * ergonomic nested, fully-decoded shape:
 *
 * ```ts skip-type-checking
 * {
 *   include?: ReadonlyArray<"author" | "comments" | "comments.author">   // from the relationship graph
 *   fields?:  { articles?: ReadonlyArray<"title" | "body" | "author" | "comments">, ... }
 *   sort?:    ReadonlyArray<{ field: "title" | ..., direction: "asc" | "desc" }>
 *   page?:    { offset?: number, limit?: number }
 *   filter?:  Filter.Ast<{ status: string, age: number }>                 // `filter: true`
 * }
 * ```
 *
 * Illegal values (unknown include paths, unknown sparse-fieldset names,
 * unknown sort fields, unknown filter fields or operators, bad filter
 * literals) fail decoding, which HttpApi surfaces as a 400 — the
 * spec-compliant response.
 *
 * Every comma-separated family — `include`, `fields[TYPE]`, `sort` — accepts
 * both spellings of the same set: the spec's comma grammar (`?include=a,b`)
 * and the repeated key (`?include=a&include=b`) that `UrlParams.toRecord`
 * decodes to an array, in any mix. Both decode identically; encoding always
 * emits the comma form. `filter[*]` accepts the repeated key too, at the
 * grammar's list-valued positions (`docs/filter-grammar.md` §2). An empty
 * segment from a stray comma (`?include=a,,b`, `?include=a,b,`) is dropped
 * rather than treated as an item: both decode as `["a", "b"]`.
 *
 * A decoded query has exactly one wire spelling, the **canonical query
 * string** ({@link canonical}): the families in a fixed order, each key
 * sorted or in its codec's canonical order, RFC 3986 percent-encoded. It is
 * what a collection document's `self` link carries and what a consumer can
 * use as the identity of a query.
 *
 * @since 0.1.0
 */
import type { SchemaAST, Types } from "effect";
import {
  Array as Arr,
  Effect,
  Predicate,
  Record as Rec,
  Result,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import * as ApiError from "./ApiError.js";
import type { Ast, Node } from "./Filter.js";
import { Ast as AstSchema, PROFILE_URI } from "./Filter.js";
import type { AnySurface, SurfaceFor } from "./Include.js";
import type { FlatQuery, Pair as CanonicalPair } from "./internal/canonical.js";
import { declaredKeys, orderPairs, serialise as serialisePairs } from "./internal/canonical.js";
import {
  CommaSeparated,
  flatten,
  nest,
  Repeatable,
  repeatable,
  Sort as SortCodec,
} from "./internal/codecs.js";
import type { FieldCodec, FieldCodecs } from "./internal/filter.js";
import {
  decodeFilter,
  encodeFilter,
  isFilterKey,
  literalEncoder,
  operatorCheck,
  prepare,
} from "./internal/filter.js";
import type {
  ExpandFamilies,
  IncludedResources,
  IncludeEnabled,
  LegalIncludePaths,
} from "./internal/includeGraph.js";
import { includePathsFor } from "./internal/includeGraph.js";
import type { IncludeArgument } from "./internal/sparse.js";
import { fieldsetResources } from "./internal/sparse.js";
import { vocabularyAnnotation, vocabularyAnnotations } from "./internal/vocabulary.js";
import type {
  Any,
  AttributeKeys,
  FieldKeys,
  Filterable,
  FilterableKeys,
  IncludeDepth,
  IncludePath,
  IncludePathsTo,
} from "./Resource.js";
import { attributeKeys, fieldKeys, filterable } from "./Resource.js";

// ---------------------------------------------------------------------------
// Pagination strategies
// ---------------------------------------------------------------------------

/**
 * Common pagination strategies, ready to pass as the `page` query option.
 * Each key becomes a `page[<key>]` query parameter.
 *
 * Custom strategies are plain `Schema.Struct.Fields` whose values decode from
 * strings.
 */
const PageInt = Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

/**
 * Options for the {@link Page.offset} pagination factory.
 *
 * Unlike the constant {@link Page.Offset}, the factory is bounded (a `maxLimit`
 * DoS guard), can fill in decode defaults, and can decode from plain numbers
 * (`fromString: false`) for hosts that coerce query strings at the transport
 * layer and reuse the schema as a numeric call-site input.
 *
 * @since 0.3.0
 * @category models
 */
export interface OffsetPageOptions {
  /** Upper bound on `limit` (inclusive) — a DoS guard. Omit for no cap. */
  readonly maxLimit?: number;
  /** Lower bound on `limit` (inclusive). Defaults to 1. */
  readonly minLimit?: number;
  /** Decode default for `limit` when the wire key is absent. Omit → field stays `optionalKey`. */
  readonly defaultLimit?: number;
  /** Decode default for `offset`. Omit → field stays `optionalKey`. */
  readonly defaultOffset?: number;
  /**
   * `true` (default): fields decode from query strings (`FiniteFromString`, as `Page.Offset`).
   * `false`: plain numbers (`Schema.Number`) — for hosts that coerce strings at the transport layer
   * and reuse the schema as a numeric input.
   */
  readonly fromString?: boolean;
}

/**
 * Options for the {@link Page.number} pagination factory — the page-number twin
 * of {@link OffsetPageOptions}, with bounds and defaults applied to the `size`
 * field and a decode default for the `number` field.
 *
 * @since 0.3.0
 * @category models
 */
export interface NumberPageOptions {
  /** Upper bound on `size` (inclusive) — a DoS guard. Omit for no cap. */
  readonly maxSize?: number;
  /** Lower bound on `size` (inclusive). Defaults to 1. */
  readonly minSize?: number;
  /** Decode default for `size` when the wire key is absent. Omit → field stays `optionalKey`. */
  readonly defaultSize?: number;
  /** Decode default for `number`. Omit → field stays `optionalKey`. */
  readonly defaultNumber?: number;
  /**
   * `true` (default): fields decode from query strings (`FiniteFromString`, as `Page.Number`).
   * `false`: plain numbers (`Schema.Number`) — for hosts that coerce strings at the transport layer.
   */
  readonly fromString?: boolean;
}

// The leaf schema a factory field is built from: a plain number when the caller
// opts out of string decoding, otherwise the wire-string `FiniteFromString`.
type PageLeaf<O extends { readonly fromString?: boolean }> = O extends {
  readonly fromString: false;
}
  ? typeof Schema.Number
  : typeof Schema.FiniteFromString;

// `true` when `O` carries a concrete (non-`undefined`) value for key `K`.
type HasDefaultKey<O, K extends PropertyKey> = K extends keyof O
  ? [O[K]] extends [undefined]
    ? false
    : true
  : false;

// A defaulted key decodes to a required value (`withDecodingDefaultKey`); an
// un-defaulted key stays optional (`optionalKey`).
type PageField<L extends Schema.Top, HasDefault extends boolean> = HasDefault extends true
  ? Schema.withDecodingDefaultKey<L>
  : Schema.optionalKey<L>;

/**
 * The `{ offset, limit }` field-map produced by {@link Page.offset} for a given
 * options object.
 *
 * @since 0.3.0
 * @category models
 */
export type OffsetPageFields<O extends OffsetPageOptions> = {
  readonly offset: PageField<PageLeaf<O>, HasDefaultKey<O, "defaultOffset">>;
  readonly limit: PageField<PageLeaf<O>, HasDefaultKey<O, "defaultLimit">>;
};

/**
 * The `{ number, size }` field-map produced by {@link Page.number} for a given
 * options object.
 *
 * @since 0.3.0
 * @category models
 */
export type NumberPageFields<O extends NumberPageOptions> = {
  readonly number: PageField<PageLeaf<O>, HasDefaultKey<O, "defaultNumber">>;
  readonly size: PageField<PageLeaf<O>, HasDefaultKey<O, "defaultSize">>;
};

// Wraps a leaf in `optionalKey`, or — when a default is supplied — in
// `withDecodingDefaultKey`. `withDecodingDefaultKey` takes the *encoded*
// default, so a string-coercing field needs a STRING default and a plain-number
// field a number default.
const withPageDefault = (
  leaf: Schema.Top,
  value: number | undefined,
  fromString: boolean,
): Schema.Top =>
  value === undefined
    ? Schema.optionalKey(leaf)
    : leaf.pipe(Schema.withDecodingDefaultKey(Effect.succeed(fromString ? String(value) : value)));

const offsetPage = <const O extends OffsetPageOptions = Record<never, never>>(
  options?: O,
): OffsetPageFields<O> => {
  const { maxLimit, minLimit = 1, defaultLimit, defaultOffset, fromString = true } = options ?? {};
  const base = fromString ? Schema.FiniteFromString : Schema.Number;
  const offsetLeaf = base.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
  const limitLeaf =
    maxLimit === undefined
      ? base.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(minLimit))
      : base.check(
          Schema.isInt(),
          Schema.isGreaterThanOrEqualTo(minLimit),
          Schema.isLessThanOrEqualTo(maxLimit),
        );
  return {
    offset: withPageDefault(offsetLeaf, defaultOffset, fromString),
    limit: withPageDefault(limitLeaf, defaultLimit, fromString),
  } as OffsetPageFields<O>;
};

const numberPage = <const O extends NumberPageOptions = Record<never, never>>(
  options?: O,
): NumberPageFields<O> => {
  const { maxSize, minSize = 1, defaultSize, defaultNumber, fromString = true } = options ?? {};
  const base = fromString ? Schema.FiniteFromString : Schema.Number;
  // Page numbers are 1-based.
  const numberLeaf = base.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
  const sizeLeaf =
    maxSize === undefined
      ? base.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(minSize))
      : base.check(
          Schema.isInt(),
          Schema.isGreaterThanOrEqualTo(minSize),
          Schema.isLessThanOrEqualTo(maxSize),
        );
  return {
    number: withPageDefault(numberLeaf, defaultNumber, fromString),
    size: withPageDefault(sizeLeaf, defaultSize, fromString),
  } as NumberPageFields<O>;
};

/**
 * Common pagination strategies, ready to pass as the `page` query option.
 * Each key becomes a `page[<key>]` query parameter, and each
 * `Page.Offset` / `Page.Number` / `Page.Cursor` value is a
 * `Schema.Struct.Fields` whose members decode from strings.
 *
 * For configurable offset/page-number pagination — a `maxLimit` DoS guard,
 * decode defaults, and optional plain-number decoding — use the {@link Page.offset}
 * and {@link Page.number} factories instead of the constants.
 *
 * Custom strategies are plain `Schema.Struct.Fields` whose values decode from
 * strings.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Endpoint, Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 *
 * // enable offset/limit pagination on a list endpoint
 * Endpoint.list(Article, { page: Query.Page.Offset })
 *
 * // ...or a bounded, defaulted variant
 * Endpoint.list(Article, { page: Query.Page.offset({ maxLimit: 100, defaultLimit: 25 }) })
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const Page = {
  /** `?page[offset]=0&page[limit]=10` */
  Offset: {
    offset: Schema.optionalKey(PageInt),
    limit: Schema.optionalKey(PageInt),
  },
  /** `?page[number]=2&page[size]=25` */
  Number: {
    number: Schema.optionalKey(PageInt),
    size: Schema.optionalKey(PageInt),
  },
  /** `?page[cursor]=opaque&page[size]=25` */
  Cursor: {
    cursor: Schema.optionalKey(Schema.String),
    size: Schema.optionalKey(PageInt),
  },
  /**
   * A configurable `{ offset, limit }` field-map: the bounded / defaulted /
   * coercion-flexible variant of {@link Page.Offset}.
   *
   * - **Bounded** — `maxLimit` caps `limit` (a DoS guard); `minLimit` (default 1) floors it.
   * - **Defaulted** — `defaultLimit` / `defaultOffset` fill in on decode when the wire key is
   *   absent, so downstream code sees concrete numbers; omit one to leave that field optional.
   * - **Coercion-flexible** — `fromString: false` builds the fields from plain `Schema.Number`
   *   (encoded = number) instead of `FiniteFromString` (encoded = string), so the same schema
   *   works both as a numeric call-site input and behind a transport that coerces query strings.
   *
   * @example
   * ```ts
   * import { Schema } from "effect"
   * import { Query } from "@thomasfosterau/effect-jsonapi"
   *
   * const page = Schema.Struct(Query.Page.offset({ maxLimit: 100, defaultLimit: 25 }))
   * Schema.decodeUnknownSync(page)({}) // → { limit: 25 }
   * ```
   *
   * @since 0.3.0
   * @category constructors
   */
  offset: offsetPage,
  /**
   * A configurable `{ number, size }` field-map: the page-number twin of
   * {@link Page.offset}. `maxSize` / `minSize` / `defaultSize` bound and default
   * the page size; `defaultNumber` defaults the (1-based) page number.
   *
   * @example
   * ```ts
   * import { Schema } from "effect"
   * import { Query } from "@thomasfosterau/effect-jsonapi"
   *
   * const page = Schema.Struct(Query.Page.number({ maxSize: 100, defaultSize: 25 }))
   * Schema.decodeUnknownSync(page)({}) // → { size: 25 }
   * ```
   *
   * @since 0.3.0
   * @category constructors
   */
  number: numberPage,
} as const;

// ---------------------------------------------------------------------------
// General key bracketing
// ---------------------------------------------------------------------------

// Marker recording, for a schema `bracketKeys` produced, the *original* flat
// struct it was built from and every rename applied to it so far — named in
// the library's own `~`-prefixed style for a non-public protocol member (see
// `decodeTo`'s `"~type.make.in"` etc.). Kept as the base (never the previous
// call's own wire struct) so a further `bracketKeys` call always renames a
// stable set of decoded field names, and re-derives the *whole* wire shape in
// one `Schema.encodeKeys` pass rather than nesting renames — nesting would
// require iterating a previous call's already-renamed keys, silently losing
// its bracketing the moment a later mapping didn't happen to repeat it.
const BRACKETED = "~bracketed" as const;

interface BracketedState<S extends Schema.Struct<Schema.Struct.Fields>> {
  readonly struct: S;
  readonly mapping: { readonly [key: string]: string };
}

/**
 * The schema {@link bracketKeys} returns: `S` with the given keys' *encoded*
 * form renamed under a bracket prefix, carrying enough of the composition —
 * the original struct and every rename applied to it so far — that a further
 * {@link bracketKeys} call composes onto it correctly.
 *
 * @since 0.15.0
 * @category models
 */
export interface BracketedKeys<
  S extends Schema.Struct<Schema.Struct.Fields>,
  Mapping extends { readonly [K in keyof S["fields"]]?: string },
> extends Schema.encodeKeys<S, Mapping> {
  readonly [BRACKETED]: BracketedState<S>;
}

// The struct a (possibly already-bracketed) schema was built from.
type BracketedBase<S> =
  S extends BracketedKeys<infer B, any>
    ? B
    : S extends Schema.Struct<Schema.Struct.Fields>
      ? S
      : never;

// The rename mapping a (possibly already-bracketed) schema carries so far.
type BracketedMapping<S> = S extends BracketedKeys<any, infer M> ? M : Record<never, never>;

// The mapping one `bracketKeys(prefix, keys)` call itself contributes.
type PrefixMapping<Prefix extends string, Keys extends ReadonlyArray<PropertyKey>> = {
  readonly [K in Keys[number] as K extends string ? K : never]: `${Prefix}[${K & string}]`;
};

/**
 * Re-keys an arbitrary set of a **flat** query struct's *encoded* keys under a
 * bracket prefix — `Query.bracketKeys("page", ["offset", "limit"])` renames
 * `offset` ↔ `page[offset]`, `limit` ↔ `page[limit]` — leaving the decoded
 * type, and every other field's wire key, untouched. It is the general form
 * of {@link bracketPageKeys}: any prefix (`page`, `filter`, `fields`, or one
 * of your own) and any subset of the struct's keys, not just `offset` /
 * `limit`.
 *
 * This is the standalone counterpart to {@link schema}'s family options.
 * Where `Query.schema(resource, { page, filter })` composes the whole query
 * and *nests* each family under its own key, this combinator only renames
 * keys of a struct you already own — for consumers whose list-input contract
 * merges several families **flat** into one struct (a `{ limit, offset,
 * status, … }` the rest of their application consumes directly) rather than
 * composing through `Query.schema`.
 *
 * **Composing several prefixes onto one struct.** Pipe more than one call:
 * each renames a disjoint subset of the *original* struct's keys, and the
 * result's decoded and encoded types reflect every rename applied so far —
 * `.pipe(Query.bracketKeys("page", [...]), Query.bracketKeys("filter", [...]))`
 * is not `Schema.Top`, it is the struct with both families bracketed.
 *
 * Built on `Schema.encodeKeys`, the canonical Effect key-rename: only the
 * *encoded* side changes, so call-site inputs and handler-visible values keep
 * the flat shape. `HttpApiEndpoint` coerces the bracket leaves to and from
 * their string wire form, so fields built from either the `Query.Page`
 * constants or a plain-number factory (`fromString: false`) work.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query } from "@thomasfosterau/effect-jsonapi"
 *
 * // A flat list input: pagination and a filter merged alongside each other.
 * const ListArticles = Schema.Struct({
 *   ...Query.Page.offset({ maxLimit: 100, fromString: false }),
 *   authorId: Schema.optionalKey(Schema.String),
 *   status: Schema.optionalKey(Schema.String)
 * })
 *
 * const wire = ListArticles.pipe(
 *   Query.bracketKeys("page", ["offset", "limit"]),
 *   Query.bracketKeys("filter", ["status"])
 * )
 *
 * // Only `offset`/`limit` and `status` are bracketed; `authorId` stays flat.
 * Schema.decodeUnknownSync(wire)({
 *   "page[offset]": 20,
 *   "page[limit]": 10,
 *   "filter[status]": "open",
 *   authorId: "9"
 * })
 * // → { offset: 20, limit: 10, status: "open", authorId: "9" }
 * ```
 *
 * @since 0.15.0
 * @category combinators
 */
export const bracketKeys =
  <
    S extends Schema.Struct<Schema.Struct.Fields> | BracketedKeys<any, any>,
    const Prefix extends string,
    const Keys extends ReadonlyArray<Extract<keyof BracketedBase<S>["fields"], string>>,
  >(
    prefix: Prefix,
    keys: Keys,
  ) =>
  (
    schema: S,
  ): BracketedKeys<BracketedBase<S>, BracketedMapping<S> & PrefixMapping<Prefix, Keys>> => {
    const state = (
      schema as { readonly [BRACKETED]?: BracketedState<Schema.Struct<Schema.Struct.Fields>> }
    )[BRACKETED];
    const struct = state?.struct ?? (schema as unknown as Schema.Struct<Schema.Struct.Fields>);
    const mapping: Record<string, string> = { ...state?.mapping };
    for (const key of keys) mapping[key] = `${prefix}[${key}]`;
    const wire = struct.pipe(Schema.encodeKeys(mapping));
    return Object.assign(wire, { [BRACKETED]: { struct, mapping } }) as unknown as BracketedKeys<
      BracketedBase<S>,
      BracketedMapping<S> & PrefixMapping<Prefix, Keys>
    >;
  };

/**
 * The struct shape {@link bracketPageKeys} accepts: any struct carrying
 * `offset` and `limit` fields, whatever else it also carries.
 *
 * @since 0.7.0
 * @category models
 */
export interface OffsetPageStruct extends Schema.Struct<Schema.Struct.Fields> {
  readonly fields: {
    readonly limit: Schema.Top;
    readonly offset: Schema.Top;
  };
}

/**
 * The schema {@link bracketPageKeys} returns: `S` with only its `offset` /
 * `limit` *encoded* keys renamed to the JSON:API bracket family.
 *
 * @since 0.7.0
 * @category models
 */
export interface BracketPageKeys<S extends OffsetPageStruct> extends Schema.encodeKeys<
  S,
  {
    readonly limit: "page[limit]";
    readonly offset: "page[offset]";
  }
> {}

/**
 * Re-keys a **flat** query struct's page cursor to the spec-canonical JSON:API
 * bracket family on the wire — `offset` ↔ `page[offset]`, `limit` ↔
 * `page[limit]` — leaving the decoded type, and every other field's wire key,
 * untouched.
 *
 * This is the standalone counterpart to {@link schema}'s `page` option. Where
 * `Query.schema(resource, { page })` composes the whole query (`include` /
 * `fields` / `sort` / `page` / `filter`) and *nests* the decoded cursor under a
 * `page` key, this combinator only renames two encoded keys of a struct you
 * already own — for consumers whose list-input contract merges pagination
 * **flat** alongside their own filter fields (a `{ limit, offset, … }` the rest
 * of their application consumes directly) rather than composing through
 * `Query.schema`. The bracket keys are the same family
 * {@link Handlers.offsetPaginationLinks} emits, so a client following a `next`
 * link decodes straight back into `{ offset, limit }`.
 *
 * A thin, pre-0.15 specialisation of the general {@link bracketKeys} —
 * `Query.bracketPageKeys(s)` is exactly `s.pipe(Query.bracketKeys("page", ["offset", "limit"]))`.
 * Reach for {@link bracketKeys} directly when you need a different prefix, a
 * different key set, or to compose more than one bracketed family onto the
 * same struct.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query } from "@thomasfosterau/effect-jsonapi"
 *
 * // A flat list input: pagination merged alongside an application filter.
 * const ListArticles = Schema.Struct({
 *   ...Query.Page.offset({ maxLimit: 100, fromString: false }),
 *   authorId: Schema.optionalKey(Schema.String)
 * })
 *
 * const wire = Query.bracketPageKeys(ListArticles)
 *
 * // Only the page cursor is bracketed; `authorId` keeps its flat wire key.
 * Schema.decodeUnknownSync(wire)({ "page[offset]": 20, "page[limit]": 10, authorId: "9" })
 * // → { offset: 20, limit: 10, authorId: "9" }
 * ```
 *
 * @since 0.7.0
 * @category combinators
 */
export const bracketPageKeys = <S extends OffsetPageStruct>(schema: S): BracketPageKeys<S> =>
  // The casts are sound: `BracketPageKeys<S>` extends exactly the
  // `Schema.encodeKeys` instantiation `bracketKeys("page", ["offset", "limit"])`
  // builds, and resolves to it for every concrete `S` — but the two can't be
  // proven comparable while `S` is still generic, nor can `bracketKeys`'s own
  // key-membership check run against a struct type that is itself still generic.
  (schema as unknown as Schema.Struct<Schema.Struct.Fields>).pipe(
    bracketKeys("page", ["offset", "limit"]),
  ) as unknown as BracketPageKeys<S>;

// ---------------------------------------------------------------------------
// Feature schemas
// ---------------------------------------------------------------------------

// Normalises "one resource or several" to an array (heterogeneous endpoints
// pass several).
const toResources = <R extends Any>(resource: R | ReadonlyArray<R>): ReadonlyArray<R> =>
  Array.isArray(resource) ? (resource as ReadonlyArray<R>) : [resource as R];

const dedupe = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)];

/**
 * Constrains the `include` paths an endpoint advertises.
 *
 * The default derivation is the resource's whole relationship graph to a depth
 * of 2 — a boolean "include is on". That is the right answer when every path in
 * the graph is resolvable, and the wrong one when it isn't: advertising a path
 * a resolver can't populate answers `200` with an empty `included`, which is
 * less useful to a client than the `400` an unknown path already produces.
 *
 * Pass `paths` for an explicit allow-list, `depth` to bound the derivation
 * (`1` — direct relationships only, `2` — the default, `3`), or both, in which
 * case `paths` wins.
 *
 * @since 0.9.0
 * @category models
 */
export interface IncludeOptions<R extends Any> {
  /** The exact set of legal paths. Anything else fails decoding (→ 400). */
  readonly paths?: ReadonlyArray<IncludePathsTo<R, 3>>;
  /** How many hops into the relationship graph to derive. Defaults to 2. */
  readonly depth?: IncludeDepth;
  /**
   * The discriminant an `Include.Surface` carries, declared here as `never` so
   * that a surface can never satisfy this arm of {@link IncludeOption}: a
   * surface's `paths` may well be legal paths of *another* resource, and
   * without this it would be silently accepted as that resource's allow-list
   * instead of being rejected as the wrong resource's surface.
   *
   * @internal
   */
  readonly "~@thomasfosterau/effect-jsonapi/include"?: never;
}

/**
 * The `include` option of a query configuration: `true` (the full graph at
 * depth 2), `false` (no `?include=` parameter), an {@link IncludeOptions}
 * object constraining the derivation, or an `Include.Surface` — a nested
 * declaration the whitelist, the `included` union and this parameter all
 * project from at once.
 *
 * @since 0.9.0
 * @category models
 */
export type IncludeOption<R extends Any> = boolean | IncludeOptions<R> | SurfaceFor<R>;

/**
 * The `include` paths an {@link IncludeOption} legalises: a declared
 * `Include.Surface`'s paths or an explicit allow-list (both read off the
 * option's `paths`), else the graph derived to the requested depth, else the
 * depth-2 default.
 *
 * @since 0.9.0
 * @category type-level
 */
export type IncludePathsOf<R extends Any, I> = LegalIncludePaths<R, I>;

/**
 * The decoded `include` schema: a comma-separated list of relationship paths,
 * typed as the resource's legal path literals (2 hops into the relationship
 * graph, unless constrained) and validated at decode time. Accepts both the
 * comma form (`"a,b"`) and the repeated-key spelling (`["a", "b"]`,
 * `UrlParams.toRecord`'s shape for a repeated key) and any mix of the two.
 *
 * @since 0.1.0
 * @category models
 */
export interface Include<
  R extends Any,
  Paths extends string = IncludePath<R>,
> extends Schema.decodeTo<
  CommaSeparated<Schema.Literals<ReadonlyArray<Paths>>>,
  Repeatable,
  never,
  never
> {}

/**
 * Creates the `include` schema for one resource (or, for heterogeneous
 * endpoints, several). Paths default to the relationship keys plus dotted paths
 * one further hop into the graph; anything else fails decoding (→ 400).
 *
 * Pass {@link IncludeOptions} to constrain that set — an explicit `paths`
 * allow-list, or a `depth` bound — for resources whose graph reaches further
 * than the endpoint can actually resolve.
 *
 * Pass an `Include.Surface` to legalise exactly a *declared* surface instead:
 * the same declaration then also derives the `included` union the success
 * document must carry, so the advertised paths and the resources a walk may
 * hoist cannot drift apart.
 *
 * Decodes either wire spelling of the same set — the comma form (`"a,b"`) or
 * the repeated-key spelling (`["a", "b"]`, `UrlParams.toRecord`'s shape for a
 * repeated key) — and any mix of the two; encoding always emits the comma
 * form.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Include, Query, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     comments: Relationship.many(() => Comment)
 *   }
 * })
 *
 * const include = Query.Include(Article)
 * Schema.decodeUnknownSync(include)("author,comments.author")
 * // → ["author", "comments.author"]
 *
 * // the repeated-key spelling decodes to the same set
 * Schema.decodeUnknownSync(include)(["author", "comments.author"])
 * // → ["author", "comments.author"]
 *
 * // …or a deliberate subset: only the paths this endpoint can populate
 * const shallow = Query.Include(Article, { paths: ["author", "comments"] })
 * Schema.decodeUnknownSync(shallow)("author,comments")
 * // → ["author", "comments"]
 *
 * // …or a declared surface, which also derives the `included` union
 * const surface = Include.make(Article, {
 *   comments: Include.nested(Comment, { author: Person })
 * })
 * const declared = Query.Include(Article, surface)
 * Schema.decodeUnknownSync(declared)("comments.author")
 * // → ["comments.author"]
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const Include = <
  R extends Any,
  const O extends IncludeOptions<R> | AnySurface | undefined = undefined,
>(
  resource: R | ReadonlyArray<R>,
  options?: O,
): Include<R, IncludePathsOf<R, O>> => {
  const paths = includePathsFor(
    toResources(resource),
    options as IncludeOptions<Any> | AnySurface | undefined,
  ) as ReadonlyArray<IncludePathsOf<R, O>>;
  return repeatable(
    CommaSeparated(
      // The whitelist rides on the literal schema as the `include`
      // vocabulary, so the 400 `Middleware.schemaErrorDocument` renders for a
      // rejected path carries `meta.includablePaths` — the same set
      // `ApiError.UnsupportedIncludePath` publishes — and a caller learns the
      // legal paths without a second call. An empty set makes `include`
      // unsupported (#282), and its rejection says so rather than "Expected
      // never".
      Schema.Literals(paths).annotate(
        vocabularyAnnotations(
          { family: "include", values: paths },
          "This endpoint supports no include paths.",
        ),
      ),
    ),
  ) as Include<R, IncludePathsOf<R, O>>;
};

/**
 * The open `?include=` list: a §7.1 path list with **no** whitelist — the
 * spelling a flat contract advertises when the legal set is enforced by the
 * handler (`Assemble.resource` / `ResourceHandlers`, which answer
 * `ApiError.UnsupportedIncludePath` with `meta.includablePaths`) rather than
 * by the schema.
 *
 * Decodes either wire spelling — the comma form (`"a,b"`) or the
 * repeated-key form (`["a", "b"]`, `UrlParams.toRecord`'s shape for a
 * repeated key) and any mix — trimming incidental whitespace and dropping
 * empty segments; encoding is the identity on the array (the client always
 * sends one, and `UrlParams` expands it to repeated keys).
 *
 * Prefer {@link Include} where the endpoint's legal set is known at
 * schema-build time: it rejects an unknown path with the same
 * `meta.includablePaths` at decode, before any handler runs.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query } from "@thomasfosterau/effect-jsonapi"
 *
 * const decode = Schema.decodeUnknownSync(Query.IncludeList)
 * console.log(decode("author, comments,,"), decode(["author", "comments.author"]))
 * // → [ "author", "comments" ] [ "author", "comments.author" ]
 * ```
 *
 * @since 0.16.0
 * @category models
 */
export const IncludeList: Schema.decodeTo<
  Schema.$Array<Schema.String>,
  Schema.Union<readonly [Schema.String, Schema.$Array<Schema.String>]>,
  never,
  never
> = Schema.Union([Schema.String, Schema.Array(Schema.String)]).pipe(
  Schema.decodeTo(
    Schema.Array(Schema.String),
    SchemaTransformation.transform<ReadonlyArray<string>, string | ReadonlyArray<string>>({
      decode: (value) =>
        (typeof value === "string" ? [value] : value).flatMap((occurrence) =>
          occurrence
            .split(",")
            .map((path) => path.trim())
            .filter((path) => path !== ""),
        ),
      encode: (value) => value,
    }),
  ),
);

/**
 * The decoded {@link IncludeList}: the §7.1 path list.
 *
 * @since 0.16.0
 * @category models
 */
export type IncludeList = typeof IncludeList.Type;

/**
 * The `include` field a flat query struct spreads in to advertise the open
 * `?include=` parameter: `{ include: Schema.optionalKey(Query.IncludeList) }`.
 *
 * @since 0.16.0
 * @category models
 */
export const includeListField: { readonly include: Schema.optionalKey<typeof IncludeList> } = {
  include: Schema.optionalKey(IncludeList),
};

/**
 * The struct shape {@link flatList} accepts: a flat list input carrying the
 * `offset` / `limit` page cursor, whatever else it also carries.
 *
 * @since 0.16.0
 * @category models
 */
export interface FlatListStruct extends Schema.Struct<Schema.Struct.Fields> {
  readonly fields: {
    readonly offset: Schema.Top;
    readonly limit: Schema.Top;
    readonly [key: string]: Schema.Top;
  };
}

/**
 * Options of {@link flatList}.
 *
 * @since 0.16.0
 * @category models
 */
export interface FlatListOptions<S extends FlatListStruct> {
  /**
   * Fields of the struct whose **wire** key moves into the JSON:API
   * `filter[…]` family, the way the page cursor's moves into `page[…]`:
   * `filters: ["status"]` advertises `?filter[status]=` and decodes it back to
   * a flat `status`. Fields not named stay under their flat key.
   */
  readonly filters?: ReadonlyArray<Extract<keyof S["fields"], string>> | undefined;
  /**
   * Whether to add the open `?include=` parameter ({@link includeListField}).
   * Defaults to `true`.
   */
  readonly include?: boolean | undefined;
}

/**
 * The schema {@link flatList} returns: the flat struct plus the `include`
 * field, page-cursor and filter keys bracketed on the wire.
 *
 * @since 0.16.0
 * @category models
 */
export type FlatList<
  S extends FlatListStruct,
  Filters extends ReadonlyArray<string>,
  IncludeField extends boolean,
> = BracketedKeys<
  Schema.Struct<
    S["fields"] & (IncludeField extends false ? Record<never, never> : typeof includeListField)
  >,
  { readonly offset: "page[offset]"; readonly limit: "page[limit]" } & {
    readonly [K in Filters[number]]: `filter[${K}]`;
  }
>;

/**
 * A list endpoint's wire query from a **flat** list input — the struct the
 * rest of an application consumes directly (`{ limit, offset, status }`):
 * the open `?include=` parameter added ({@link includeListField}), the page
 * cursor re-keyed to `page[offset]` / `page[limit]` and each named filter to
 * `filter[<field>]`. The decoded shape is the flat input, unchanged, so the
 * operation consuming it never sees the difference.
 *
 * The `include` field is added *before* the keys are bracketed: a bracketed
 * schema is a key-rename wrapper rather than a struct, so a field added after
 * it has nowhere to go. The result is a `Query.FlatQuerySchema`, so
 * {@link canonicalPairs} applies to it directly — which is how a collection's
 * pagination links come to carry every parameter the request did.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { FlatQuery, Query } from "@thomasfosterau/effect-jsonapi"
 *
 * const ListArticles = Schema.Struct({
 *   ...FlatQuery.pagination({ maxLimit: 100 }),
 *   status: Schema.optionalKey(Schema.String)
 * })
 * const wire = Query.flatList(ListArticles, { filters: ["status"] })
 *
 * console.log(Schema.decodeUnknownSync(wire)({
 *   "page[limit]": 5, "filter[status]": "open", include: "author"
 * }))
 * // → { offset: 0, limit: 5, status: "open", include: [ "author" ] }
 * console.log(Query.canonicalPairs(wire)({ offset: 0, limit: 5, status: "open", include: ["author"] }))
 * // → [ [ "include", "author" ], [ "filter[status]", "open" ], [ "page[offset]", "0" ], [ "page[limit]", "5" ] ]
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const flatList = <
  S extends FlatListStruct,
  const Filters extends ReadonlyArray<Extract<keyof S["fields"], string>> = readonly [],
  const IncludeField extends boolean = true,
>(
  list: S,
  options?: FlatListOptions<S> & {
    readonly filters?: Filters | undefined;
    readonly include?: IncludeField | undefined;
  },
): FlatList<S, Filters, IncludeField> => {
  const filters = options?.filters ?? [];
  const withInclude =
    options?.include === false
      ? Schema.Struct(list.fields)
      : Schema.Struct({ ...list.fields, ...includeListField });
  // The cast restates what the type parameters already say: `bracketKeys`
  // checks each key's membership against a struct type that is generic here.
  return withInclude.pipe(
    bracketKeys("page", ["offset", "limit"]),
    bracketKeys("filter", filters as ReadonlyArray<never>),
  ) as unknown as FlatList<S, Filters, IncludeField>;
};

/**
 * One requested `include` path, already split on `.` into its segments — the
 * parse {@link validateIncludePaths} performs once, so a caller walking the
 * relationship graph (a resolver) doesn't re-tokenise a path it already
 * validated.
 *
 * @since 0.15.0
 * @category models
 */
export interface IncludePathSegments {
  /** The path as requested, e.g. `"comments.author"`. */
  readonly path: string;
  /** The path split on `.`, e.g. `["comments", "author"]`. */
  readonly segments: ReadonlyArray<string>;
}

/**
 * Options for {@link validateIncludePaths}: the paths actually supported, and
 * the maximum number of hops a path may have.
 *
 * @since 0.15.0
 * @category models
 */
export interface ValidateIncludePathsOptions {
  /** The whole set of supported paths, matched against the full dotted path. */
  readonly includable: ReadonlyArray<string>;
  /** The maximum number of `.`-separated hops a path may have. */
  readonly maxDepth: number;
}

/**
 * Validates requested `include` paths against a runtime whitelist and depth
 * cap, failing with {@link ApiError.UnsupportedIncludeDepth} or
 * {@link ApiError.UnsupportedIncludePath}.
 *
 * Depth is checked before membership: an over-deep path fails with
 * `UnsupportedIncludeDepth` even when it also isn't in `includable`, since
 * depth and membership answer different questions — a caller that asked for
 * one legal hop too many needs to be told about the cap, not told its path
 * doesn't exist. Membership is matched against the whole dotted path, not
 * just its first segment, so `"comments.author"` is only legal when the
 * *whole* path is includable, not merely `"comments"`.
 *
 * Unlike {@link Include} — a closed `Schema.Literals` derived once, at
 * schema-build time, from a resource's relationship graph — this validates a
 * *runtime* list of requested paths against a runtime whitelist, for a
 * resolver that walks arbitrary requested paths rather than a fixed schema.
 * It returns each path's already-split segments so that walk doesn't
 * re-tokenise a path it just validated.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Query } from "@thomasfosterau/effect-jsonapi"
 *
 * const validated = Query.validateIncludePaths(["author", "comments.author"], {
 *   includable: ["author", "comments", "comments.author"],
 *   maxDepth: 2
 * }).pipe(Effect.runSync)
 * // → [
 * //     { path: "author", segments: ["author"] },
 * //     { path: "comments.author", segments: ["comments", "author"] }
 * //   ]
 *
 * // an over-deep path fails with UnsupportedIncludeDepth even though it also
 * // isn't in `includable` — depth is checked first
 * const rejected = Query.validateIncludePaths(["comments.author.employer"], {
 *   includable: ["author", "comments"],
 *   maxDepth: 2
 * }).pipe(Effect.flip, Effect.runSync)
 * // → UnsupportedIncludeDepth({
 * //     path: "comments.author.employer",
 * //     maxDepth: 2,
 * //     includablePaths: ["author", "comments"]
 * //   })
 * ```
 *
 * @since 0.15.0
 * @category combinators
 */
export const validateIncludePaths = (
  requested: ReadonlyArray<string>,
  options: ValidateIncludePathsOptions,
): Effect.Effect<
  ReadonlyArray<IncludePathSegments>,
  ApiError.UnsupportedIncludeDepth | ApiError.UnsupportedIncludePath
> =>
  Effect.forEach(
    requested,
    (
      path,
    ): Effect.Effect<
      IncludePathSegments,
      ApiError.UnsupportedIncludeDepth | ApiError.UnsupportedIncludePath
    > => {
      const segments = path.split(".");
      if (segments.length > options.maxDepth) {
        return Effect.fail(
          new ApiError.UnsupportedIncludeDepth({
            path,
            maxDepth: options.maxDepth,
            includablePaths: options.includable,
          }),
        );
      }
      if (!options.includable.includes(path)) {
        return Effect.fail(
          new ApiError.UnsupportedIncludePath({ path, includablePaths: options.includable }),
        );
      }
      return Effect.succeed({ path, segments });
    },
    // Sequential: the first unsupported path is the one the error reports.
    { concurrency: 1 },
  );

/**
 * The decoded sparse-fieldset schema for one resource type: a comma-separated
 * list of field names — attributes and relationships, which JSON:API 1.1
 * counts as fields alike (§Resource Object Fields, #494) — validated against
 * the closed set of the resource's fields.
 * Accepts both the comma form and the repeated-key spelling (`["title",
 * "body"]`), and any mix of the two.
 *
 * @since 0.1.0
 * @category models
 */
export interface Fieldset<Field extends string> extends Schema.decodeTo<
  CommaSeparated<Schema.Literals<ReadonlyArray<Field>>>,
  Repeatable,
  never,
  never
> {}

/**
 * Creates the sparse-fieldset schema for one resource type.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", { attributes: { name: Schema.String } })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 *
 * const fieldset = Query.Fieldset(Article)
 * Schema.decodeUnknownSync(fieldset)("title,body")
 * // → ["title", "body"]
 *
 * // a relationship is a field too (§Sparse Fieldsets)
 * Schema.decodeUnknownSync(fieldset)("title,author")
 * // → ["title", "author"]
 *
 * // the repeated-key spelling (`?fields[articles]=title&fields[articles]=body`,
 * // which `UrlParams.toRecord` surfaces as an array) decodes to the same set
 * Schema.decodeUnknownSync(fieldset)(["title", "body"])
 * // → ["title", "body"]
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const Fieldset = <R extends Any>(resource: R): Fieldset<FieldKeys<R>> =>
  fieldsetOf(resource.type, fieldKeys(resource));

// The fieldset schema of the wire type `type` over the vocabulary `fields`.
// `Query.schema` builds one per wire type from the fields of every
// definition sharing it (#362); `Fieldset` from one definition's.
const fieldsetOf = <Field extends string>(
  type: string,
  fields: ReadonlyArray<Field>,
): Fieldset<Field> =>
  repeatable(
    CommaSeparated(
      // The fieldset's fields ride on the literal schema as the `fields`
      // vocabulary of this resource type, so `Middleware`'s support check
      // treats a `fields[TYPE]` whose type has no field to select as
      // unsupported (#261), that type alone. Its rejection says so rather
      // than "Expected never".
      Schema.Literals(fields).annotate(
        vocabularyAnnotations(
          { family: "fields", type, values: fields },
          `This endpoint supports no sparse fieldset for type "${type}".`,
        ),
      ),
    ),
  ) as Fieldset<Field>;

/**
 * The decoded `sort` schema: a list of `{ field, direction }` terms. Accepts
 * both the comma form and the repeated-key spelling (`["-createdAt",
 * "title"]`), and any mix of the two.
 *
 * @since 0.1.0
 * @category models
 */
export interface Sort<Field extends string> extends Schema.decodeTo<
  SortCodec<Field>,
  Repeatable,
  never,
  never
> {}

/**
 * Creates the `sort` schema for a set of sortable fields.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query } from "@thomasfosterau/effect-jsonapi"
 *
 * const sort = Query.Sort(["createdAt", "title"])
 * Schema.decodeUnknownSync(sort)("-createdAt,title")
 * // → [{ field: "createdAt", direction: "desc" },
 * //    { field: "title", direction: "asc" }]
 *
 * // the repeated-key spelling (`?sort=-createdAt&sort=title`) decodes to the same list
 * Schema.decodeUnknownSync(sort)(["-createdAt", "title"])
 * // → [{ field: "createdAt", direction: "desc" },
 * //    { field: "title", direction: "asc" }]
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const Sort = <const Field extends string>(fields: ReadonlyArray<Field>): Sort<Field> =>
  repeatable(SortCodec(fields)) as Sort<Field>;

// ---------------------------------------------------------------------------
// The filter codec (docs/filter-grammar.md)
// ---------------------------------------------------------------------------

/**
 * The JSON:API profile URI of the filter grammar — `Filter.PROFILE_URI`,
 * re-exported for the query module's consumers. Advertise it on responses
 * from endpoints declared with `filter: true`:
 * `Content-Type: application/vnd.api+json; profile="…"`.
 *
 * @since 0.13.0
 * @category constants
 */
export const FILTER_PROFILE_URI: typeof PROFILE_URI = PROFILE_URI;

/**
 * The field vocabulary of a resource's filter AST: each key
 * `Resource.filterable` declares, to its decoded literal type (the attribute's
 * `Type`, or the related resource's id for a to-one relationship).
 *
 * @since 0.13.0
 * @category type-level
 */
export type FilterFields<R extends Any> = {
  readonly [K in FilterableKeys<R>]: Filterable<R>[K]["literal"]["Type"];
};

/**
 * The decoded `filter` of a resource: `Filter.Ast` with `field` narrowed to
 * the declared filterable names and each literal to its field's type.
 *
 * @since 0.13.0
 * @category type-level
 */
export type FilterAst<R extends Any> = Ast<FilterFields<R>>;

/**
 * The schema of a decoded {@link FilterAst} as it sits in a query's nested
 * shape (the `filter` key of `Query.schema(R, { filter: true })`): the tree
 * is already decoded, so both sides are the AST.
 *
 * @since 0.13.0
 * @category models
 */
export interface FilterAstSchema<R extends Any> extends Schema.Codec<FilterAst<R>, FilterAst<R>> {}

/**
 * The `filter[...]` codec of a resource: the flat record of `filter[...]`
 * keys (string values) on the wire, one {@link FilterAst} root node decoded.
 *
 * @since 0.13.0
 * @category models
 */
export interface Filter<R extends Any> extends Schema.Codec<
  FilterAst<R>,
  { readonly [key: string]: string }
> {}

/**
 * The wire value of one `filter` family key: a string, or — from a repeated
 * key — an array of strings, which the codec then rejects (only `include` is
 * repeatable). Kept open at this level so the rejection names the key. The
 * schema type of {@link FilterWireValue}.
 *
 * Before 0.20.0 this was the type named `FilterWireValue`; `FilterWireValue`
 * now names the decoded value, `typeof FilterWireValue.Type`.
 *
 * @since 0.20.0
 * @category models
 */
export interface FilterWireValueSchema extends Schema.Union<
  readonly [Schema.String, Schema.$Array<Schema.String>]
> {}

/**
 * The runtime {@link FilterWireValueSchema} schema.
 *
 * @since 0.13.0
 * @category schemas
 */
export const FilterWireValue: FilterWireValueSchema = Schema.Union([
  Schema.String,
  Schema.Array(Schema.String),
]);

/**
 * The decoded wire value of one `filter` family key: a string, or an array of
 * strings.
 *
 * @since 0.20.0
 * @category models
 */
export type FilterWireValue = typeof FilterWireValue.Type;

const isFilterWireValue = Schema.is(FilterWireValue);

// Every key starting `filter[` — well formed or not, so a malformed key
// (`filter[status]x`) reaches the grammar and is rejected, never silently
// dropped as an excess property. The bare `filter` key is a flat struct field
// of its own for the same reason.
const FilterKey = Schema.TemplateLiteral(["filter[", Schema.String]);

/**
 * The wire side of the filter family when `filter: true` is on: every key
 * starting `filter[`, valued by a {@link FilterWireValue}. The index-signature
 * rest of the flat query struct; the keys cannot be enumerated because the
 * grammar admits any group-form id, and they are deliberately not required to
 * be well formed, so that a malformed one is a 400 naming it rather than an
 * ignored excess property.
 *
 * The schema type of {@link FilterRest}.
 *
 * Before 0.20.0 this was the type named `FilterRest`; `FilterRest` now names
 * the decoded record, `typeof FilterRest.Type`.
 *
 * @since 0.20.0
 * @category models
 */
export interface FilterRestSchema extends Schema.$Record<typeof FilterKey, FilterWireValueSchema> {}

/**
 * The runtime {@link FilterRestSchema} record schema.
 *
 * @since 0.13.0
 * @category schemas
 */
export const FilterRest: FilterRestSchema = Schema.Record(FilterKey, FilterWireValue);

/**
 * The decoded wire side of the filter family: every `filter[…]` key, valued by
 * a {@link FilterWireValue}.
 *
 * @since 0.20.0
 * @category models
 */
export type FilterRest = typeof FilterRest.Type;

// One issue per offending key, or a `Composite` of them when several keys fail.
const filterIssues = (
  ast: SchemaAST.AST,
  input: { readonly [key: string]: unknown },
  issues: ReadonlyArray<SchemaIssue.Issue>,
  options: SchemaAST.ParseOptions,
): SchemaIssue.Issue =>
  issues.length === 1
    ? issues[0]!
    : new SchemaIssue.Composite(
        ast,
        issues as [SchemaIssue.Issue, ...Array<SchemaIssue.Issue>],
        input,
        options,
      );

// Decodes a record of `filter[...]` keys to a normal-form tree.
const decodeFilterRecord = (
  fields: FieldCodecs,
  ast: SchemaAST.AST,
  input: Parameters<typeof decodeFilter>[1],
  options: SchemaAST.ParseOptions,
): Effect.Effect<Node, SchemaIssue.Issue> => {
  const decoded = decodeFilter(fields, input);
  if (Predicate.isTagged(decoded, "Issues"))
    return Effect.fail(filterIssues(ast, input, decoded.issues, options));
  return Effect.fromResult(
    Result.try({
      try: () => prepare(decoded.node, literalEncoder(fields)).node,
      catch: (error) => new SchemaIssue.InvalidValue({ message: messageOf(error) }, input, options),
    }),
  );
};

// Encodes a tree (normalising it first, and checking every field and operator
// against the declaration) to its canonical `filter[...]` pairs.
const encodeFilterNode = (
  fields: FieldCodecs,
  node: Node,
  options: SchemaAST.ParseOptions,
): Effect.Effect<Record<string, string>, SchemaIssue.Issue> =>
  Effect.fromResult(
    Result.try({
      try: () => encodeFilter(prepare(node, literalEncoder(fields), operatorCheck(fields))),
      catch: (error) => new SchemaIssue.InvalidValue({ message: messageOf(error) }, node, options),
    }),
  );

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Creates the `filter` codec for one resource: the filter grammar
 * (`docs/filter-grammar.md`) over the resource's declaration
 * (`Resource.filterable`), between the flat record of `filter[...]` keys on
 * the wire and one decoded, normal-form AST root.
 *
 * Decoding accepts both spellings — the shorthand (`filter[f]=v` is `eq`,
 * `filter[f]=a,b` is `in`, `filter[f][gt]=v` any operator) and the Drupal-style
 * group form (`filter[<id>][group][conjunction]=OR`,
 * `filter[<id>][condition][path]=…`) for `OR`, `NOT`, nesting and repeated
 * `(field, operator)` pairs — validating each field against the declared set,
 * each operator against the field's declared operators, and each literal
 * through the field's literal codec. Every rejection is one issue whose path
 * is the offending flat key, so the schema-error middleware answers with
 * `source.parameter` set to it. Encoding always emits the canonical form
 * (§3): shorthand when it round-trips, the group form with pre-order ids
 * otherwise; the returned record's insertion order is the canonical order.
 *
 * The repeated-key spelling (`filter[f]=a&filter[f]=b`, which
 * `UrlParams.toRecord` surfaces as an array) is accepted wherever the comma
 * form is: `filter[f]`, `filter[f][op]`, and a group form condition's
 * `[value]` member — decoding identically to the comma form, and rejected the
 * same way when the field has no list operator declared. Everywhere else — a
 * group's `[conjunction]`, any `[memberOf]`, a condition's `[path]` /
 * `[operator]` — a repeated key is a 400 (`docs/filter-grammar.md` §2).
 *
 * The record must carry at least one `filter[...]` key — an absent `filter`
 * is `Query.schema`'s concern, not the codec's. Literal codecs are run
 * synchronously.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: {
 *     status: Resource.attribute(Schema.Literals(["open", "done"]), { filter: ["eq", "in"] }),
 *     age: Resource.attribute(Schema.Number, { filter: true })
 *   }
 * })
 *
 * const filter = Query.Filter(Article)
 * Schema.decodeUnknownSync(filter)({ "filter[status]": "open", "filter[age][gt]": "18" })
 * // → { _tag: "And", members: [
 * //      { _tag: "Compare", op: "gt", field: "age", value: 18 },
 * //      { _tag: "Compare", op: "eq", field: "status", value: "open" } ] }
 *
 * Schema.encodeSync(filter)({ _tag: "Compare", op: "eq", field: "status", value: "done" })
 * // → { "filter[status]": "done" }
 * ```
 *
 * @since 0.13.0
 * @category constructors
 */
export const Filter = <R extends Any>(resource: R): Filter<R> => {
  const fields = filterable(resource) as FieldCodecs;
  const from = Schema.Record(Schema.String, FilterWireValue);
  return from.pipe(
    Schema.decodeTo(
      AstSchema,
      SchemaTransformation.transformEffect<
        Node,
        { readonly [key: string]: string | ReadonlyArray<string> }
      >({
        decode: (record, options) => decodeFilterRecord(fields, from.ast, record, options),
        encode: (node, options) => encodeFilterNode(fields, node, options),
      }),
    ),
  ) as unknown as Filter<R>;
};

// ---------------------------------------------------------------------------
// The combined query schema
// ---------------------------------------------------------------------------

/**
 * The `filter` option of a query configuration: `true` turns on the filter
 * grammar over the resource's declaration (decoding to a {@link FilterAst});
 * a `Schema.Struct.Fields` map is the open per-key escape hatch (each key
 * becomes `filter[<key>]`, its schema decoding from a string); `false` or
 * absent is off.
 *
 * @since 0.13.0
 * @category models
 */
export type FilterOption = boolean | Schema.Struct.Fields;

/**
 * Query feature configuration for an endpoint.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options<R extends Any> {
  /**
   * Enable `?include=` — compound document inclusion. `true` legalises the
   * resource's whole relationship graph to a depth of 2; an
   * {@link IncludeOptions} object constrains that to an explicit `paths`
   * allow-list and/or a `depth` bound; an `Include.Surface` legalises exactly
   * a declared surface (and derives the matching `included` union). Paths are
   * validated against the result as *whole* dotted paths, so `comments`
   * being legal does not make `comments.editor` legal; unknown paths produce
   * a 400.
   *
   * Both wire spellings are accepted — `?include=a,b` and `?include=a&include=b`
   * — and decode to the same set.
   */
  readonly include?: IncludeOption<R> | undefined;
  /**
   * Enable `?fields[TYPE]=` — sparse fieldsets for every type the response
   * can carry, and no other: this resource; its non-`paginated` direct
   * relationship targets, which a server MAY include by default, unless
   * `include` is a declared `Include.Surface`; and, when `include` is on,
   * every type a legal include path reaches (`include: true`'s
   * `comments.author` declares `fields[people]`). A type reachable only
   * through a `paginated` relationship is never in `included`, so it has
   * none. Unknown field names produce a 400.
   *
   * Both wire spellings are accepted per type — `?fields[articles]=a,b` and
   * `?fields[articles]=a&fields[articles]=b` — and decode to the same set.
   *
   * Pass an array of wire types instead of `true` to declare `fields[TYPE]`
   * for those of them alone (an allow-list, as `sort` takes one): a
   * relationship endpoint's query is built over the parent resource but its
   * resource objects are only the `included` members, so it declares the
   * types its include paths reach and not the parent's own (#485). A type
   * the derivation above does not reach is a programmer error, and throws;
   * an empty array declares none, as `false` does.
   *
   * A fieldset names attributes and relationships alike, which JSON:API 1.1
   * counts as fields together (§Resource Object Fields, #494):
   * `?fields[articles]=title,author` keeps the `author` relationship and
   * drops every other one.
   *
   * Under the `SchemaErrors` middleware, a `fields[TYPE]` for any other type,
   * or for a type whose resource has no field, is a 400 naming it, as is
   * every `fields[TYPE]` on an endpoint without this option (#261).
   */
  readonly fields?: boolean | ReadonlyArray<string> | undefined;
  /**
   * Enable `?sort=` — `true` allows sorting on every attribute; pass an array
   * of attribute names to restrict the sortable set. Unknown fields produce a 400.
   *
   * Both wire spellings are accepted — `?sort=-createdAt,title` and
   * `?sort=-createdAt&sort=title` — and decode to the same list.
   */
  readonly sort?: boolean | ReadonlyArray<AttributeKeys<R>> | undefined;
  /**
   * Enable `?page[*]=` pagination. Pass one of the {@link Page} strategies or
   * custom `Schema.Struct.Fields` (each key becomes `page[<key>]`). Under the
   * `SchemaErrors` middleware, `?page[…]=` on an endpoint without it, or
   * with no key (`{}`), is a 400 naming it (#261).
   */
  readonly page?: Schema.Struct.Fields | undefined;
  /**
   * Enable `?filter[*]=` filtering. `true` turns on the filter grammar
   * (`docs/filter-grammar.md`) over the resource's declared filterable fields
   * — `filter[f]=v` is `eq`, `filter[f]=a,b` is `in`, `filter[f][gt]=v` any
   * operator, plus the group form for `OR` / `NOT` / nesting — decoding to a
   * {@link FilterAst}; unknown fields, undeclared operators and bad literals
   * produce a 400 naming the key. A single resource only: a heterogeneous
   * endpoint must use the map form.
   *
   * A `Schema.Struct.Fields` map is the open per-key escape hatch for flags
   * JSON:API has no family for: each key becomes `filter[<key>]` and its
   * schema must decode from a string.
   *
   * Under the `SchemaErrors` middleware, `?filter[…]=` on an endpoint
   * without it — or with `true` over a resource with no filterable field, or
   * an empty map — is a 400 naming it (#261).
   */
  readonly filter?: FilterOption | undefined;
}

/**
 * Resource definitions whose sparse fieldsets appear in `?fields[TYPE]=`:
 * every type the endpoint's response can carry, and no other.
 *
 * - The resource(s) themselves.
 * - Their non-`paginated` direct relationship targets, the default
 *   `included` union a server MAY include by default — unless the
 *   endpoint's `include` option `I` is a declared `Include.Surface`, whose
 *   own `included` union replaces that default.
 * - When `I` turns `include` on, every resource a legal include path
 *   reaches: the leaf of each path and every resource on the way to it
 *   (`comments.author` reaches `comments` and `people`). The walk is the
 *   include paths', so it is bounded as they are: two hops under
 *   `include: true`, the `depth` an {@link IncludeOptions} names, or the
 *   exact `paths` of an allow-list or a declared `Include.Surface`.
 * - Every `Resource.family` among those is replaced by its members (and a
 *   member that is itself a family by its own members, in turn): a family's
 *   `type` is its name, never a wire type, so the resource objects a
 *   response carries for it are its members', each under its own type. A
 *   relationship targeting a family over `editors` and `reviewers` declares
 *   `fields[editors]` and `fields[reviewers]`, and not `fields[<family
 *   name>]`, which is a 400 like any undeclared type (#350). A real resource
 *   whose type is the family's name (the base of a base-anchored family,
 *   reached in its own right) is still declared as itself.
 *
 * A type reachable only through a `paginated` relationship is never declared:
 * such a relationship is never an include path, so its target never appears
 * in `included`.
 *
 * Distributes over unions of resource definitions, and over a widened `I`:
 * under `include: boolean` (or a surface-or-`true` union) it is what either
 * value declares, since the endpoint built from that value may have turned
 * `include` on (#397).
 *
 * @since 0.1.0 (`I` and family members since 0.17.0)
 * @category type-level
 */
export type FieldsetResources<R extends Any, I = false> = ExpandFamilies<
  R | (I extends unknown ? IncludedResources<R, I> : never)
>;

/**
 * The wire types a query's `fields` option declares `fields[TYPE]` for:
 * every {@link FieldsetResources} type under `fields: true`, those an
 * allow-list names under an array (`fields: ["comments", "people"]`), and
 * none otherwise — `false`, absent or a widened `boolean`.
 *
 * @since 0.18.0
 * @category type-level
 */
export type FieldsetTypesOf<R extends Any, O extends Options<R>> = [O["fields"]] extends [true]
  ? FieldsetResources<R, O["include"]>["type"]
  : O["fields"] extends ReadonlyArray<infer T>
    ? Extract<FieldsetResources<R, O["include"]>["type"], T>
    : never;

// The nested `fields` member of a query declaring `fields[TYPE]` for `Types`:
// one optional fieldset per type, its vocabulary the fields (attributes and
// relationships, #494) of every definition sharing that wire type (#362); no
// member when `Types` is empty.
type NestedFieldsets<R extends Any, I, Types extends string> = [Types] extends [never]
  ? Record<never, never>
  : {
      readonly fields: Schema.optionalKey<
        Schema.Struct<{
          readonly [TypeName in Types]: Schema.optionalKey<
            Fieldset<FieldKeys<Extract<FieldsetResources<R, I>, { type: TypeName }>>>
          >;
        }>
      >;
    };

/**
 * The nested (decoded) struct fields of a query schema.
 *
 * @since 0.1.0
 * @category type-level
 */
export type NestedFields<R extends Any, O extends Options<R>> = Types.Simplify<
  (IncludeEnabled<O["include"]> extends true
    ? { readonly include: Schema.optionalKey<Include<R, IncludePathsOf<R, O["include"]>>> }
    : Record<never, never>) &
    NestedFieldsets<R, O["include"], FieldsetTypesOf<R, O>> &
    (O["sort"] extends true
      ? { readonly sort: Schema.optionalKey<Sort<AttributeKeys<R>>> }
      : O["sort"] extends ReadonlyArray<string>
        ? { readonly sort: Schema.optionalKey<Sort<O["sort"][number]>> }
        : Record<never, never>) &
    (O["page"] extends Schema.Struct.Fields
      ? { readonly page: Schema.optionalKey<Schema.Struct<O["page"]>> }
      : Record<never, never>) &
    ([O["filter"]] extends [true]
      ? { readonly filter: Schema.optionalKey<FilterAstSchema<R>> }
      : O["filter"] extends Schema.Struct.Fields
        ? { readonly filter: Schema.optionalKey<Schema.Struct<O["filter"]>> }
        : Record<never, never>)
>;

/**
 * The flat (wire) struct fields of a query schema: every parameter is a
 * bracket-keyed string. The grammar's `filter[...]` keys (`filter: true`)
 * are not enumerable and live in the struct's {@link FilterRest} instead;
 * only the bare `filter` key is a field, so that it is rejected, not ignored.
 *
 * @since 0.1.0
 * @category type-level
 */
export type FlatFields<R extends Any, O extends Options<R>> = Types.Simplify<
  (IncludeEnabled<O["include"]> extends true
    ? { readonly include: Schema.optionalKey<Repeatable> }
    : Record<never, never>) & {
    readonly [
      TypeName in FieldsetTypesOf<R, O> as `fields[${TypeName}]`
    ]: Schema.optionalKey<Repeatable>;
  } & (O["sort"] extends true | ReadonlyArray<string>
      ? { readonly sort: Schema.optionalKey<Repeatable> }
      : Record<never, never>) &
    (O["page"] extends Schema.Struct.Fields
      ? {
          readonly [
            K in keyof O["page"] & string as `page[${K}]`
          ]: Schema.optionalKey<Schema.String>;
        }
      : Record<never, never>) &
    ([O["filter"]] extends [true]
      ? { readonly filter: Schema.optionalKey<FilterWireValueSchema> }
      : O["filter"] extends Schema.Struct.Fields
        ? {
            readonly [
              K in keyof O["filter"] & string as `filter[${K}]`
            ]: Schema.optionalKey<Schema.String>;
          }
        : Record<never, never>)
>;

// Resolves to `T` for every concrete query configuration; needed because the
// conditional intersections above can't be proven to satisfy `Struct.Fields`
// while `O` is still generic.
type AsFields<T> = T extends Schema.Struct.Fields ? T : never;

/**
 * The flat (wire) schema of a query: the bracket-keyed struct of
 * {@link FlatFields}, extended with the {@link FilterRest} index signature
 * when `filter: true` is on.
 *
 * @since 0.13.0
 * @category type-level
 */
export type FlatSchema<R extends Any, O extends Options<R>> = [O["filter"]] extends [true]
  ? Schema.StructWithRest<Schema.Struct<AsFields<FlatFields<R, O>>>, readonly [FilterRestSchema]>
  : Schema.Struct<AsFields<FlatFields<R, O>>>;

/**
 * The full query schema for a resource and feature set: a flat, bracket-keyed
 * string record on the wire, an ergonomic nested shape when decoded.
 *
 * @since 0.1.0
 * @category models
 */
export interface QuerySchema<R extends Any, O extends Options<R>> extends Schema.decodeTo<
  Schema.Struct<AsFields<NestedFields<R, O>>>,
  FlatSchema<R, O>,
  never,
  never
> {}

// The runtime `FieldsetTypesOf`, as the resource definitions behind each
// type: every `fieldsetResources` target under `fields: true`, those whose
// type an allow-list names under an array, none otherwise. An allow-list
// naming a type no target has is a programmer error, so it throws.
const fieldsetTargetsOf = (
  resources: ReadonlyArray<Any>,
  includable: ReadonlyArray<string>,
  fields: Options<Any>["fields"],
  include?: IncludeArgument,
): ReadonlyArray<Any> => {
  if (fields === undefined || fields === false) return [];
  const targets = fieldsetResources(resources, includable, include);
  if (fields === true) return targets;
  const unknown = fields.filter((type) => !targets.some((target) => target.type === type));
  if (Arr.isReadonlyArrayNonEmpty(unknown)) {
    // oxlint-disable-next-line effect/avoid-untagged-errors -- a construction-time programmer error, thrown while the api is declared, never an Effect failure
    throw new Error(
      `Query.schema: \`fields\` names ${unknown.map((type) => `"${type}"`).join(", ")}, ` +
        `which the endpoint's response cannot carry; it can carry ${targets.map((target) => `"${target.type}"`).join(", ")}`,
    );
  }
  return targets.filter((target) => fields.includes(target.type));
};

/**
 * Builds the query schema for a resource (or, for heterogeneous endpoints,
 * several resources) and a feature set.
 *
 * The result is passed as an `HttpApiEndpoint` `query` schema; handlers
 * receive the decoded nested shape, clients provide it and it is encoded back
 * to flat query parameters.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 *
 * const query = Query.schema(Article, {
 *   include: true,
 *   fields: true,
 *   sort: true,
 *   page: Query.Page.Offset,
 *   filter: { author: Schema.String }
 * })
 *
 * // handlers receive the decoded nested shape
 * Schema.decodeUnknownSync(query)({ "page[offset]": "20", "page[limit]": "10" })
 * // → { page: { offset: 20, limit: 10 } }
 *
 * // `filter: true` — the filter grammar over the resource's declaration
 * const Product = Resource.make("products", {
 *   attributes: { priceCents: Resource.attribute(Schema.Int, { filter: true }) }
 * })
 * const filtered = Query.schema(Product, { filter: true, page: Query.Page.Offset })
 * Schema.decodeUnknownSync(filtered)({ "filter[priceCents][lt]": "1000", "page[limit]": "10" })
 * // → { filter: { _tag: "Compare", op: "lt", field: "priceCents", value: 1000 }, page: { limit: 10 } }
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const schema = <R extends Any, const O extends Options<R>>(
  resource: R | ReadonlyArray<R>,
  options: O,
): QuerySchema<R, O> => {
  const resources = toResources(resource);
  const nestedFields: Record<string, Schema.Top> = {};
  const flatFields: Record<string, Schema.Top> = {};

  const include = options.include;
  // The include paths the endpoint legalises; none while `include` is off.
  let includable: ReadonlyArray<string> = [];
  if (include === true || typeof include === "object") {
    const includeOptions = (typeof include === "object" ? include : undefined) as never;
    includable = includePathsFor(resources, includeOptions);
    // The paths are computed once: `Include` takes them as an allow-list,
    // which legalises exactly the same set.
    nestedFields.include = Schema.optionalKey(
      Include<Any, { readonly paths: ReadonlyArray<string> }>(resources, { paths: includable }),
    );
    flatFields.include = Schema.optionalKey(Repeatable);
  }

  const fieldsetTargets = fieldsetTargetsOf(resources, includable, options.fields, include);
  if (Arr.isReadonlyArrayNonEmpty(fieldsetTargets)) {
    // The resources, then every type their response can carry in `included`:
    // the runtime mirror of `FieldsetResources`, which the default document
    // of an endpoint declaring `fields` makes partial over (#322) — or those
    // of them an allow-list names (`FieldsetTypesOf`, #485). Definitions
    // sharing a wire type share its `fields[TYPE]`, whose vocabulary is the
    // union of their fields — attributes and relationships (#494) — as
    // `NestedFields` types it (#362).
    const fieldsetFields = Rec.map(
      Arr.groupBy(fieldsetTargets, (target) => target.type),
      (targets, type) =>
        Schema.optionalKey(fieldsetOf(type, dedupe(targets.flatMap((t) => fieldKeys(t))))),
    );
    Object.assign(
      flatFields,
      Rec.mapEntries(fieldsetFields, (_, type) => [
        `fields[${type}]`,
        Schema.optionalKey(Repeatable),
      ]),
    );
    nestedFields.fields = Schema.optionalKey(Schema.Struct(fieldsetFields));
  }

  if (
    options.sort === true ||
    (Array.isArray(options.sort) && Arr.isReadonlyArrayNonEmpty(options.sort))
  ) {
    const sortable =
      options.sort === true
        ? dedupe(resources.flatMap((r) => attributeKeys(r)))
        : (options.sort as ReadonlyArray<string>);
    nestedFields.sort = Schema.optionalKey(Sort(sortable));
    flatFields.sort = Schema.optionalKey(Repeatable);
  }

  if (options.page !== undefined) {
    nestedFields.page = Schema.optionalKey(Schema.Struct(options.page));
    for (const key of Object.keys(options.page)) {
      flatFields[`page[${key}]`] = Schema.optionalKey(Schema.String);
    }
  }

  // The grammar's field declaration, when `filter: true` is on.
  let filterFields: FieldCodecs | undefined;
  if (options.filter === true) {
    if (resources.length !== 1) {
      throw new Error(
        "Query.schema: `filter: true` derives the filter grammar from one resource's declaration; " +
          "a heterogeneous endpoint (several resources) must use the per-key `filter: { … }` map instead",
      );
    }
    filterFields = filterable(resources[0]!) as FieldCodecs;
    // The grammar's filterable fields ride on the decoded tree's schema as
    // the `filter` vocabulary, so `Middleware`'s support check treats
    // `filter: true` over a resource with no filterable field as unsupported
    // (#261). The grammar's own rejections already name the field.
    nestedFields.filter = Schema.optionalKey(
      AstSchema.annotate(
        vocabularyAnnotation({
          family: "filter",
          values: Rec.keys<string, FieldCodec>(filterFields),
        }),
      ),
    );
    // The bare `filter` key is malformed under the grammar; declared here so
    // it reaches the grammar's rejection rather than being dropped.
    flatFields.filter = Schema.optionalKey(FilterWireValue);
  } else if (typeof options.filter === "object") {
    nestedFields.filter = Schema.optionalKey(Schema.Struct(options.filter));
    for (const key of Object.keys(options.filter)) {
      flatFields[`filter[${key}]`] = Schema.optionalKey(Schema.String);
    }
  }

  const flatStruct = Schema.Struct(flatFields);
  const flat =
    filterFields === undefined ? flatStruct : Schema.StructWithRest(flatStruct, [FilterRest]);
  const nested = Schema.Struct(nestedFields);
  const fields = filterFields;

  type Values = { readonly [x: string]: unknown };
  // A struct with no fields is effect's `{}`: it accepts any object and hands
  // it on *unchanged*, where a struct with fields drops the keys it doesn't
  // declare. So an endpoint whose query declares nothing would pass every
  // parameter through to the handler (typed `{}`) and into `nest`. Keeping
  // only the declared keys makes the empty case drop them too (#260); with
  // fields it is a no-op, the struct having dropped the rest already.
  const declaredOnly = (values: Values): Values =>
    Rec.filter(values, (_, key) => Rec.has(flatFields, key));
  return flat.pipe(
    Schema.decodeTo(
      nested,
      fields === undefined
        ? SchemaTransformation.transform<Values, Values>({
            decode: (flatValues) => nest(declaredOnly(flatValues)),
            encode: (nestedValues) => declaredOnly(flatten(nestedValues)),
          })
        : // `filter[...]` keys are routed to the grammar ahead of the one-level
          // bracket reshaper, so `page[*]` / `fields[*]` are untouched.
          SchemaTransformation.transformEffect<Values, Values>({
            decode: (flatValues, parseOptions) => {
              // The flat struct has already decoded every `filter[...]` key
              // (and the bare `filter`) as a `FilterWireValue`.
              const filterKeys = Rec.filter(
                flatValues,
                (value, key): value is FilterWireValue =>
                  isFilterKey(key) && isFilterWireValue(value),
              );
              const others = Rec.filter(flatValues, (_, key) => !isFilterKey(key));
              const nestedValues = nest(others);
              if (Rec.isEmptyRecord(filterKeys)) return Effect.succeed(nestedValues);
              return Effect.map(
                decodeFilterRecord(fields, flat.ast, filterKeys, parseOptions),
                (filter) => ({
                  ...nestedValues,
                  filter,
                }),
              );
            },
            encode: (nestedValues, parseOptions) => {
              const { filter, ...others } = nestedValues;
              const flatValues = flatten(others);
              if (filter === undefined) return Effect.succeed(flatValues);
              return Effect.map(
                encodeFilterNode(fields, filter as Node, parseOptions),
                (pairs) => ({
                  ...flatValues,
                  ...pairs,
                }),
              );
            },
          }),
    ),
  ) as unknown as QuerySchema<R, O>;
};

// ---------------------------------------------------------------------------
// The canonical query string
// ---------------------------------------------------------------------------

/**
 * One flat `(key, value)` query pair, both sides un-encoded — what
 * {@link canonicalPairs} produces and {@link serialise} consumes.
 *
 * @since 0.13.0
 * @category models
 */
export type Pair = CanonicalPair;

/**
 * A query schema {@link canonical} accepts: any codec whose encoded (wire)
 * side is a flat, string-keyed record and whose encoder needs no services —
 * a {@link schema} result, or a consumer's own flat query struct
 * ({@link bracketPageKeys}, say).
 *
 * Each encoded value must have a wire form that decodes back through the
 * same schema: a string, or something `String()` renders faithfully (a
 * number, a boolean). An array is emitted as the repeated key, one pair per
 * item (`tag=a&tag=b`, which `UrlParams.toRecord` decodes back to an
 * array), except `include`, whose comma form is its own encoding. `null`
 * has no wire form and is omitted, like `undefined` — a nullable field
 * round-trips only if its schema decodes an absent key to `null`.
 *
 * @since 0.13.0
 * @category models
 */
export interface FlatQuerySchema extends Schema.Codec<
  unknown,
  { readonly [key: string]: unknown },
  unknown,
  never
> {}

/**
 * Serialises ordered query pairs to a query string (no leading `?`): every
 * key and value RFC 3986 percent-encoded with `encodeURIComponent` — spaces
 * are `%20`, never `+`; commas `%2C` — except that `[` and `]` are left
 * readable in keys, and pairs joined with `&`. The result is what
 * `Handlers.offsetPaginationLinks` and its siblings emit:
 * `page[offset]=0&page[limit]=10`.
 *
 * Commas are encoded even where they separate a list (`include=a%2Cb`,
 * `filter[f]=a%2Cb`) and where the filter grammar escapes one (`\,` is
 * `%5C%2C`): the encoding is uniform and `URLSearchParams` / `UrlParams`
 * decode it back to the same record byte for byte, so the string decodes
 * through the same query schema.
 *
 * @example
 * ```ts
 * import { Query } from "@thomasfosterau/effect-jsonapi"
 *
 * Query.serialise([
 *   ["include", "author,comments"],
 *   ["filter[title]", "Hello, world"],
 *   ["page[offset]", "0"]
 * ])
 * // → "include=author%2Ccomments&filter[title]=Hello%2C%20world&page[offset]=0"
 * ```
 *
 * @since 0.13.0
 * @category utils
 */
export const serialise: (pairs: Iterable<Pair>) => string = serialisePairs;

/**
 * The canonically ordered flat pairs of a decoded query — {@link canonical}
 * before serialisation, for callers that assemble the string themselves
 * (the pagination link builders take these as their `query` option and slot
 * the page cursor in).
 *
 * The query is encoded through `schema`, then its pairs are ordered by one
 * rule:
 *
 * 1. `include`
 * 2. `fields[*]`, sorted by type (code-point order)
 * 3. `filter[*]`, in the filter grammar's canonical order (`docs/filter-grammar.md`
 *    §3.3): shorthand keys sorted by key (code-point order), which is also
 *    how the per-key `filter: { … }` escape hatch is ordered; the group form
 *    in the encoder's pre-order, whose ids are meaningful and never re-sorted
 * 4. `sort`
 * 5. `page[*]`, in the order the page strategy declares its keys — `offset,
 *    limit` / `number, size` / `cursor, size` — the order the pagination link
 *    builders emit, so a `self` link and the canonical string agree
 * 6. any other key (a consumer's own flat schema), sorted by key
 *
 * An absent (`undefined` or `null`) value is omitted, an empty string is
 * kept (`key=`), and an array is the repeated key, one pair per item in
 * order (`include` excepted: its comma form) — see {@link FlatQuerySchema}.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 * const query = Query.schema(Article, { fields: true, sort: true, page: Query.Page.Offset })
 *
 * Query.canonicalPairs(query)({
 *   page: { limit: 10, offset: 0 },
 *   sort: [{ field: "title", direction: "desc" }],
 *   fields: { articles: ["title"] }
 * })
 * // → [["fields[articles]", "title"], ["sort", "-title"], ["page[offset]", "0"], ["page[limit]", "10"]]
 * ```
 *
 * @since 0.13.0
 * @category utils
 */
export const canonicalPairs = <S extends FlatQuerySchema>(
  schema: S,
): ((decoded: S["Type"]) => ReadonlyArray<Pair>) => {
  const encode = Schema.encodeSync(schema);
  const declared = declaredKeys(schema.ast);
  return (decoded) => orderPairs(encode(decoded) as FlatQuery, declared);
};

/**
 * The canonical query string of a decoded query: encoded through `schema`,
 * ordered by {@link canonicalPairs}'s one rule (`include`, `fields[*]`,
 * `filter[*]`, `sort`, `page[*]`, then anything else) and serialised by
 * {@link serialise}.
 *
 * Two decoded queries that are equal produce byte-identical strings whatever
 * the wire spelling they came from — key order, `?include=a&include=b`
 * against `?include=a,b`, `filter[f][eq]=v` against `filter[f]=v` — and the
 * string decodes back to the same query through the same schema (an array
 * value is the repeated key, `null` is omitted; see {@link FlatQuerySchema}).
 * It is what a collection document's `self` link carries (JSON:API 1.1
 * requires the query parameters the client provided) and a stable identity
 * for a query: a subscription, a cache tag. A paginated `self` link also
 * carries the page defaults the server applied — the effective page window —
 * see `Handlers.offsetPaginationLinks`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: {
 *     title: Schema.NonEmptyString,
 *     status: Resource.attribute(Schema.Literals(["open", "done"]), { filter: true })
 *   }
 * })
 * const query = Query.schema(Article, { fields: true, sort: true, page: Query.Page.Offset, filter: true })
 * const canonical = Query.canonical(query)
 *
 * canonical({
 *   page: { limit: 10, offset: 0 },
 *   filter: { _tag: "Compare", op: "eq", field: "status", value: "open" },
 *   sort: [{ field: "title", direction: "desc" }]
 * })
 * // → "filter[status]=open&sort=-title&page[offset]=0&page[limit]=10"
 *
 * // the same query decoded from any spelling canonicalises identically
 * const decoded = Schema.decodeUnknownSync(query)({
 *   "page[limit]": "10",
 *   sort: "-title",
 *   "filter[status][eq]": "open",
 *   "page[offset]": "0"
 * })
 * canonical(decoded)
 * // → "filter[status]=open&sort=-title&page[offset]=0&page[limit]=10"
 * ```
 *
 * @since 0.13.0
 * @category utils
 */
export const canonical = <S extends FlatQuerySchema>(
  schema: S,
): ((decoded: S["Type"]) => string) => {
  const pairs = canonicalPairs(schema);
  return (decoded) => serialisePairs(pairs(decoded));
};
