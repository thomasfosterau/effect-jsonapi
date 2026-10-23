/**
 * Server-side document builders.
 *
 * Handlers return values matching their endpoint's document schema. These
 * helpers assemble those values while enforcing the spec's compound-document
 * rules at runtime:
 *
 *   - `included` resources are deduplicated by `(type, id)`, against each
 *     other and against the primary data — a compound document carries one
 *     resource object per `(type, id)` pair
 *   - full linkage: every included resource must be reachable from the
 *     primary data by following resource linkage — the primary data's
 *     relationships, then other included resources' relationships
 *
 * `included` keeps the request's shape: an array — even one that is empty, or
 * that dedup against the primary data empties — emits the member, because a
 * response to a request carrying `include` MUST be a compound document with
 * an `included` key, "even if that `included` key holds an empty array"
 * (JSON:API 1.1 §Fetching Includes). Pass `undefined` when the request carried
 * no `include`, and the member is omitted.
 *
 * They also take an `onResource` hook — a per-resource transform run **once
 * per resource, in every slot**: the primary `data`, every deduplicated
 * `included` member, and the identifiers of a linkage document. That is what
 * makes sparse fieldsets (`project`) and computed per-viewer `meta`
 * (`withMeta`) uniform: a document cannot come out describing one resource
 * type two different ways depending on where it landed.
 *
 * ```ts skip-type-checking
 * handlers.handle("fetch", ({ params, query }) =>
 *   loadArticle(params.id).pipe(Effect.map((article) =>
 *     data(article, {
 *       // `undefined` without `?include=`; `[]` when it names nothing to load
 *       included: query.include === undefined ? undefined : query.include.includes("author") ? [author] : [],
 *       self: `/articles/${article.id}`
 *     })
 *   ))
 * )
 * ```
 *
 * {@link resolveIncluded} is the other half — the walk that *produces*
 * `included` from the paths the client requested, one batched level at a time,
 * so a compound document costs one query per resource type per hop rather than
 * one per reference.
 *
 * @since 0.1.0
 */
import { Array as Arr, Effect, HashMap, HashSet, Option, Record as Rec } from "effect";
import type { JsonApiObject } from "./Document.js";
import { serialise, withPagePairs } from "./internal/canonical.js";
import { assign } from "./internal/define.js";
import { isLinkageData, reachable, seeds } from "./internal/linkage.js";
import type { Pair } from "./Query.js";

/**
 * The top-level `jsonapi` object *value* (`{ version?, ext?, profile?, meta? }`).
 *
 * @since 0.3.0
 * @category models
 */
export type JsonApiObjectValue = typeof JsonApiObject.Type;

// ---------------------------------------------------------------------------
// Identifiable resources (the runtime shape builders work with)
// ---------------------------------------------------------------------------

/**
 * The minimal runtime shape of a resource object value.
 *
 * Relationship objects either carry inline linkage (`data`) or — for
 * paginated relationships — only `links` / `meta`.
 *
 * @since 0.1.0
 * @category models
 */
export interface ResourceValue {
  readonly type: string;
  readonly id: string;
  readonly relationships?: {
    readonly [key: string]: {
      readonly data?: ResourceIdentifierValue | ReadonlyArray<ResourceIdentifierValue> | null;
      readonly links?: unknown;
      readonly meta?: unknown;
    };
  };
}

/**
 * The minimal runtime shape of a resource identifier value.
 *
 * @since 0.1.0
 * @category models
 */
export interface ResourceIdentifierValue {
  readonly type: string;
  readonly id: string;
}

/**
 * A link value: either a URL string or a link object.
 *
 * @since 0.1.0
 * @category models
 */
export type LinkValue = string | { readonly href: string };

/**
 * Top-level links accepted by the document builders.
 *
 * @since 0.1.0
 * @category models
 */
export interface LinksValue {
  readonly self?: LinkValue;
  readonly related?: LinkValue;
  readonly describedby?: LinkValue;
  readonly first?: LinkValue | null;
  readonly last?: LinkValue | null;
  readonly prev?: LinkValue | null;
  readonly next?: LinkValue | null;
}

/**
 * Free-form meta values accepted by the document builders.
 *
 * @since 0.1.0
 * @category models
 */
export type MetaValue = { readonly [key: string]: unknown };

// Simplifies intersections for readable hover types.
type Simplify<T> = { readonly [K in keyof T]: T[K] } extends infer S ? S : never;

// ---------------------------------------------------------------------------
// Per-resource transforms
// ---------------------------------------------------------------------------

/**
 * The widest resource-object shape a transform sees: {@link ResourceValue}
 * plus the optional members transforms read and write.
 *
 * A transform is handed every resource the document carries, whatever its
 * type, so this is deliberately the *union* of what a resource object may
 * hold rather than any one resource's shape. Switch on `type` to narrow.
 *
 * @since 0.15.0
 * @category models
 */
export interface AnyResourceValue extends ResourceValue {
  readonly attributes?: { readonly [key: string]: unknown };
  readonly meta?: MetaValue;
  readonly links?: unknown;
}

/**
 * The type-level half of a {@link ResourceTransform}: what the transform does
 * to the type of any resource it is applied to.
 *
 * A transform is applied at more than one type in a single document — the
 * primary resource, each `included` member, each identifier of a linkage
 * document — so its effect on the output type cannot be a single inferred
 * return type. It is written instead as a *type-level function*: an interface
 * whose `Out` member is computed from `this["In"]`, the resource the transform
 * is being applied to, and applied with {@link Transformed}.
 *
 * @since 0.15.0
 * @category type-level
 */
export interface TransformLambda {
  readonly In: unknown;
  readonly Out: unknown;
}

/**
 * Applies a {@link TransformLambda} to one resource type — the type-level
 * counterpart of calling the transform.
 *
 * @since 0.15.0
 * @category type-level
 */
export type Transformed<F extends TransformLambda, R> = (F & { readonly In: R })["Out"];

/**
 * The {@link TransformLambda} of a transform that leaves the type alone —
 * what a hand-written `(resource) => resource` function is, and the default
 * when no `onResource` is given.
 *
 * @since 0.15.0
 * @category type-level
 */
export interface IdentityLambda extends TransformLambda {
  readonly Out: this["In"];
}

/**
 * A per-resource transform: the `onResource` hook the document builders apply,
 * once, to every resource object the document carries.
 *
 * It is a *polymorphic* function — one transform, applied at every type in the
 * document — whose effect on each output type is computed by its
 * {@link TransformLambda}. That is what keeps the builders' return type
 * precise: `Handlers.data(article, { onResource: Handlers.project({ articles: ["title"] }) })`
 * has a `data.attributes` of `{ title: string }`, and an `included` of
 * articles projected the same way, rather than a widened `ResourceValue`.
 *
 * Build one with {@link project}, {@link withMeta}, {@link compose} or
 * {@link transform}. A plain function is accepted too, and is checked against
 * the default {@link IdentityLambda}: it must return the resource's own type,
 * which is exactly the guarantee a shape-preserving transform makes.
 *
 * Transforms must be pure functions of the resource they are given: the
 * builders run one at most once per `(type, id)` per document, and reuse that
 * result wherever else the resource appears.
 *
 * @since 0.15.0
 * @category models
 */
export interface ResourceTransform<F extends TransformLambda = IdentityLambda> {
  <R extends ResourceValue>(resource: R): Transformed<F, R>;
}

/**
 * Builds a {@link ResourceTransform} from a runtime function and an explicit
 * {@link TransformLambda} — the escape hatch for per-resource processing the
 * package's own transforms don't cover.
 *
 * The lambda is the promise the function must keep; it is not checked against
 * the implementation, so declare the one the function actually delivers.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Handlers, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", { attributes: { title: Schema.NonEmptyString } })
 * const article = Article.make({ id: Article.Id.make("1"), attributes: { title: "Hi" } })
 *
 * // the type-level half: what this transform does to every resource it sees
 * interface SelfLinkLambda extends Handlers.TransformLambda {
 *   readonly Out: this["In"] & { readonly links: { readonly self: string } }
 * }
 *
 * const withSelfLink = Handlers.transform<SelfLinkLambda>((resource) => ({
 *   ...resource,
 *   links: { self: `/${resource.type}/${resource.id}` }
 * }))
 *
 * const document = Handlers.data(article, { onResource: withSelfLink })
 * // → { data: { type: "articles", id: "1", attributes: { title: "Hi" },
 * //             links: { self: "/articles/1" } } }
 * console.log(document.data.links.self)
 * ```
 *
 * @since 0.15.0
 * @category constructors
 */
export const transform = <F extends TransformLambda>(
  f: (resource: AnyResourceValue) => AnyResourceValue,
): ResourceTransform<F> => f as ResourceTransform<F>;

// ---------------------------------------------------------------------------
// project — sparse fieldsets
// ---------------------------------------------------------------------------

/**
 * A sparse-fieldset selection: the attribute names requested per resource
 * type. This is the decoded `fields` member of a query schema
 * (`Query.schema(Article, { fields: true })`), so a handler passes
 * `query.fields` straight through.
 *
 * @since 0.15.0
 * @category models
 */
export interface Fields {
  readonly [type: string]: ReadonlyArray<string> | undefined;
}

// The attributes a fieldset selects. A selection known only as an *array* of
// names (a `query.fields` value, whose contents are a runtime fact) can be any
// subset of them, so every selected attribute becomes optional; a literal
// tuple is exact, and the empty tuple (`?fields[TYPE]=`, #488) selects none.
// No set at all (`undefined` alone) selects every attribute, as at runtime.
type SelectedAttributes<A, Keys> = [Keys] extends [never]
  ? A
  : [Keys] extends [ReadonlyArray<string>]
    ? [Keys[number]] extends [never]
      ? Record<never, never>
      : number extends Keys["length"]
        ? Simplify<Partial<Pick<A, Extract<keyof A, Keys[number]>>>>
        : Simplify<Pick<A, Extract<keyof A, Keys[number]>>>
    : A;

/**
 * The type of a resource with a sparse fieldset applied: `attributes` narrowed
 * to the names requested for its type, everything else untouched. A type with
 * no requested set is left exactly as it is; an empty requested set (`[]`)
 * leaves `attributes` empty.
 *
 * @since 0.15.0
 * @category type-level
 */
export type Projected<R, F> = R extends { readonly type: infer T; readonly attributes: infer A }
  ? T extends keyof F
    ? Simplify<
        Omit<R, "attributes"> & {
          readonly attributes: SelectedAttributes<A, Exclude<F[T], undefined>>;
        }
      >
    : R
  : R;

/**
 * The {@link TransformLambda} of {@link project}.
 *
 * @since 0.15.0
 * @category type-level
 */
export interface ProjectLambda<F> extends TransformLambda {
  readonly Out: Projected<this["In"], F>;
}

const selectAttributes = (
  attributes: { readonly [key: string]: unknown },
  requested: ReadonlyArray<string>,
) => {
  const selected = new Set<string>(requested);
  const projected: Record<string, unknown> = {};
  for (const name of Object.keys(attributes)) {
    // An own `__proto__` attribute (as `JSON.parse` gives) stays a member.
    if (selected.has(name)) assign(projected, name, attributes[name]);
  }
  return projected;
};

const projectResource = (
  resource: AnyResourceValue,
  fields: Fields | undefined,
): AnyResourceValue => {
  if (fields === undefined || !Object.hasOwn(fields, resource.type)) return resource;
  const requested = fields[resource.type];
  // No requested set for this type leaves every field. A *present* empty set
  // (`?fields[TYPE]=`) is the spec's "no fields" (§Sparse Fieldsets: "An empty
  // value indicates that no fields should be returned") and projects
  // `attributes` to `{}` like any other set (#488).
  if (requested === undefined) return resource;
  const attributes = resource.attributes;
  // Resource identifiers (and any resource with no attributes) have nothing
  // to project.
  if (attributes === undefined) return resource;
  return { ...resource, attributes: selectAttributes(attributes, requested) };
};

/**
 * Applies a sparse fieldset (§Sparse Fieldsets) to a resource: `attributes` is
 * narrowed to the names requested for the resource's type.
 *
 * Two behaviours make it safe to apply to every resource in a document:
 *
 *   - a type with **no requested set** (`fields[TYPE]` absent) is returned
 *     unchanged: the spec leaves that type's fields to the server, and every
 *     field is what it already carries. A requested **empty** set
 *     (`?fields[TYPE]=`, decoded as `[]`) is the spec's "no fields", not
 *     "every field", and projects `attributes` to `{}` (#488);
 *   - only `attributes` is projected. `relationships`, `links` and `meta` are
 *     left alone, and a resource identifier (no `attributes` at all) is
 *     returned as is. Relationship fields — `?fields[articles]=author` — are
 *     out of scope: `Query.Fieldset` is built from the resource's attributes,
 *     so a relationship name cannot be requested in the first place, and
 *     `relationships` is kept even under an empty set, since dropping it
 *     would unlink the `included` members it reaches, which the builders'
 *     full-linkage check and `Middleware.SchemaErrorsLive` answer with a 500.
 *
 * Dual API: `project(fields)` builds the {@link ResourceTransform} the
 * document builders take as `onResource`, which is what applies the fieldset
 * **uniformly** to the primary data and every `included` member;
 * `project(resource, fields)` projects one resource directly.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Handlers, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 *
 * const article = Article.make({
 *   id: Article.Id.make("1"),
 *   attributes: { title: "Hi", body: "…" },
 *   relationships: { author: { data: { type: "people", id: Person.Id.make("9") } } }
 * })
 *
 * // data-first: one resource, `attributes` only
 * const projected = Handlers.project(article, { articles: ["title"] })
 * console.log(projected.attributes)      // → { title: "Hi" }
 * console.log(projected.relationships)   // → { author: { data: { type: "people", id: "9" } } } — untouched
 *
 * // no requested set for this type → unchanged
 * console.log(Handlers.project(article, { people: ["firstName"] }).attributes)
 * // → { title: "Hi", body: "…" }
 *
 * // an empty set (`?fields[articles]=`) → no attributes
 * console.log(Handlers.project(article, { articles: [] }).attributes)
 * // → {}
 *
 * // data-last: the hook the builders apply to every resource in the document
 * const document = Handlers.data(article, { onResource: Handlers.project({ articles: ["title"] }) })
 * console.log(document.data.attributes)  // → { title: "Hi" }
 * ```
 *
 * @see {@link https://jsonapi.org/format/1.1/#fetching-sparse-fieldsets}
 * @since 0.15.0
 * @category constructors
 */
export const project: {
  <const F extends Fields>(fields: F | undefined): ResourceTransform<ProjectLambda<F>>;
  <R extends ResourceValue, const F extends Fields>(
    resource: R,
    fields: F | undefined,
  ): Projected<R, F>;
} = ((...args: ReadonlyArray<unknown>) =>
  args.length >= 2
    ? projectResource(args[0] as AnyResourceValue, args[1] as Fields | undefined)
    : (resource: AnyResourceValue) =>
        projectResource(resource, args[0] as Fields | undefined)) as never;

// ---------------------------------------------------------------------------
// withMeta — computed per-resource meta
// ---------------------------------------------------------------------------

// The `meta` a resource already carries, if any.
type ExistingMeta<R> = R extends { readonly meta?: infer E } ? Exclude<E, undefined> : never;

// What `withMeta` leaves under `meta`: the computed members merged over
// whatever the resource already declared.
type MergedMeta<R, M extends MetaValue> = [ExistingMeta<R>] extends [never]
  ? M
  : Simplify<ExistingMeta<R> & M>;

/**
 * The type of a resource with computed `meta` merged in. The member stays
 * optional: a computation that produces nothing leaves the resource without a
 * `meta` member rather than with an empty one.
 *
 * @since 0.15.0
 * @category type-level
 */
export type WithMeta<R, M extends MetaValue> = R extends AnyResourceValue
  ? Simplify<Omit<R, "meta"> & { readonly meta?: MergedMeta<R, M> }>
  : R;

/**
 * The {@link TransformLambda} of {@link withMeta}.
 *
 * @since 0.15.0
 * @category type-level
 */
export interface WithMetaLambda<M extends MetaValue> extends TransformLambda {
  readonly Out: WithMeta<this["In"], M>;
}

const stampMeta = (
  resource: AnyResourceValue,
  computed: MetaValue | undefined,
): AnyResourceValue => {
  const merged = { ...resource.meta, ...computed };
  if (Arr.isReadonlyArrayNonEmpty(Object.keys(merged))) return { ...resource, meta: merged };
  // An empty `meta` is a *present* meta object to the spec, which is a
  // different statement from having none: emit no member at all.
  if (resource.meta === undefined) return resource;
  const { meta: _meta, ...rest } = resource;
  return rest;
};

/**
 * Builds a {@link ResourceTransform} that stamps computed `meta` onto every
 * resource the document carries — the standard home for per-viewer,
 * server-computed facts about a resource (`canEdit`, `canDelete`, …).
 *
 * The computed members are merged **over** whatever `meta` the resource
 * already carries. If the merged result is empty, the resource is emitted with
 * **no** `meta` member: to the spec an empty `meta` object is a present-but-empty
 * meta, which says something different from saying nothing.
 *
 * The computation is handed every resource in the document, of every type, so
 * it receives the widest {@link AnyResourceValue} shape — switch on `type` to
 * narrow, and return `undefined` for the resources it has nothing to say about.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Handlers, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", { attributes: { title: Schema.NonEmptyString } })
 * const article = Article.make({ id: Article.Id.make("1"), attributes: { title: "Hi" } })
 *
 * const forViewer = (viewer: { readonly id: string; readonly admin: boolean }) =>
 *   Handlers.withMeta((resource) => ({ canEdit: viewer.admin && resource.type === "articles" }))
 *
 * const document = Handlers.data(article, { onResource: forViewer({ id: "9", admin: true }) })
 * console.log(document.data.meta)   // → { canEdit: true }
 *
 * // nothing computed → no `meta` member, rather than an empty one
 * console.log("meta" in Handlers.data(article, { onResource: Handlers.withMeta(() => undefined) }).data)
 * // → false
 * ```
 *
 * @since 0.15.0
 * @category constructors
 */
export const withMeta = <const M extends MetaValue>(
  compute: (resource: AnyResourceValue) => M | undefined,
): ResourceTransform<WithMetaLambda<M>> =>
  ((resource: AnyResourceValue) => stampMeta(resource, compute(resource))) as ResourceTransform<
    WithMetaLambda<M>
  >;

// ---------------------------------------------------------------------------
// compose
// ---------------------------------------------------------------------------

/**
 * The {@link TransformLambda} of {@link compose}: `second` applied to the
 * output of `first`.
 *
 * @since 0.15.0
 * @category type-level
 */
export interface ComposeLambda<
  A extends TransformLambda,
  B extends TransformLambda,
> extends TransformLambda {
  readonly Out: Transformed<B, Transformed<A, this["In"]>>;
}

/**
 * Composes two transforms into one: `first`, then `second`. Nest it for more.
 *
 * A document has a single `onResource` hook by design — one pass, applied
 * once per resource — so a handler that both projects a fieldset and stamps
 * computed `meta` composes the two here rather than running two passes.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Handlers, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 * const article = Article.make({ id: Article.Id.make("1"), attributes: { title: "Hi", body: "…" } })
 *
 * const onResource = Handlers.compose(
 *   Handlers.project({ articles: ["title"] }),
 *   Handlers.withMeta((resource) => ({ href: `/${resource.type}/${resource.id}` }))
 * )
 *
 * const document = Handlers.data(article, { onResource })
 * console.log(document.data.attributes)  // → { title: "Hi" }
 * console.log(document.data.meta)        // → { href: "/articles/1" }
 * ```
 *
 * @since 0.15.0
 * @category combinators
 */
export const compose = <A extends TransformLambda, B extends TransformLambda>(
  first: ResourceTransform<A>,
  second: ResourceTransform<B>,
): ResourceTransform<ComposeLambda<A, B>> =>
  ((resource: ResourceValue) =>
    second(first(resource) as ResourceValue)) as unknown as ResourceTransform<ComposeLambda<A, B>>;

// ---------------------------------------------------------------------------
// Compound documents
// ---------------------------------------------------------------------------

const key = (identifier: ResourceIdentifierValue): string => `${identifier.type}\0${identifier.id}`;

// The keys of every resource identifier in a resource's inline relationship
// linkage — the edges the full-linkage walk follows out of it.
const linkageKeys = (resource: ResourceValue): Array<string> =>
  Arr.flatMap(Rec.values(resource.relationships ?? {}), ({ data: linkage }) =>
    linkage === null || linkage === undefined
      ? []
      : Arr.map(Array.isArray(linkage) ? linkage : [linkage], key),
  );

// Wraps a transform so it runs at most once per `(type, id)`, handing back
// the same value everywhere that resource appears in the document. A resource
// offered as both primary data and an `included` member is shaped once, for
// the primary slot, and `buildIncluded` then drops it from `included`.
const memoise = <F extends TransformLambda>(
  onResource: ResourceTransform<F>,
): ResourceTransform<F> => {
  const shaped = new Map<string, unknown>();
  return ((resource: ResourceValue) => {
    const k = key(resource);
    if (shaped.has(k)) return shaped.get(k);
    const transformed = onResource(resource);
    shaped.set(k, transformed);
    return transformed;
  }) as ResourceTransform<F>;
};

// Applies a transform to every resource of an array, or hands the array back
// when there is none.
const mapResources = <F extends TransformLambda>(
  resources: ReadonlyArray<ResourceValue>,
  onResource: ResourceTransform<F> | undefined,
): ReadonlyArray<ResourceValue> =>
  onResource === undefined
    ? resources
    : resources.map((resource) => onResource(resource) as ResourceValue);

/**
 * Deduplicates included resources by `(type, id)`, applies the per-resource
 * transform, and verifies the spec's full-linkage rule: every included
 * resource must be reachable from the primary data by following resource
 * linkage.
 *
 * Dedup is document-wide: a resource already present in `primary` is dropped
 * from `included` rather than repeated, since a compound document MUST NOT
 * include more than one resource object for each `(type, id)` pair. That is
 * the case a heterogeneous collection hits whenever an include target is also
 * one of the hits.
 *
 * The three steps run in that order deliberately. Dedup first, so `onResource`
 * runs once per distinct resource rather than once per occurrence; the
 * transform before the check, so the check sees the `included` members the
 * document actually emits — a transform that drops `relationships` can break
 * full linkage, and saying so is the point of the check.
 *
 * `onResource` shapes only `included` here: the check reads `primary` as
 * passed. {@link data} and {@link collection} pass their already-transformed
 * primary data; called directly, pass `primary` as the document will emit it.
 *
 * The check walks reachability from the primary data, the same walk the
 * conformance kit's `spec/document/full-linkage` rule makes: it starts from
 * the identifiers in `primary`'s relationships and follows the relationships
 * of each `included` member it reaches. A member passes only when that walk
 * reaches it. Being referenced is not enough: a cycle of members the primary
 * data no longer reaches, or a member whose only reference is its own, fails.
 *
 * `primary` may instead be a relationship document's resource linkage — every
 * element a bare identifier, with no `attributes`, `relationships` or `links`
 * (`Handlers.linkage`'s `data`, as an array). Then the walk starts from those
 * identifiers themselves (JSON:API 1.1 §Compound Documents), and `included` is
 * not deduplicated against them, since an identifier is not a resource object
 * (#423). {@link data} and {@link collection} always read their primary data
 * as resource objects.
 *
 * It checks the value it is given, which counts every relationship key a
 * resource carries. Encoding through an endpoint's schema drops a
 * relationship the resource does not declare, so a member linked only through
 * one passes here and is unreachable on the wire; `Middleware.SchemaErrorsLive`
 * re-runs the walk on the encoded document and answers that with a 500
 * (#250). This option's `checkLinkage: false` does not reach that check.
 *
 * The transform is keyed off the resource as given, so it must not change a
 * resource's `type` or `id`.
 *
 * A linkage violation is a programming error in the handler, so it throws
 * (surfacing as a defect) rather than failing the request.
 *
 * @since 0.1.0
 * @category utils
 */
export const buildIncluded = <
  Included extends ResourceValue,
  F extends TransformLambda = IdentityLambda,
>(
  primary: ReadonlyArray<ResourceValue>,
  included: ReadonlyArray<Included>,
  options?: {
    /**
     * `false` skips the full-linkage check, which is on by default. The check
     * walks from `primary` as passed through the `included` members after
     * dedup and `onResource` — so pass `primary` as the document will emit it.
     * `included` from {@link resolveIncluded} is not on its own a reason to
     * skip it: a transform that touches `relationships` can orphan members the
     * resolver linked. Skip it only when you know every emitted `included`
     * member is reachable from the emitted primary data.
     */
    readonly checkLinkage?: boolean | undefined;
    /**
     * Applied to every deduplicated included resource, after dedup and before
     * the full-linkage check.
     *
     * @since 0.15.0
     */
    readonly onResource?: ResourceTransform<F> | undefined;
  },
): ReadonlyArray<Transformed<F, Included>> =>
  includedFor(primary, isLinkageData(primary), included, options);

// `buildIncluded`, told whether `primary` is resource linkage rather than
// resource objects. `data` and `collection` pass `false`: their primary data
// is resource objects however bare, and a bare one's included copy is a
// duplicate to drop, not a member to link.
const includedFor = <Included extends ResourceValue, F extends TransformLambda>(
  primary: ReadonlyArray<ResourceValue>,
  asLinkage: boolean,
  included: ReadonlyArray<Included>,
  options?: Parameters<typeof buildIncluded<Included, F>>[2],
): ReadonlyArray<Transformed<F, Included>> => {
  // Dedupe by (type, id), against the primary data as well as within
  // `included`: the one-resource-object-per-pair rule is document-wide.
  // Linkage is no resource object, so there is nothing to dedupe against.
  const seen = new Set<string>(asLinkage ? [] : primary.map(key));
  const deduped: Array<Included> = [];
  for (const resource of included) {
    const k = key(resource);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(resource);
  }

  // One transform pass over the survivors.
  const shaped = mapResources(deduped, options?.onResource);

  // Full linkage: every included resource is reachable from the primary data,
  // through its linkage and then through other included members' linkage.
  if (options?.checkLinkage !== false) {
    const members = HashMap.fromIterable(Arr.map(shaped, (resource) => [key(resource), resource]));
    const start = seeds(primary, asLinkage, (identifier) => [key(identifier)], linkageKeys);
    const linked = reachable(start, (k) =>
      Option.match(HashMap.get(members, k), { onNone: () => [], onSome: linkageKeys }),
    );
    for (const resource of shaped) {
      if (!HashSet.has(linked, key(resource))) {
        throw new Error(
          `JSON:API full linkage violation: included resource "${resource.type}:${resource.id}" ` +
            `is not reachable from the primary data through resource linkage ` +
            `(https://jsonapi.org/format/1.1/#document-compound-documents)`,
        );
      }
    }
  }

  return shaped as ReadonlyArray<Transformed<F, Included>>;
};

// ---------------------------------------------------------------------------
// Compound-document include resolution
// ---------------------------------------------------------------------------

/**
 * A batch loader for one resource type: given the ids the walk reached at the
 * current level, load those resources.
 *
 * The resolver calls a target **once per level**, with every distinct id that
 * level collected — never once per reference — so a loader should issue one
 * query for the whole array. Ids it cannot resolve (deleted rows, rows this
 * viewer may not see) are simply left out of the result; the resolver drops
 * them from `included` rather than failing. A genuine fault (the database is
 * down) belongs in the error channel, where it fails the document.
 *
 * @since 0.15.0
 * @category models
 */
export type IncludeTarget<A extends ResourceValue = ResourceValue, E = never, R = never> = (
  ids: ReadonlyArray<string>,
) => Effect.Effect<ReadonlyArray<A>, E, R>;

/**
 * The registry {@link resolveIncluded} walks: one {@link IncludeTarget} per
 * resource **type**, keyed by the `type` the linkage carries.
 *
 * Keying by type rather than by relationship name is what makes a
 * heterogeneous to-many (`{ data: [{ type: "articles" … }, { type: "comments" … }] }`)
 * cost one query per type, and what lets a type reached by several paths share
 * a single loader. A type with no entry is not loadable, so references to it
 * are dropped — the same outcome as an id the loader didn't return.
 *
 * Declare a registry with `satisfies Handlers.IncludeTargets` rather than
 * annotating it: the loaders' own resource, error and service types are then
 * still visible to {@link resolveIncluded}, which projects them onto the
 * effect it returns ({@link IncludeTargetResource}, {@link IncludeTargetError},
 * {@link IncludeTargetServices}).
 *
 * @since 0.15.0
 * @category models
 */
export interface IncludeTargets {
  readonly [type: string]: IncludeTarget<ResourceValue, any, any>;
}

// The `(resource, error, services)` triple a target's Effect carries.
type IncludeTargetTypes<T> = T extends (
  ids: ReadonlyArray<string>,
) => Effect.Effect<ReadonlyArray<infer A>, infer E, infer R>
  ? { readonly resource: A; readonly error: E; readonly services: R }
  : never;

/**
 * The union of resource values a target registry can produce — the
 * `included` element type {@link resolveIncluded} resolves to.
 *
 * @since 0.15.0
 * @category type-level
 */
export type IncludeTargetResource<Targets extends IncludeTargets> = IncludeTargetTypes<
  Targets[keyof Targets]
>["resource"];

/**
 * The union of failures a target registry's loaders can raise.
 *
 * @since 0.15.0
 * @category type-level
 */
export type IncludeTargetError<Targets extends IncludeTargets> = IncludeTargetTypes<
  Targets[keyof Targets]
>["error"];

/**
 * The union of services a target registry's loaders require.
 *
 * @since 0.15.0
 * @category type-level
 */
export type IncludeTargetServices<Targets extends IncludeTargets> = IncludeTargetTypes<
  Targets[keyof Targets]
>["services"];

/**
 * Options of {@link resolveIncluded}.
 *
 * @since 0.15.0
 * @category models
 */
export interface ResolveIncludedOptions {
  /**
   * How many of a level's loader calls may run at once. Defaults to
   * `"unbounded"`, which is a level's distinct target types — a number you
   * control, since it is bounded by the registry, not by the request.
   */
  readonly concurrency?: number | "unbounded" | undefined;
  /**
   * The maximum number of relationship hops to walk. Defaults to `3`, the
   * deepest path `Query.Include` legalises.
   *
   * §7.1 leaves the bound implementation-defined, and each hop is another
   * round of loader calls, so this is a denial-of-service boundary as much as
   * an ergonomic one: raise it only as far as the paths you actually serve
   * need. Segments beyond the cap are not walked.
   */
  readonly depth?: number | undefined;
}

// A node of the trie the requested paths form: `["author", "comments.author"]`
// becomes `{ author: {}, comments: { author: {} } }`. Paths sharing a prefix
// share the node, so the prefix is walked once however many paths spell it.
interface PathNode {
  readonly segment: string;
  readonly children: Map<string, PathNode>;
}

// The requested paths as a trie. `Map` preserves insertion order, so walking
// it walks the paths in the order the client asked for them.
const pathTrie = (paths: ReadonlyArray<string>): Map<string, PathNode> => {
  const root = new Map<string, PathNode>();
  for (const path of paths) {
    let level = root;
    for (const segment of path.split(".")) {
      if (segment === "") continue;
      let node = level.get(segment);
      if (node === undefined) {
        node = { segment, children: new Map() };
        level.set(segment, node);
      }
      level = node.children;
    }
  }
  return root;
};

const isIdentifier = (linkage: LinkageValue): linkage is ResourceIdentifierValue =>
  linkage !== null && !Array.isArray(linkage);

// The identifiers one relationship's inline linkage carries. A `paginated`
// relationship has no `data` — its members are reachable only through the
// `related` link — so it contributes nothing to a walk.
const linkageIdentifiers = (
  resource: ResourceValue,
  name: string,
): ReadonlyArray<ResourceIdentifierValue> => {
  const linkage = resource.relationships?.[name]?.data;
  if (linkage === null || linkage === undefined) return [];
  return isIdentifier(linkage) ? [linkage] : linkage;
};

// One level of the walk: the trie nodes still to read, and the resources to
// read them off.
interface Level {
  readonly nodes: Map<string, PathNode>;
  readonly parents: ReadonlyArray<ResourceValue>;
}

const resolve = (
  primary: ReadonlyArray<ResourceValue>,
  paths: ReadonlyArray<string>,
  targets: IncludeTargets,
  concurrency: number | "unbounded",
  depth: number,
): Effect.Effect<ReadonlyArray<ResourceValue>, any, any> =>
  Effect.gen(function* () {
    // Every resource the document already holds, keyed `type\0id`. Seeded with
    // the primary data: a resource already in `data` is never loaded again and
    // never emitted into `included` (the spec's one-resource-object-per-`(type,
    // id)` rule spans the whole document), but the walk still steps *through*
    // it, which is what makes a cycle terminate instead of looping.
    const known = new Map<string, ResourceValue>();
    for (const resource of primary) known.set(key(resource), resource);

    // `included`, in walk order.
    const included: Array<ResourceValue> = [];

    let level: ReadonlyArray<Level> = [{ nodes: pathTrie(paths), parents: primary }];
    let hops = depth;

    while (Arr.isReadonlyArrayNonEmpty(level) && hops > 0) {
      hops--;

      // Every identifier this level reaches, deduplicated across paths, parents
      // and rows, in walk order — and, per branch that has further segments,
      // the keys it reached, so the next level knows its parents.
      const levelIdentifiers = new Map<string, ResourceIdentifierValue>();
      const branches: Array<{
        readonly nodes: Map<string, PathNode>;
        readonly keys: ReadonlyArray<string>;
      }> = [];
      for (const { nodes, parents } of level) {
        for (const node of nodes.values()) {
          const keys: Array<string> = [];
          const reached = new Set<string>();
          for (const parent of parents) {
            for (const identifier of linkageIdentifiers(parent, node.segment)) {
              const k = key(identifier);
              if (reached.has(k)) continue;
              reached.add(k);
              keys.push(k);
              if (!levelIdentifiers.has(k)) levelIdentifiers.set(k, identifier);
            }
          }
          if (node.children.size > 0) branches.push({ nodes: node.children, keys });
        }
      }

      // One batch per distinct type, holding only the ids the document doesn't
      // already have. A type with no target is not loadable: its references are
      // dropped here.
      const batches: Array<{
        readonly load: IncludeTarget<ResourceValue, any, any>;
        readonly ids: Array<string>;
      }> = [];
      const byType = new Map<string, Array<string>>();
      for (const [k, identifier] of levelIdentifiers) {
        if (known.has(k)) continue;
        if (!Object.hasOwn(targets, identifier.type)) continue;
        const ids = byType.get(identifier.type);
        if (ids === undefined) {
          const fresh = [identifier.id];
          byType.set(identifier.type, fresh);
          batches.push({ load: targets[identifier.type]!, ids: fresh });
        } else {
          ids.push(identifier.id);
        }
      }

      const rows = yield* Effect.forEach(batches, ({ ids, load }) => load(ids), { concurrency });

      // Index what came back. A row nobody referenced is ignored: adding it
      // would break the full linkage `buildIncluded` checks.
      const loaded = new Map<string, ResourceValue>();
      for (const batch of rows) {
        for (const row of batch) {
          const k = key(row);
          if (!levelIdentifiers.has(k) || known.has(k) || loaded.has(k)) continue;
          loaded.set(k, row);
        }
      }

      // Emit in walk order, not in whichever order the batches completed.
      for (const k of levelIdentifiers.keys()) {
        const resource = loaded.get(k);
        if (resource === undefined) continue;
        known.set(k, resource);
        included.push(resource);
      }

      // Step. A branch's parents are the resources its keys resolved to —
      // whether this level loaded them or an earlier one did — so a shared
      // prefix costs no second query and a diamond is traversed once.
      const next: Array<Level> = [];
      for (const branch of branches) {
        const parents: Array<ResourceValue> = [];
        for (const k of branch.keys) {
          const resource = known.get(k);
          if (resource !== undefined) parents.push(resource);
        }
        if (Arr.isReadonlyArrayNonEmpty(parents)) next.push({ nodes: branch.nodes, parents });
      }
      level = next;
    }

    return included;
  });

/**
 * Resolves the `included` member of a compound document: walks the requested
 * §7.1 include paths from the primary data, loading each level through the
 * given per-type batch loaders.
 *
 * This is the runtime half of `?include=` — the part
 * {@link buildIncluded} assumes has already happened — as a plain `Effect` a
 * handler composes. There is no service to provide and no runtime to set up:
 * the loaders are ordinary functions in a record, so the same call serves one
 * primary resource and a whole page of them.
 *
 * What it guarantees:
 *
 * - **One level at a time, across the whole primary set.** Every parent's
 *   references for the current segment are collected first, then handed to the
 *   loaders as a single batch per type. `author.company` over a 50-article page
 *   is two loader calls, not a hundred — the N+1 this exists to prevent.
 * - **One bucket keyed `(type, id)`.** `included` is a set of resources, not of
 *   references: two paths or two rows reaching the same resource contribute it
 *   once, a shared path prefix costs no second query, and a resource already in
 *   the primary `data` is never duplicated into `included`.
 * - **Emission order is walk order**, so `get` and `list` agree and the array
 *   is stable across runs whatever order the batches complete in.
 * - **Cycles terminate.** A graph that loops (articles → comments → articles)
 *   revisits resources the document already holds, which are never re-loaded,
 *   so the walk is bounded by the paths, then by `depth`.
 * - **An unresolvable reference is dropped, not a failure.** A type with no
 *   target, an id the batch didn't return, a row the viewer may not see: all
 *   are normal outcomes, and simply absent from `included`. A loader's own
 *   failure propagates and fails the document.
 * - **`undefined` when nothing was requested** (`paths` is `undefined`), so
 *   the builders omit the member. An empty array is the different statement
 *   "your walk resolved to nothing" — including for an empty `paths`, which is
 *   a bare `?include=`: the request carried `include` — and {@link data} /
 *   {@link collection} emit it as `included: []`, because §Fetching Includes
 *   requires the key in every response to a request carrying `include`.
 *
 * **Full linkage holds by construction — for the array this returns.** Every
 * member is reached *through* the linkage of the primary data the walk started
 * from, or of a member before it. Handed unchanged to {@link data} or
 * {@link collection} with that same primary data, {@link buildIncluded}'s
 * check is a guard over the resolver's own output rather than a live
 * constraint. The guarantee covers what the walk produces, not the document a
 * builder then emits, so it no longer holds when:
 *
 * - an `onResource` transform removes or rewrites `relationships`. The check
 *   walks the transformed resources the document emits, from the primary
 *   data, so stripping the primary data's `relationships` orphans every member
 *   reachable only through them, and stripping a member's orphans every member
 *   reachable only through it — however many hops on. A member other members
 *   still reference is orphaned all the same once the walk cannot reach it: a
 *   cycle of members, or a member that references itself, does not link
 *   itself to the document.
 *   {@link project} and {@link withMeta} leave `relationships` alone;
 *   {@link transform} is unconstrained;
 * - the array is edited: a member taken out can orphan everything reachable
 *   only through it, and a resource added was never reached at all;
 * - the builder is given different primary data from the resources the walk
 *   started from.
 *
 * So a resolver-built document is not, by itself, a reason to pass
 * `checkLinkage: false`: keep the check on unless you know none of these
 * applies.
 *
 * A `paginated` relationship carries no inline linkage, so it contributes
 * nothing to a walk; its members are reachable only through the `related` link,
 * which is why they are excluded from `?include=` paths to begin with.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Handlers, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString }
 * })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     comments: Relationship.many(() => Comment)
 *   }
 * })
 *
 * const people = [
 *   Person.make({ id: Person.Id.make("9"), attributes: { firstName: "Dan" } }),
 *   Person.make({ id: Person.Id.make("2"), attributes: { firstName: "Tyler" } })
 * ]
 * const comments = [
 *   Comment.make({
 *     id: Comment.Id.make("5"),
 *     attributes: { body: "First!" },
 *     relationships: { author: { data: Person.ref(Person.Id.make("2")) } }
 *   })
 * ]
 * const article = Article.make({
 *   id: Article.Id.make("1"),
 *   attributes: { title: "JSON:API paints my bikeshed!" },
 *   relationships: {
 *     author: { data: Person.ref(Person.Id.make("9")) },
 *     comments: { data: [Comment.ref(Comment.Id.make("5"))] }
 *   }
 * })
 *
 * // One loader per type. Each is called once per level, with every id that
 * // level collected — so each is `WHERE id IN (…)`, never a lookup per row.
 * const targets = {
 *   people: (ids: ReadonlyArray<string>) => Effect.succeed(people.filter((p) => ids.includes(p.id))),
 *   comments: (ids: ReadonlyArray<string>) => Effect.succeed(comments.filter((c) => ids.includes(c.id)))
 * }
 *
 * const document = Effect.runSync(
 *   Handlers.resolveIncluded(article, ["author", "comments.author"], targets).pipe(
 *     Effect.map((included) => Handlers.data(article, { included, self: "/articles/1" }))
 *   )
 * )
 *
 * document.included?.map((resource) => `${resource.type}:${resource.id}`)
 * // → ["people:9", "comments:5", "people:2"]
 * //   Three loader calls for two levels: people+comments, then people again
 * //   for the comment's author (person 9 is already in the document, so the
 * //   second people batch asks for id 2 alone).
 * ```
 *
 * @see {@link https://jsonapi.org/format/1.1/#fetching-includes}
 * @since 0.15.0
 * @category constructors
 */
export const resolveIncluded = <Targets extends IncludeTargets>(
  primary: ResourceValue | null | ReadonlyArray<ResourceValue>,
  paths: ReadonlyArray<string> | undefined,
  targets: Targets,
  options?: ResolveIncludedOptions,
): Effect.Effect<
  ReadonlyArray<IncludeTargetResource<Targets>> | undefined,
  IncludeTargetError<Targets>,
  IncludeTargetServices<Targets>
> =>
  (paths === undefined
    ? Effect.succeed(undefined)
    : Arr.isReadonlyArrayEmpty(paths)
      ? Effect.succeed([])
      : resolve(
          primary === null ? [] : Array.isArray(primary) ? primary : [primary as ResourceValue],
          paths,
          targets,
          options?.concurrency ?? "unbounded",
          options?.depth ?? 3,
        )) as Effect.Effect<
    ReadonlyArray<IncludeTargetResource<Targets>> | undefined,
    IncludeTargetError<Targets>,
    IncludeTargetServices<Targets>
  >;

/**
 * A top-level JSON:API document *value* — the shape {@link data} and
 * {@link collection} return, named so consumers can annotate their own
 * document-assembling functions instead of hand-rolling the envelope type.
 *
 * The `jsonapi` member is *conditional* on `J`, the same way `meta` is
 * conditional on `M`: it is present (and required, not optional — a builder
 * that infers `J` from an argument has one to put there) only when a caller
 * actually passed the `jsonapi` option, so the return type of
 * `Handlers.data(article, { jsonapi: Document.v1_1 })` carries
 * `jsonapi: Document.JsonApiObjectValue` and the return type of
 * `Handlers.data(article)` has no `jsonapi` member at all — no cast needed
 * either way. `included` is always declared, optional: a builder emits any
 * array it is given, so `Handlers.data(article, { included: [] })` — whose
 * literal `[]` infers `Included = never` — still reads back `included: []`.
 *
 * The type stays *conditional* on its generics so TypeScript only infers
 * `M` / `J` from arguments — never from the expected (contextual)
 * return type of a handler, which breaks down inside `pipe(Effect.map(...))`
 * chains.
 *
 * @since 0.3.0
 * @category models
 */
export type DocumentValue<
  Data,
  Included = never,
  M extends MetaValue = never,
  J extends JsonApiObjectValue = never,
> = Simplify<
  {
    readonly data: Data;
    readonly included?: ReadonlyArray<Included>;
    readonly links?: LinksValue;
  } & ([M] extends [never] ? Record<never, never> : { readonly meta?: M }) &
    ([J] extends [never] ? Record<never, never> : { readonly jsonapi: J })
>;

// The primary `data` of a document with the transform applied. `data(null)`
// has no resource to transform, so a nullable primary stays nullable.
type TransformedData<F extends TransformLambda, R> = R extends null ? null : Transformed<F, R>;

// Appends a query string (no leading `?`) to a path, whichever separator the
// path needs; a path with no query is returned as is.
const withQuery = (path: string, query: string): string =>
  query === "" ? path : path.includes("?") ? `${path}&${query}` : `${path}?${query}`;

// A request's canonical query, however it was handed over.
const queryString = (query: string | ReadonlyArray<Pair>): string =>
  typeof query === "string" ? query : serialise(query);

// A link with a query string appended, in either link spelling.
const linkWithQuery = (link: LinkValue, query: string): LinkValue =>
  typeof link === "string"
    ? withQuery(link, query)
    : { ...link, href: withQuery(link.href, query) };

// The top-level links of a document: `links.self` wins over the `self`
// option, and `query` is appended to whichever `self` the document ends up
// with — a `query` with no self link to carry it is a programming error.
const buildLinks = (options: {
  readonly self?: string | undefined;
  readonly query?: string | ReadonlyArray<Pair> | undefined;
  readonly links?: LinksValue | undefined;
}): LinksValue | undefined => {
  const links: LinksValue | undefined =
    options.self !== undefined ? { self: options.self, ...options.links } : options.links;
  if (options.query === undefined) return links;
  if (links?.self === undefined) {
    throw new Error(
      "Handlers.collection: `query` needs a self link to be appended to — pass `self` or `links.self`",
    );
  }
  return { ...links, self: linkWithQuery(links.self, queryString(options.query)) };
};

// `data` and `primary` are the already-transformed primary resources: the
// transform runs on them before the document is assembled, and `onResource`
// is the memoised pass shared with `included` so nothing is shaped twice.
// `asLinkage` marks `primary` as a relationship document's identifiers, which
// `included` is seeded from rather than deduplicated against (#423).
const build = (
  data: ResourceValue | ReadonlyArray<ResourceValue> | LinkageValue | null,
  primary: ReadonlyArray<ResourceValue>,
  options:
    | {
        readonly included?: ReadonlyArray<ResourceValue> | undefined;
        readonly meta?: MetaValue | undefined;
        readonly jsonapi?: JsonApiObjectValue | undefined;
        readonly self?: string | undefined;
        readonly query?: string | ReadonlyArray<Pair> | undefined;
        readonly links?: LinksValue | undefined;
        readonly checkLinkage?: boolean | undefined;
      }
    | undefined,
  onResource: ResourceTransform<TransformLambda> | undefined,
  asLinkage = false,
) => {
  const links = options === undefined ? undefined : buildLinks(options);
  // An array — however empty, and however empty dedup against the primary
  // data leaves it — is a compound document, and keeps its `included` key:
  // §Fetching Includes requires one in every response to a request carrying
  // `include`, "even if that `included` key holds an empty array" (#232).
  // Only `undefined` (nothing was requested) omits the member.
  const included =
    options?.included === undefined
      ? undefined
      : includedFor(primary, asLinkage, options.included, {
          checkLinkage: options.checkLinkage,
          onResource,
        });
  return {
    data,
    ...(included !== undefined ? { included } : {}),
    ...(links !== undefined ? { links } : {}),
    ...(options?.meta !== undefined ? { meta: options.meta } : {}),
    ...(options?.jsonapi !== undefined ? { jsonapi: options.jsonapi } : {}),
  };
};

/**
 * Builds a single-resource document value: `{ data, included?, links?, meta?, jsonapi? }`.
 *
 * Included resources are deduplicated — against each other and against the
 * primary data — and checked for full linkage. Any `included` array, empty
 * or emptied by that dedup, is emitted (`included: []`): pass one whenever the
 * request carried `include`, and `undefined` when it did not, so the member
 * is omitted (JSON:API 1.1 §Fetching Includes).
 *
 * Pass `jsonapi` to stamp the top-level `jsonapi` object — `Document.v1_1` to
 * advertise JSON:API 1.1, or `Atomic.jsonapi` for the atomic-operations
 * extension — and the return type carries `jsonapi` (typed as
 * {@link JsonApiObjectValue}) only when you actually pass it, so no cast is
 * needed at the call site either way.
 *
 * **Not emitted by default.** A JSON:API 1.1 server arguably should advertise
 * the version it implements on every document, but defaulting it here would
 * silently add a member to every response body this library already produces
 * — a behavioural change disguised as a bug fix. Advertising the version is
 * therefore opt-in: pass `jsonapi: Document.v1_1` on the responses where you
 * want it.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Document, Handlers, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Tag = Resource.make("tags", { attributes: { name: Schema.NonEmptyString } })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     tags: Relationship.many(() => Tag)
 *   }
 * })
 *
 * const author = Person.make({
 *   id: Person.Id.make("9"),
 *   attributes: { firstName: "Dan", lastName: "Gebhardt" }
 * })
 *
 * // in a handler — `handlers` comes from HttpApiBuilder.group, `loadArticle` from your data layer
 * const fetchHandler = (
 *   handlers: {
 *     handle: (
 *       name: string,
 *       handler: (request: {
 *         readonly params: { readonly id: string }
 *         readonly query: { readonly include?: ReadonlyArray<string> }
 *       }) => Effect.Effect<unknown>
 *     ) => void
 *   },
 *   loadArticle: (id: string) => Effect.Effect<typeof Article.Type>
 * ) =>
 *   // build a single-resource response document
 *   handlers.handle("fetch", ({ params, query }) =>
 *     loadArticle(params.id).pipe(
 *       Effect.map((article) =>
 *         Handlers.data(article, {
 *           // `undefined` without `?include=` (no `included` member); `[]`
 *           // when it named nothing that resolved (`included: []`)
 *           included:
 *             query.include === undefined ? undefined : query.include.includes("author") ? [author] : [],
 *           jsonapi: Document.v1_1,
 *           self: `/articles/${article.id}`
 *         })
 *       )
 *     )
 *   )
 * ```
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Handlers, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 *
 * const article = Article.make({
 *   id: Article.Id.make("1"),
 *   attributes: { title: "Hi", body: "…" },
 *   relationships: { author: { data: { type: "people", id: Person.Id.make("9") } } }
 * })
 * const author = Person.make({ id: Person.Id.make("9"), attributes: { firstName: "Dan", lastName: "Gebhardt" } })
 *
 * // `onResource` is one pass over every resource the document carries — the
 * // primary data and every `included` member — so a sparse fieldset cannot
 * // shape one slot and miss the other.
 * const document = Handlers.data(article, {
 *   included: [author],
 *   onResource: Handlers.project({ articles: ["title"], people: ["firstName"] })
 * })
 *
 * console.log(document.data.attributes)           // → { title: "Hi" }
 * console.log(document.included?.[0]?.attributes) // → { firstName: "Dan" }
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const data = <
  R extends ResourceValue | null,
  const Included extends ResourceValue = never,
  const M extends MetaValue = never,
  const J extends JsonApiObjectValue = never,
  F extends TransformLambda = IdentityLambda,
>(
  resource: R,
  options?: {
    /**
     * The compound document's members. An array — even `[]` — emits
     * `included`; `undefined` omits it. Pass an array whenever the request
     * carried `include` (JSON:API 1.1 §Fetching Includes).
     */
    readonly included?: ReadonlyArray<Included> | undefined;
    readonly meta?: M;
    /** The top-level `jsonapi` object, e.g. `Document.v1_1`. Omitted by default. */
    readonly jsonapi?: J;
    readonly self?: string;
    readonly links?: LinksValue;
    /**
     * Applied to every resource the document carries — the primary resource
     * and every deduplicated `included` member — exactly once each. See
     * {@link ResourceTransform}, {@link project} and {@link withMeta}.
     *
     * @since 0.15.0
     */
    readonly onResource?: ResourceTransform<F> | undefined;
    /**
     * `false` skips the full-linkage check, which is on by default. The check
     * runs on the resources the document emits, after dedup and `onResource`,
     * so `included` from {@link resolveIncluded} is not on its own a reason to
     * skip it: a transform that touches `relationships` can orphan members the
     * resolver linked. Skip it only when you know every emitted `included`
     * member is reachable from the emitted primary data.
     */
    readonly checkLinkage?: boolean | undefined;
  },
): DocumentValue<TransformedData<F, R>, Transformed<F, Included>, M, J> => {
  const onResource = options?.onResource === undefined ? undefined : memoise(options.onResource);
  const primary =
    resource === null
      ? null
      : onResource === undefined
        ? resource
        : (onResource(resource) as ResourceValue);
  return build(primary, primary === null ? [] : [primary], options, onResource) as DocumentValue<
    TransformedData<F, R>,
    Transformed<F, Included>,
    M,
    J
  >;
};

/**
 * Builds a collection document value: `{ data: [...], included?, links?, meta?, jsonapi? }`.
 *
 * Included resources are deduplicated — against each other and against the
 * primary data — and checked for full linkage. As with {@link data}, any
 * `included` array is emitted, even empty — a heterogeneous collection whose
 * every include candidate is already a hit answers `included: []` — and
 * `undefined` omits the member.
 *
 * JSON:API 1.1 requires a collection's `self` link to carry the query
 * parameters the client provided. Pass `query` — the request's canonical
 * query, from `Query.canonicalPairs(listQuery)(query)` or the
 * `Query.canonical(listQuery)(query)` string — and it is appended to the
 * document's `self` link, whether that is the `self` option or `links.self`
 * (which wins when both are given); `query` without either throws. A
 * paginated collection gets that for free from the link builders' own
 * `query` option instead ({@link offsetPaginationLinks}): pass the pairs
 * there, not here.
 *
 * As with {@link data}, `jsonapi` (e.g. `Document.v1_1`) is only emitted, and
 * only narrows into the return type, when you pass it — see {@link data} for
 * why it is opt-in rather than a default.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Document, Handlers, Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 * const listQuery = Query.schema(Article, { sort: true, page: Query.Page.Offset })
 *
 * const total = 42
 * const page = [
 *   Article.make({ id: Article.Id.make("1"), attributes: { title: "Hi", body: "..." } })
 * ]
 *
 * // build a paginated collection response document in a handler (`handlers`
 * // comes from HttpApiBuilder.group)
 * const listHandler = (handlers: {
 *   handle: (
 *     name: string,
 *     handler: (request: { readonly query: typeof listQuery.Type }) => Effect.Effect<unknown>
 *   ) => void
 * }) =>
 *   handlers.handle("list", ({ query }) =>
 *     Effect.succeed(
 *       Handlers.collection(page, {
 *         meta: { total },
 *         links: Handlers.offsetPaginationLinks("/articles", query.page ?? {}, total, {
 *           query: Query.canonicalPairs(listQuery)(query)
 *         })
 *       })
 *     )
 *   )
 *
 * // …or, unpaginated, the canonical query on the collection's own `self` link,
 * // advertising the JSON:API version this server implements
 * Handlers.collection(page, {
 *   jsonapi: Document.v1_1,
 *   self: "/articles",
 *   query: Query.canonicalPairs(listQuery)({ sort: [{ field: "title", direction: "desc" }] })
 * })
 * // → { data: [...], links: { self: "/articles?sort=-title" }, jsonapi: { version: "1.1" } }
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const collection = <
  R extends ResourceValue,
  const Included extends ResourceValue = never,
  const M extends MetaValue = never,
  const J extends JsonApiObjectValue = never,
  F extends TransformLambda = IdentityLambda,
>(
  resources: ReadonlyArray<R>,
  options?: {
    /**
     * The compound document's members. An array — even `[]` — emits
     * `included`; `undefined` omits it. Pass an array whenever the request
     * carried `include` (JSON:API 1.1 §Fetching Includes).
     */
    readonly included?: ReadonlyArray<Included> | undefined;
    readonly meta?: M;
    /** The top-level `jsonapi` object, e.g. `Document.v1_1`. Omitted by default. */
    readonly jsonapi?: J;
    readonly self?: string;
    /**
     * The request's canonical query — `Query.canonicalPairs(schema)(query)`
     * or the `Query.canonical(schema)(query)` string — appended to the
     * document's `self` link (`self`, or `links.self`); throws without one.
     *
     * @since 0.13.0
     */
    readonly query?: string | ReadonlyArray<Pair>;
    readonly links?: LinksValue;
    /**
     * Applied to every resource the document carries — each member of `data`
     * and every deduplicated `included` member — exactly once each. See
     * {@link ResourceTransform}, {@link project} and {@link withMeta}.
     *
     * @since 0.15.0
     */
    readonly onResource?: ResourceTransform<F> | undefined;
    /**
     * `false` skips the full-linkage check, which is on by default. The check
     * runs on the resources the document emits, after dedup and `onResource`,
     * so `included` from {@link resolveIncluded} is not on its own a reason to
     * skip it: a transform that touches `relationships` can orphan members the
     * resolver linked. Skip it only when you know every emitted `included`
     * member is reachable from the emitted primary data.
     */
    readonly checkLinkage?: boolean | undefined;
  },
): DocumentValue<ReadonlyArray<Transformed<F, R>>, Transformed<F, Included>, M, J> => {
  const onResource = options?.onResource === undefined ? undefined : memoise(options.onResource);
  const primary = mapResources(resources, onResource);
  return build(primary, primary, options, onResource) as DocumentValue<
    ReadonlyArray<Transformed<F, R>>,
    Transformed<F, Included>,
    M,
    J
  >;
};

// ---------------------------------------------------------------------------
// Relationship linkage & links
// ---------------------------------------------------------------------------

/**
 * The canonical relationship-endpoint URL:
 * `/<type>/<id>/relationships/<name>`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const relationshipLink = (type: string, id: string, name: string): string =>
  `/${type}/${id}/relationships/${name}`;

/**
 * The canonical related-resource URL: `/<type>/<id>/<name>`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const relatedLink = (type: string, id: string, name: string): string =>
  `/${type}/${id}/${name}`;

/**
 * Builds the relationship object value for a `paginated` relationship: no
 * inline `data`, just the required `related` link (`/<type>/<id>/<name>`) and,
 * by default, the relationship endpoint (`/<type>/<id>/relationships/<name>`)
 * as `self`.
 *
 * A relationship's `self` link is a promise that the server answers it
 * (JSON:API §Fetching Relationships), so advertise it only when the API
 * declares that endpoint — `Endpoint.getRelationship` for this relationship.
 * The `self` option controls it:
 *
 * - omitted (or `undefined`): `self` is `/<type>/<id>/relationships/<name>`;
 * - a string: `self` is that string, verbatim — for a relationship endpoint
 *   served at another path, or an absolute URL. It is not validated: any
 *   string, the empty string included, is written as given;
 * - `false`: no `self` member, for an API that declares no relationship
 *   endpoint for this relationship.
 *
 * `related` is always written, and always as the default
 * `/<type>/<id>/<name>` — the `self` option never changes it, so a custom
 * `self` under another prefix (say `/v2/…`) still pairs with an unprefixed
 * `related`. It is the only way to reach a paginated relationship's members.
 *
 * The option only shapes the relationship object. The pagination links of the
 * relationship endpoint's own response (`first`/`next`/`prev`/`last`) are built
 * by its handler, from whatever path it serves, with {@link offsetPaginationLinks}
 * and its siblings; nothing here feeds them.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Handlers, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString },
 *   relationships: { articles: Relationship.paginated(() => Article) }
 * })
 *
 * const id = Person.Id.make("9")
 * const attributes = { firstName: "Dan", lastName: "Gebhardt" }
 *
 * // The API declares `Endpoint.getRelationship(Person, "articles")`:
 * Person.make({
 *   id,
 *   attributes,
 *   relationships: {
 *     articles: Handlers.paginatedRelationship("people", id, "articles")
 *     // → { links: { self: "/people/9/relationships/articles",
 *     //              related: "/people/9/articles" } }
 *   }
 * })
 *
 * // The API declares no relationship endpoint for `articles`:
 * const linksOnly = Handlers.paginatedRelationship("people", id, "articles", { self: false })
 * console.log(linksOnly) // { links: { related: "/people/9/articles" } }
 * Person.make({ id, attributes, relationships: { articles: linksOnly } })
 *
 * // The relationship endpoint is served at another path:
 * console.log(
 *   Handlers.paginatedRelationship("people", id, "articles", {
 *     self: "/v2/people/9/relationships/articles"
 *   }).links.self
 * ) // "/v2/people/9/relationships/articles"
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const paginatedRelationship = <const Self extends string | false | undefined = undefined>(
  type: string,
  id: string,
  name: string,
  options?: {
    /**
     * The relationship's `self` link: omit it for
     * `/<type>/<id>/relationships/<name>`, pass a string to use that path
     * verbatim (not validated), or
     * `false` to leave `self` out — for an API that does not declare the
     * relationship endpoint.
     *
     * @since 0.17.0
     */
    readonly self?: Self;
  },
): Self extends false
  ? { readonly links: { readonly related: string } }
  : { readonly links: { readonly self: string; readonly related: string } } => {
  const self = options?.self ?? relationshipLink(type, id, name);
  const related = relatedLink(type, id, name);
  return {
    links: self === false ? { related } : { self, related },
  } as Self extends false
    ? { readonly links: { readonly related: string } }
    : { readonly links: { readonly self: string; readonly related: string } };
};

/**
 * The linkage shapes accepted by {@link linkage}: one identifier (to-one),
 * `null` (empty to-one), or an identifier array (to-many).
 *
 * @since 0.1.0
 * @category models
 */
export type LinkageValue = ResourceIdentifierValue | ReadonlyArray<ResourceIdentifierValue> | null;

// The builder's return type is conditional on its generics for the same
// reason as `DocumentValue` above.
// `included` is typed only when the builder is handed one, so a plain linkage
// document's type is what it was before compound relationship documents.
type LinkageDocumentValue<
  Data,
  M extends MetaValue,
  J extends JsonApiObjectValue = never,
  Included = never,
> = Simplify<
  { readonly data: Data; readonly links?: LinksValue } & ([Included] extends [never]
    ? unknown
    : { readonly included?: ReadonlyArray<Included> }) &
    ([M] extends [never] ? Record<never, never> : { readonly meta?: M }) &
    ([J] extends [never] ? Record<never, never> : { readonly jsonapi: J })
>;

// A transform applies to the *identifiers* a linkage document carries, one by
// one; the mapped type keeps a tuple a tuple.
type TransformedLinkage<F extends TransformLambda, Data> = Data extends null
  ? null
  : Data extends ReadonlyArray<ResourceIdentifierValue>
    ? { readonly [K in keyof Data]: Transformed<F, Data[K]> }
    : Transformed<F, Data>;

// A linkage document's top-level links: `self` and `related`, then `links`.
const linkageLinks = (
  options:
    | { readonly self?: string; readonly related?: string; readonly links?: LinksValue }
    | undefined,
): LinksValue | undefined =>
  options?.self === undefined && options?.related === undefined
    ? options?.links
    : {
        ...(options.self !== undefined ? { self: options.self } : {}),
        ...(options.related !== undefined ? { related: options.related } : {}),
        ...options.links,
      };

// The linkage with the transform applied to each identifier.
const applyToLinkage = (
  data: LinkageValue,
  onResource: ResourceTransform<TransformLambda> | undefined,
): LinkageValue =>
  onResource === undefined || data === null
    ? data
    : Array.isArray(data)
      ? mapResources(data, onResource)
      : (onResource(data as ResourceIdentifierValue) as ResourceIdentifierValue);

/**
 * Builds a relationship-linkage document value — what relationship-endpoint
 * handlers (`fetchRelationship` / `updateRelationship` / `addRelationship`)
 * return: `{ data, included?, links?, meta?, jsonapi? }` where `data` is
 * resource linkage.
 *
 * Pass `included` to build a compound relationship document — the answer to
 * `GET /articles/1/relationships/comments?include=comments.author` on an
 * `Endpoint.getRelationship` declaring `include`. As with {@link data}, an
 * array — even `[]` — emits the member, and `undefined` omits it. The members
 * go through {@link buildIncluded} with the linkage as its primary data:
 * they are deduplicated against each other but not against the identifiers
 * (an identifier is not a resource object, so `comments:5` in `data` and in
 * `included` is no duplicate), and full linkage is checked from the
 * identifiers themselves — each member must be one the linkage names or be
 * reachable from one through other members' relationships. Empty linkage
 * (`null`, `[]`) reaches nothing, so any member then fails the check. On a
 * `paginated` relationship the identifiers are one page, so the check holds
 * `included` to that page: a resource only another page names fails it.
 *
 * As with {@link data}, `jsonapi` is only emitted, and only narrows into the
 * return type, when you pass it — see {@link data} for why it is opt-in.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Handlers, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
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
 * // in a handler — `handlers` comes from HttpApiBuilder.group, `loadArticle` from your data layer
 * const relationshipHandler = (
 *   handlers: {
 *     handle: (
 *       name: string,
 *       handler: (request: { readonly params: { readonly id: string } }) => Effect.Effect<unknown>
 *     ) => void
 *   },
 *   loadArticle: (id: string) => Effect.Effect<typeof Article.Type>
 * ) =>
 *   handlers.handle("commentsRelationship", ({ params }) =>
 *     loadArticle(params.id).pipe(
 *       Effect.map((article) =>
 *         Handlers.linkage(article.relationships?.comments.data ?? null, {
 *           self: Handlers.relationshipLink("articles", article.id, "comments"),
 *           related: Handlers.relatedLink("articles", article.id, "comments")
 *         })
 *       )
 *     )
 *   )
 * ```
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Handlers, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { name: Schema.NonEmptyString }
 * })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 *
 * const author = Person.make({ id: Person.Id.make("9"), attributes: { name: "Dan" } })
 * const comment = Comment.make({
 *   id: Comment.Id.make("5"),
 *   attributes: { body: "First!" },
 *   relationships: { author: { data: Person.ref(author.id) } }
 * })
 *
 * // GET /articles/1/relationships/comments?include=comments.author: the
 * // identifiers as `data`, the comments and their authors as `included`
 * const document = Handlers.linkage([Comment.ref(comment.id)], {
 *   included: [comment, author],
 *   self: Handlers.relationshipLink("articles", "1", "comments")
 * })
 *
 * console.log(document.data)                     // → [ { type: "comments", id: "5" } ]
 * console.log(document.included?.map((r) => r.type)) // → [ "comments", "people" ]
 * ```
 *
 * @since 0.1.0 (`included` and `checkLinkage` since 0.18.0)
 * @category constructors
 */
export const linkage = <
  const Data extends LinkageValue,
  const M extends MetaValue = never,
  const J extends JsonApiObjectValue = never,
  F extends TransformLambda = IdentityLambda,
  const Included extends ResourceValue = never,
>(
  data: Data,
  options?: {
    /**
     * The compound relationship document's members: the resources the
     * linkage names and those reached from them, for a request carrying
     * `include`. An array — even `[]` — emits `included`; `undefined` omits
     * it. Deduplicated among themselves (never against the identifiers) and
     * checked for full linkage from the identifiers ({@link buildIncluded}).
     *
     * @since 0.18.0
     */
    readonly included?: ReadonlyArray<Included> | undefined;
    /**
     * `false` skips the full-linkage check on `included`, which is on by
     * default — as on {@link data}.
     *
     * @since 0.18.0
     */
    readonly checkLinkage?: boolean | undefined;
    readonly meta?: M;
    /** The top-level `jsonapi` object, e.g. `Document.v1_1`. Omitted by default. */
    readonly jsonapi?: J;
    readonly self?: string;
    readonly related?: string;
    readonly links?: LinksValue;
    /**
     * Applied to every resource identifier the document carries, exactly once
     * each — the slot a relationship document's resources occupy (§8.4 makes
     * its primary data bare identifiers) — and to every deduplicated
     * `included` member. A fieldset projection is a no-op on an identifier,
     * which has no `attributes`; per-resource {@link withMeta} is not, and is
     * the reason the hook is here: the same resource must not describe
     * different capabilities in a relationship document than it does as an
     * `included` member elsewhere. An identifier and the `included` member it
     * names are shaped separately, each from its own value.
     *
     * @since 0.15.0
     */
    readonly onResource?: ResourceTransform<F> | undefined;
  },
): LinkageDocumentValue<TransformedLinkage<F, Data>, M, J, Transformed<F, Included>> => {
  const onResource = options?.onResource === undefined ? undefined : memoise(options.onResource);
  const transformed = applyToLinkage(data, onResource);
  // The identifiers are the primary data `included` is seeded from (#423). An
  // `included` member is shaped by its own pass, not the identifiers'
  // memoised one: the two share a `(type, id)` but not a shape.
  // SAFETY: `build` emits each member exactly when its option was passed, as
  // `LinkageDocumentValue` types it.
  return build(
    transformed,
    transformed === null ? [] : Arr.ensure(transformed),
    {
      included: options?.included,
      checkLinkage: options?.checkLinkage,
      meta: options?.meta,
      jsonapi: options?.jsonapi,
      links: linkageLinks(options),
    },
    options?.onResource,
    true,
  ) as LinkageDocumentValue<TransformedLinkage<F, Data>, M, J, Transformed<F, Included>>;
};

// ---------------------------------------------------------------------------
// Pagination links
// ---------------------------------------------------------------------------

/**
 * Options of the pagination link builders.
 *
 * @since 0.13.0
 * @category models
 */
export interface PaginationLinksOptions {
  /**
   * The request's canonical query pairs — `Query.canonicalPairs(listQuery)(query)`
   * — so every link carries the client's `include` / `fields` / `filter` /
   * `sort` alongside its page cursor. The pairs are already in canonical
   * order; each link's `page[*]` pairs take the place of any the list
   * carries.
   */
  readonly query?: ReadonlyArray<Pair>;
}

// A link to one page: the cursor's `page[*]` pairs, slotted into the
// request's other canonical pairs when given, serialised canonically.
const withPage = (
  path: string,
  page: Record<string, number>,
  query: ReadonlyArray<Pair> | undefined,
): string => {
  const cursor: ReadonlyArray<Pair> = Object.entries(page).map(([key, value]) => [
    `page[${key}]`,
    String(value),
  ]);
  return withQuery(path, serialise(query === undefined ? cursor : withPagePairs(query, cursor)));
};

// The links of an unpageable collection (a non-positive page size, which
// `page[limit]=0` can request): `self` keeps the request's canonical pairs as
// sent, its own `page[*]` included; nothing else can be linked.
const unpageable = (path: string, query: ReadonlyArray<Pair> | undefined): LinksValue => ({
  self: query === undefined ? path : withQuery(path, serialise(query)),
  first: null,
  prev: null,
  next: null,
  last: null,
});

/**
 * Builds the spec's pagination links (`self` / `first` / `prev` / `next` /
 * `last`) for offset/limit pagination.
 *
 * Links are serialised canonically (`Query.serialise`). Pass the request's
 * canonical pairs as `query` and every link carries them, each page cursor
 * slotted into the `page[*]` position (replacing the request's own), so
 * `next` / `prev` / `first` / `last` are the same query on another page and
 * `self` carries the **effective page window**: the request's canonical
 * string with the page defaults the server applied filled in. A request
 * without page keys (`?sort=-title`) canonicalises to `sort=-title`, while
 * its `self` is `sort=-title&page[offset]=0&page[limit]=<total>` — the
 * window the document actually covers. When the window is unpageable
 * (`limit <= 0`) `self` is the request's pairs as sent and the other links
 * are `null`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Handlers, Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * Handlers.offsetPaginationLinks("/articles", { offset: 0, limit: 10 }, 35)
 * // → { self: "/articles?page[offset]=0&page[limit]=10",
 * //     first: "/articles?page[offset]=0&page[limit]=10",
 * //     prev: null,
 * //     next: "/articles?page[offset]=10&page[limit]=10",
 * //     last: "/articles?page[offset]=30&page[limit]=10" }
 *
 * // …carrying the request's full query
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 * const listQuery = Query.schema(Article, { fields: true, sort: true, page: Query.Page.Offset })
 * const query: typeof listQuery.Type = {
 *   fields: { articles: ["title"] },
 *   sort: [{ field: "title", direction: "desc" }],
 *   page: { offset: 10, limit: 10 }
 * }
 *
 * Handlers.offsetPaginationLinks("/articles", query.page ?? {}, 35, {
 *   query: Query.canonicalPairs(listQuery)(query)
 * })
 * // → { self: "/articles?fields[articles]=title&sort=-title&page[offset]=10&page[limit]=10",
 * //     first: "/articles?fields[articles]=title&sort=-title&page[offset]=0&page[limit]=10",
 * //     prev: "/articles?fields[articles]=title&sort=-title&page[offset]=0&page[limit]=10",
 * //     next: "/articles?fields[articles]=title&sort=-title&page[offset]=20&page[limit]=10",
 * //     last: "/articles?fields[articles]=title&sort=-title&page[offset]=30&page[limit]=10" }
 * ```
 *
 * @see {@link https://jsonapi.org/format/1.1/#fetching-pagination}
 * @since 0.1.0
 * @category constructors
 */
export const offsetPaginationLinks = (
  path: string,
  page: { readonly offset?: number; readonly limit?: number },
  total: number,
  options?: PaginationLinksOptions,
): LinksValue => {
  const limit = page.limit ?? total;
  const offset = page.offset ?? 0;
  const query = options?.query;
  if (limit <= 0) return unpageable(path, query);
  const lastOffset = Math.floor(Math.max(total - 1, 0) / limit) * limit;
  return {
    self: withPage(path, { offset, limit }, query),
    first: withPage(path, { offset: 0, limit }, query),
    prev: offset > 0 ? withPage(path, { offset: Math.max(offset - limit, 0), limit }, query) : null,
    next: offset + limit < total ? withPage(path, { offset: offset + limit, limit }, query) : null,
    last: withPage(path, { offset: lastOffset, limit }, query),
  };
};

/**
 * Builds the spec's pagination links for page-number/size pagination.
 *
 * Links are serialised canonically (`Query.serialise`); pass the request's
 * canonical pairs as `query` and every link carries them, `self` with the
 * effective page window — see {@link offsetPaginationLinks}.
 *
 * @example
 * ```ts
 * import { Handlers } from "@thomasfosterau/effect-jsonapi"
 *
 * Handlers.numberPaginationLinks("/articles", { number: 2, size: 10 }, 35)
 * // → { self: "/articles?page[number]=2&page[size]=10",
 * //     first: "/articles?page[number]=1&page[size]=10",
 * //     prev: "/articles?page[number]=1&page[size]=10",
 * //     next: "/articles?page[number]=3&page[size]=10",
 * //     last: "/articles?page[number]=4&page[size]=10" }
 *
 * // …carrying the request's other canonical pairs
 * Handlers.numberPaginationLinks("/articles", { number: 2, size: 10 }, 35, { query: [["sort", "-title"]] })
 * // → { self: "/articles?sort=-title&page[number]=2&page[size]=10", … }
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const numberPaginationLinks = (
  path: string,
  page: { readonly number?: number; readonly size?: number },
  total: number,
  options?: PaginationLinksOptions,
): LinksValue => {
  const size = page.size ?? total;
  const number = page.number ?? 1;
  const query = options?.query;
  if (size <= 0) return unpageable(path, query);
  const lastPage = Math.max(Math.ceil(total / size), 1);
  return {
    self: withPage(path, { number, size }, query),
    first: withPage(path, { number: 1, size }, query),
    prev: number > 1 ? withPage(path, { number: number - 1, size }, query) : null,
    next: number < lastPage ? withPage(path, { number: number + 1, size }, query) : null,
    last: withPage(path, { number: lastPage, size }, query),
  };
};
