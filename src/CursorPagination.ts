/**
 * The [Cursor Pagination profile](https://jsonapi.org/profiles/ethanresnick/cursor-pagination/):
 * its `page[size]` / `page[after]` / `page[before]` parameters, its errors, its
 * `meta.page` members and its required `prev` / `next` links.
 *
 * @since 0.23.0
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ApiError from "./ApiError.js";
import type { LinksValue } from "./Handlers.js";
import type { Pair } from "./Query.js";
import { serialise, withPagePairs } from "./internal/canonical.js";

/**
 * The profile's URI, as the profile names itself. Pass it in an endpoint's
 * `profiles` option to advertise the profile on the response media type.
 *
 * @since 0.23.0
 * @category constants
 */
export const PROFILE_URI = "http://jsonapi.org/profiles/ethanresnick/cursor-pagination/";

const errorType = (name: string): string =>
  `https://jsonapi.org/profiles/ethanresnick/cursor-pagination/${name}`;

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * `page[size]` as the profile spells it: a base-10 positive integer
 * (`^[0-9]+$`, so `1e2`, `+5` and `0` are refused). A refused value is the
 * profile's "invalid parameter value" error, which the query decoding answers
 * as a 400 naming `page[size]`.
 *
 * @since 0.23.0
 * @category schemas
 */
export const Size = Schema.String.check(Schema.isPattern(/^[0-9]+$/)).pipe(
  Schema.decodeTo(Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThan(0))),
);

/**
 * The decoded type of {@link Size}.
 *
 * @since 0.23.0
 * @category models
 */
export type Size = typeof Size.Type;

/**
 * The page fields {@link page} returns: each `page[*]` member optional, since
 * the profile lets a client send any of them.
 *
 * @since 0.23.0
 * @category models
 */
export type PageFields = {
  readonly size: Schema.optionalKey<typeof Size>;
  readonly after: Schema.optionalKey<Schema.String>;
  readonly before: Schema.optionalKey<Schema.String>;
};

/**
 * The profile's `page` query fields, for an endpoint's `page` option:
 * `page[size]`, `page[after]` and `page[before]`. The size cap, the default
 * size and range support are the server's to apply, with {@link resolve}.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { CursorPagination, Endpoint, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", { attributes: { title: Schema.String } })
 *
 * Endpoint.list(Article, {
 *   page: CursorPagination.page(),
 *   profiles: [CursorPagination.PROFILE_URI]
 * })
 * ```
 *
 * @since 0.23.0
 * @category constructors
 */
export const page = (): PageFields => ({
  size: Schema.optionalKey(Size),
  after: Schema.optionalKey(Schema.String),
  before: Schema.optionalKey(Schema.String),
});

/**
 * An endpoint's paging limits under the profile.
 *
 * @since 0.23.0
 * @category models
 */
export interface Options {
  /** The largest `page[size]` the endpoint serves. Omit for no cap. */
  readonly maxSize?: number;
  /**
   * The size of a page when the client sends no `page[size]`: between 1 and
   * `maxSize`. Required, since the profile requires the server to pick one.
   */
  readonly defaultSize: number;
  /**
   * Whether the endpoint serves range requests (`page[after]` with
   * `page[before]`). Default `false`: a range request is answered with
   * {@link RangePaginationNotSupported}.
   */
  readonly range?: boolean;
}

/**
 * A request's page as the handler pages it: the size the server applies and
 * the cursors the client sent.
 *
 * @since 0.23.0
 * @category models
 */
export interface Page {
  readonly size: number;
  readonly after: Option.Option<string>;
  readonly before: Option.Option<string>;
}

/**
 * Resolves a decoded `page` against the endpoint's {@link Options}: the size
 * to apply (the client's, the default, or under a range request with no size
 * the `maxSize`) and the cursors. Fails with {@link MaxSizeExceeded} for a
 * size over `maxSize`, and {@link RangePaginationNotSupported} for a range
 * request the endpoint doesn't serve.
 *
 * @example
 * ```ts
 * import { Effect, Option } from "effect"
 * import { CursorPagination } from "@thomasfosterau/effect-jsonapi"
 * import { deepStrictEqual } from "node:assert"
 *
 * const page = Effect.runSync(
 *   CursorPagination.resolve({ after: "abc" }, { maxSize: 50, defaultSize: 10 })
 * )
 * deepStrictEqual(page, { size: 10, after: Option.some("abc"), before: Option.none() })
 * ```
 *
 * @since 0.23.0
 * @category utils
 */
export const resolve = (
  requested: {
    readonly size?: number;
    readonly after?: string;
    readonly before?: string;
  },
  options: Options,
): Effect.Effect<Page, MaxSizeExceeded | RangePaginationNotSupported> => {
  const after = Option.fromUndefinedOr(requested.after);
  const before = Option.fromUndefinedOr(requested.before);
  const isRange = Option.isSome(after) && Option.isSome(before);
  if (isRange && options.range !== true) return Effect.fail(new RangePaginationNotSupported());
  const maxSize = Option.fromUndefinedOr(options.maxSize);
  const exceeded = Option.filter(
    maxSize,
    (max) => requested.size !== undefined && requested.size > max,
  );
  if (Option.isSome(exceeded)) {
    return Effect.fail(new MaxSizeExceeded({ maxSize: exceeded.value }));
  }
  const size =
    requested.size ??
    (isRange ? Option.getOrElse(maxSize, () => options.defaultSize) : options.defaultSize);
  return Effect.succeed({ size, after, before });
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * 400: the client asked for a `page[size]` over the endpoint's maximum. The
 * error object carries the profile's `links.type`, `source.parameter:
 * "page[size]"` and `meta.page.maxSize`.
 *
 * @since 0.23.0
 * @category errors
 */
export class MaxSizeExceeded extends ApiError.make<MaxSizeExceeded>()("MaxSizeExceeded", {
  status: 400,
  code: "max-size-exceeded",
  title: "Page size requested is too large.",
  fields: { maxSize: Schema.Int },
  detail: (e) => `You requested a size larger than ${e.maxSize}, the largest this endpoint serves.`,
  source: { parameter: "page[size]" },
  links: { type: errorType("max-size-exceeded") },
  meta: (e) => ({ page: { maxSize: e.maxSize } }),
  fromMeta: (meta) => ({
    maxSize: Schema.is(Schema.Struct({ maxSize: Schema.Int }))(meta["page"])
      ? meta["page"].maxSize
      : undefined,
  }),
}) {}

/**
 * 400: the endpoint can't paginate the requested `sort` efficiently. The error
 * object carries the profile's `links.type` and `source.parameter: "sort"`.
 *
 * @since 0.23.0
 * @category errors
 */
export class UnsupportedSort extends ApiError.make<UnsupportedSort>()("UnsupportedSort", {
  status: 400,
  code: "unsupported-sort",
  title: "Unsupported sort.",
  detail: "This endpoint can't paginate the requested sort order.",
  source: { parameter: "sort" },
  links: { type: errorType("unsupported-sort") },
}) {}

/**
 * 400: the client sent both `page[after]` and `page[before]` to an endpoint
 * that doesn't serve range requests. The error object carries the profile's
 * `links.type`.
 *
 * @since 0.23.0
 * @category errors
 */
export class RangePaginationNotSupported extends ApiError.make<RangePaginationNotSupported>()(
  "RangePaginationNotSupported",
  {
    status: 400,
    code: "range-pagination-not-supported",
    title: "Range pagination not supported.",
    detail: "This endpoint doesn't serve page[after] together with page[before].",
    source: { parameter: "page[before]" },
    links: { type: errorType("range-pagination-not-supported") },
  },
) {}

/**
 * 400: a cursor the server can't read. The profile's "invalid parameter value"
 * error, which names the parameter in `source` and defines no `links.type`.
 * A malformed `page[size]` gets the same answer from the query decoding.
 *
 * @since 0.23.0
 * @category errors
 */
export class InvalidCursor extends ApiError.make<InvalidCursor>()("InvalidCursor", {
  status: 400,
  code: "invalid-parameter-value",
  title: "Invalid parameter value.",
  fields: { parameter: Schema.Literals(["page[after]", "page[before]"]) },
  detail: (e) => `${e.parameter} is not a cursor this endpoint issued.`,
  source: (e) => ({ parameter: e.parameter }),
}) {}

/**
 * The profile's errors, for an endpoint's `error` option.
 *
 * @since 0.23.0
 * @category errors
 */
export const Errors = [
  MaxSizeExceeded,
  UnsupportedSort,
  RangePaginationNotSupported,
  InvalidCursor,
] as const;

// ---------------------------------------------------------------------------
// Document members
// ---------------------------------------------------------------------------

/**
 * The profile's `meta.page` on a paginated collection: an exact `total`, an
 * `estimatedTotal.bestGuess`, and `rangeTruncated` on a range response that
 * had more matches than the page size.
 *
 * @since 0.23.0
 * @category schemas
 */
export const CollectionMeta = Schema.Struct({
  page: Schema.Struct({
    total: Schema.optionalKey(Schema.Int),
    estimatedTotal: Schema.optionalKey(
      Schema.Struct({ bestGuess: Schema.optionalKey(Schema.Int) }),
    ),
    rangeTruncated: Schema.optionalKey(Schema.Literal(true)),
  }),
});

/**
 * The decoded type of {@link CollectionMeta}.
 *
 * @since 0.23.0
 * @category models
 */
export type CollectionMeta = typeof CollectionMeta.Type;

/**
 * The profile's `meta.page` on each paginated item: the cursor that falls on
 * it.
 *
 * @since 0.23.0
 * @category schemas
 */
export const ItemMeta = Schema.Struct({
  page: Schema.Struct({ cursor: Schema.String }),
});

/**
 * The decoded type of {@link ItemMeta}.
 *
 * @since 0.23.0
 * @category models
 */
export type ItemMeta = typeof ItemMeta.Type;

/**
 * An item's `meta` carrying its cursor (see {@link ItemMeta}), for
 * `Handlers.withMeta` or a resource's own `meta`.
 *
 * @since 0.23.0
 * @category constructors
 */
export const itemMeta = (cursor: string): ItemMeta => ({ page: { cursor } });

/**
 * What {@link links} needs to know about the page the handler served.
 *
 * @since 0.23.0
 * @category models
 */
export interface Served {
  /** The cursor of the page's first item; `Option.none()` for an empty page. */
  readonly first: Option.Option<string>;
  /** The cursor of the page's last item; `Option.none()` for an empty page. */
  readonly last: Option.Option<string>;
  /**
   * Whether items precede the page: `Option.some(false)` makes `prev` `null`,
   * `Option.none()` (unknown) still links it, as the profile allows.
   */
  readonly hasPrev: Option.Option<boolean>;
  /** Whether items follow the page, read as `hasPrev` is. */
  readonly hasNext: Option.Option<boolean>;
}

/**
 * The profile's pagination links: `prev` (`page[before]` the first item's
 * cursor) and `next` (`page[after]` the last item's), each `null` when the
 * server knows there is no such page, and `self` for the page served.
 *
 * Without `page[before]` the profile requires the server to know whether a
 * next page exists, and without `page[after]` whether a previous one does;
 * pass `Option.some` for those. Pass the request's canonical pairs as `query`
 * and every link carries them, as `Handlers.offsetPaginationLinks` does.
 *
 * @example
 * ```ts
 * import { Option } from "effect"
 * import { CursorPagination } from "@thomasfosterau/effect-jsonapi"
 * import { deepStrictEqual } from "node:assert"
 *
 * const links = CursorPagination.links(
 *   "/articles",
 *   { size: 2, after: Option.none(), before: Option.none() },
 *   { first: Option.some("a1"), last: Option.some("a2"), hasPrev: Option.some(false), hasNext: Option.some(true) }
 * )
 * deepStrictEqual(links, {
 *   self: "/articles?page[size]=2",
 *   prev: null,
 *   next: "/articles?page[size]=2&page[after]=a2"
 * })
 * ```
 *
 * @since 0.23.0
 * @category constructors
 */
export const links = (
  path: string,
  page: Page,
  served: Served,
  options?: { readonly query?: ReadonlyArray<Pair> },
): LinksValue => {
  const link = (pairs: ReadonlyArray<Pair>): string => {
    const query = serialise(withPagePairs(options?.query ?? [], pairs));
    return query === "" ? path : `${path}${path.includes("?") ? "&" : "?"}${query}`;
  };
  const size: Pair = ["page[size]", String(page.size)];
  const cursorPairs = Arr.getSomes([
    Option.map(page.after, (after): Pair => ["page[after]", after]),
    Option.map(page.before, (before): Pair => ["page[before]", before]),
  ]);
  const toward = (
    known: Option.Option<boolean>,
    cursor: Option.Option<string>,
    parameter: "page[after]" | "page[before]",
  ): Exclude<LinksValue["next"], undefined> =>
    Option.exists(known, (exists) => !exists)
      ? null
      : Option.match(cursor, {
          onNone: () => null,
          onSome: (value) => link([size, [parameter, value]]),
        });
  // An empty page has no items to take a cursor from, so it links from the
  // request's own cursor: what precedes `page[after]=x` is `page[before]=x`.
  return {
    self: link([size, ...cursorPairs]),
    prev: toward(
      served.hasPrev,
      Option.orElse(served.first, () => page.after),
      "page[before]",
    ),
    next: toward(
      served.hasNext,
      Option.orElse(served.last, () => page.before),
      "page[after]",
    ),
  };
};
