/**
 * Declaring a resource's `?include=` surface **once**.
 *
 * Serving compound documents correctly needs three things to agree:
 *
 *   1. a whitelist of the dotted paths the endpoint accepts, so an unserved
 *      path is rejected (400) rather than silently answered with an empty
 *      `included`;
 *   2. the `included` member's union in the success schema — `HttpApiBuilder`
 *      strips a resolved `included` whose schema doesn't declare the union, so
 *      getting this wrong means the walk runs and the client receives nothing;
 *   3. the advertised `include` query parameter, present only on endpoints
 *      that actually serve a walk.
 *
 * A {@link Surface} is one nested declaration all three project from, so they
 * cannot drift:
 *
 * ```ts
 * const surface = Include.make(Article, {
 *   author: Person,
 *   comments: Include.nested(Comment, { author: Person })
 * })
 *
 * surface.paths    // ["author", "comments", "comments.author"] — the whitelist
 * surface.included // Schema.Union([Person, Comment])           — the `included` union
 *
 * Endpoint.get(Article, { include: surface })                   // the advertised parameter
 * ```
 *
 * Three properties are load-bearing:
 *
 *   - **The whitelist spells depth.** `comments` and `comments.author` are
 *     separate entries, so `comments.editor` is rejected even though
 *     `comments` is includable. Matching only a path's head segment — which a
 *     flat whitelist forces — would admit any deep path on the strength of its
 *     first hop. {@link Query.Include} validates against the whole dotted
 *     path.
 *   - **Nesting only ever *adds* paths.** Wrapping a key in {@link nested}
 *     keeps `?include=<key>` meaning exactly what it did.
 *   - **The union carries every depth.** A walk that hoists a Comment *and*
 *     the Person behind it needs both arms, or the deeper one is stripped on
 *     encode. Deriving the union from the same declaration is what stops the
 *     hand-widened "the document's union is wider than the surface's own"
 *     divergence.
 *
 * ## Depth
 *
 * The derivation recurses over the **declaration you wrote**, not over the
 * resource graph, so it terminates by construction: a spec is a finite object
 * literal and cannot be made cyclic (a `const` cannot reference itself in its
 * own initialiser). That is what lifts the graph-derived
 * {@link Resource.IncludePath}'s hard depth-2 ceiling — depth becomes a
 * property of what you wrote rather than of TypeScript's inference budget.
 *
 * The recursion is nonetheless capped, explicitly, at {@link MAX_DEPTH} hops,
 * so a pathological declaration degrades predictably instead of exhausting
 * TypeScript's instantiation budget. The cap is enforced on **both** sides and
 * the two agree: the type-level derivation truncates past it, and
 * {@link make} / {@link paths} throw on a path that exceeds it — so an
 * over-deep surface fails loudly at module initialisation rather than quietly
 * advertising fewer paths than it declares.
 *
 * @since 0.15.0
 */
import { Schema } from "effect"
import type { Any, IncludableKeys, Target } from "./Resource.js"

// The discriminant key both a branch and a surface carry, so neither can be
// confused with a resource definition (or with `Query.IncludeOptions`, whose
// keys are `paths` / `depth`).
const TAG = "~@thomasfosterau/effect-jsonapi/include"

// ---------------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------------

/**
 * The maximum number of hops a declared include surface may take — the
 * explicit bound on the derivation's recursion.
 *
 * Six hops is far beyond any path a real JSON:API client asks for
 * (`?include=a.b.c.d.e.f`), and bounding it keeps a pathological declaration
 * from exhausting TypeScript's instantiation budget with an unhelpful
 * "type instantiation is excessively deep" error.
 *
 * The bound is enforced identically at both levels: {@link Paths} and
 * {@link Members} truncate past it, and {@link make} / {@link paths} /
 * {@link included} throw on a path that exceeds it, so the whitelist a surface
 * advertises is always exactly the one its type describes.
 *
 * @example
 * ```ts
 * import { Include } from "@thomasfosterau/effect-jsonapi"
 *
 * Include.MAX_DEPTH // 6
 * ```
 *
 * @since 0.15.0
 * @category constants
 */
export const MAX_DEPTH = 6

/**
 * The type-level counterpart of {@link MAX_DEPTH}.
 *
 * @since 0.15.0
 * @category type-level
 */
export type MaxDepth = typeof MAX_DEPTH

// The recursion budget, as a tuple whose *length* is `MAX_DEPTH`. A tuple
// counter is used rather than arithmetic on a numeric literal because it costs
// one instantiation per level and can never diverge.
type Budget = readonly [unknown, unknown, unknown, unknown, unknown, unknown]

// One hop's worth of budget spent.
type Spend<D extends ReadonlyArray<unknown>> = D extends readonly [unknown, ...infer Rest] ? Rest : readonly []

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

/**
 * A relationship key whose target can itself be walked further — what
 * {@link nested} builds.
 *
 * The erased form, for accepting "any branch". {@link Branch} is the precise
 * one.
 *
 * @since 0.15.0
 * @category models
 */
export interface AnyBranch {
  readonly "~@thomasfosterau/effect-jsonapi/include": "branch"
  /** The resource this key points at. */
  readonly target: Any
  /** The surface reachable *through* it. */
  readonly children: AnySpec
}

/**
 * An include-surface declaration, erased: a record of relationship keys, each
 * naming either the resource it points at (a leaf) or a {@link Branch} (a hop
 * that can be walked further).
 *
 * {@link Spec} is the form checked against a resource's relationship graph.
 *
 * @since 0.15.0
 * @category models
 */
export interface AnySpec {
  readonly [key: string]: Any | AnyBranch
}

/**
 * A walkable branch: the resource a relationship key points at, plus the
 * surface reachable through it.
 *
 * @since 0.15.0
 * @category models
 */
export interface Branch<R extends Any, S extends AnySpec> extends AnyBranch {
  readonly target: R
  readonly children: S
}

/**
 * An include-surface declaration for a resource: a subset of its
 * **includable** relationship keys (every key except `paginated` ones, whose
 * data is never inlined), each naming the resource that key targets — or a
 * {@link nested} branch over it.
 *
 * The constraint reaches exactly one hop: a branch's own children are checked
 * against *its* target by {@link nested}'s signature, at the call site that
 * writes them. Checking the whole nesting in one constraint would have to
 * recurse through the resource graph, which is unbounded whenever the graph
 * has a cycle — the recursion here is over the finite declaration instead.
 *
 * @since 0.15.0
 * @category models
 */
export type Spec<R extends Any> = {
  readonly [K in IncludableKeys<R>]?: Target<R, K> | Branch<Target<R, K>, AnySpec>
}

// Resolves to `T` for every concrete declaration; needed because `Spec<R>`
// can't be proven to satisfy `AnySpec` while `R` is still generic. The same
// device as `Resource`'s `AsFields`.
type AsSpec<T> = T extends AnySpec ? T : never

/**
 * Declares that a relationship key's target can itself be walked: the key
 * keeps meaning what it did, and every path of `children` is *added* below it.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Include, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Company = Resource.make("companies", {
 *   attributes: { name: Schema.NonEmptyString }
 * })
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString },
 *   relationships: { company: Relationship.one(() => Company) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 *
 * // `author` still means `?include=author`; `author.company` is added below it
 * const surface = Include.make(Article, {
 *   author: Include.nested(Person, { company: Company })
 * })
 *
 * surface.paths // ["author", "author.company"]
 * ```
 *
 * @since 0.15.0
 * @category constructors
 */
export const nested = <R extends Any, const S extends Spec<R>>(target: R, children: S): Branch<R, AsSpec<S>> => {
  // Annotated rather than cast, so that `TAG` drifting from the discriminant
  // the interfaces declare would be a compile error here.
  const branch: Branch<R, AsSpec<S>> = {
    [TAG]: "branch",
    target,
    children: children as AsSpec<S>
  }
  return branch
}

/**
 * Whether a value is a {@link nested} branch rather than a resource
 * definition.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Include, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString }
 * })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 *
 * Include.isBranch(Include.nested(Comment, { author: Person })) // true
 * Include.isBranch(Person) // false
 * ```
 *
 * @since 0.15.0
 * @category guards
 */
export const isBranch = (u: unknown): u is AnyBranch =>
  typeof u === "object" && u !== null && (u as Record<string, unknown>)[TAG] === "branch"

// ---------------------------------------------------------------------------
// The derivations
// ---------------------------------------------------------------------------

// The dotted-path derivation, one hop per level of remaining budget. A leaf
// contributes its key; a branch contributes its key *and* every path below it,
// so nesting only ever adds paths. Past the budget the recursion yields
// `never`, and `${K}.${never}` collapses to `never` — the deeper paths drop
// out while the shallower ones stand.
type PathsAt<S, D extends ReadonlyArray<unknown>> = D extends readonly []
  ? never
  : {
      [K in keyof S & string]: S[K] extends { readonly children: infer C } ? K | `${K}.${PathsAt<C, Spend<D>>}` : K
    }[keyof S & string]

/**
 * The dotted `?include=` paths a declaration legalises, as a union of string
 * literals — **every** depth, in the spec's §7.1 grammar.
 *
 * `comments` and `comments.author` are separate members, so a whitelist built
 * from this rejects `comments.editor` even though `comments` is includable.
 *
 * Recursion is over the declaration, bounded by {@link MAX_DEPTH}.
 *
 * @since 0.15.0
 * @category type-level
 */
export type Paths<S extends AnySpec> = PathsAt<S, Budget>

// The target derivation, structurally identical to `PathsAt` — same walk, same
// budget, so the union can never describe a different set of hops than the
// whitelist does.
type MembersAt<S, D extends ReadonlyArray<unknown>> = D extends readonly []
  ? never
  : {
      [K in keyof S]: S[K] extends { readonly target: infer T; readonly children: infer C }
        ? T | MembersAt<C, Spend<D>>
        : S[K]
    }[keyof S]

/**
 * The resource definitions a declaration brings into a compound document —
 * every depth, not just the leaves: a walk that hoists a Comment and the
 * Person behind it contributes both.
 *
 * A union deduplicates identical members on its own; {@link included} does the
 * same at runtime by schema **identity**, so two keys pointing at the same
 * resource contribute one member while two distinct resources that happen to
 * share a shape stay distinct.
 *
 * @since 0.15.0
 * @category type-level
 */
export type Members<S extends AnySpec> = Extract<MembersAt<S, Budget>, Any>

/**
 * The `included` union a declaration derives: a `Schema.Union` over its
 * {@link Members}, flat and deduplicated.
 *
 * This is what a success document's `included` member must be declared as —
 * `HttpApiBuilder` strips resources the union doesn't admit.
 *
 * @since 0.15.0
 * @category models
 */
export interface Included<S extends AnySpec> extends Schema.Union<ReadonlyArray<Members<S>>> {}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

/**
 * A declared include surface, erased — the form the endpoint constructors and
 * {@link Query.Include} accept. {@link Surface} is the precise one.
 *
 * @since 0.15.0
 * @category models
 */
export interface AnySurface {
  readonly "~@thomasfosterau/effect-jsonapi/include": "surface"
  readonly resource: Any
  readonly paths: ReadonlyArray<string>
  readonly included: Schema.Top
  readonly targets: ReadonlyMap<string, Any>
  has(path: string): boolean
}

/**
 * One resource's declared `?include=` surface: the single declaration the
 * whitelist, the `included` union and the advertised parameter all project
 * from.
 *
 * Built by {@link make}. Pass it as an endpoint's `include` option and all
 * three follow from it at once.
 *
 * @since 0.15.0
 * @category models
 */
export interface Surface<R extends Any, S extends AnySpec> {
  readonly "~@thomasfosterau/effect-jsonapi/include": "surface"
  /** The resource whose surface this is. */
  readonly resource: R
  /** The declaration itself. */
  readonly spec: S
  /**
   * The accepted dotted paths, every depth, in walk order (a parent always
   * precedes the paths below it). The whitelist {@link Query.Include}
   * validates against — as whole paths, never head segments.
   */
  readonly paths: ReadonlyArray<Paths<S>>
  /** The `included` member's union: every resource the walk can hoist. */
  readonly included: Included<S>
  /**
   * Each accepted path mapped to the resource definition it resolves to.
   * Because nesting only ever adds paths, every prefix of an accepted path is
   * itself an accepted path, so a resolver stepping one level at a time can
   * look up the target type of each hop it is about to load.
   */
  readonly targets: ReadonlyMap<string, Members<S>>
  /**
   * Whether a path is on the whitelist — the whole dotted path, not its head
   * segment.
   */
  has(path: string): path is Paths<S>
}

/**
 * A declared surface over a particular resource, whatever it declares — the
 * constraint an `include` option uses to accept "this resource's surface".
 *
 * @since 0.15.0
 * @category models
 */
export type SurfaceFor<R extends Any> = AnySurface & { readonly resource: R }

/**
 * Whether a value is a declared include {@link Surface} — as opposed to a
 * boolean, or a `Query.IncludeOptions` object.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Include, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 *
 * Include.isSurface(Include.make(Article, { author: Person })) // true
 * Include.isSurface({ paths: ["author"] }) // false
 * ```
 *
 * @since 0.15.0
 * @category guards
 */
export const isSurface = (u: unknown): u is AnySurface =>
  typeof u === "object" && u !== null && (u as Record<string, unknown>)[TAG] === "surface"

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

interface Entry {
  readonly path: string
  readonly target: Any
}

// Checks one hop against the resource graph, so a surface cannot advertise a
// path the resource doesn't have. `owner` is absent for the standalone
// projections, which take a declaration without a resource to check it against.
const checkHop = (owner: Any, key: string, target: Any, path: string): void => {
  const descriptor = owner.relationships[key]
  if (descriptor === undefined) {
    throw new Error(`Include: "${path}" — resource "${owner.type}" declares no relationship "${key}"`)
  }
  if (descriptor.kind === "paginated") {
    throw new Error(
      `Include: "${path}" — relationship "${key}" on "${owner.type}" is paginated; ` +
        "a paginated relationship carries no inline linkage and is never included"
    )
  }
  const declared = descriptor.ref()
  if (declared.type !== target.type) {
    throw new Error(
      `Include: "${path}" — relationship "${key}" on "${owner.type}" targets "${declared.type}", ` +
        `but the surface declares "${target.type}"`
    )
  }
}

// The one walk every projection reads: depth-first, a parent emitted before
// everything below it, so `paths` order is walk order and a prefix always
// precedes the paths it prefixes.
const walk = (owner: Any | undefined, spec: AnySpec, prefix: string, depth: number, out: Array<Entry>): void => {
  for (const [key, value] of Object.entries(spec)) {
    // `Spec` marks every key optional, so an explicitly-undefined key is
    // representable; it declares nothing.
    if (value === undefined) continue
    const path = prefix === "" ? key : `${prefix}.${key}`
    if (depth > MAX_DEPTH) {
      throw new Error(`Include: "${path}" is ${depth} hops deep, past the ${MAX_DEPTH}-hop maximum (Include.MAX_DEPTH)`)
    }
    const branch = isBranch(value)
    const target = branch ? value.target : (value as Any)
    if (owner !== undefined) checkHop(owner, key, target, path)
    out.push({ path, target })
    if (branch) walk(target, value.children, path, depth + 1, out)
  }
}

const entriesOf = (owner: Any | undefined, spec: AnySpec): ReadonlyArray<Entry> => {
  const out: Array<Entry> = []
  walk(owner, spec, "", 1, out)
  return out
}

// ---------------------------------------------------------------------------
// The projections
// ---------------------------------------------------------------------------

/**
 * The dotted-path whitelist a declaration legalises: every path at every
 * depth, in the spec's §7.1 grammar, in walk order.
 *
 * This is the standalone projection; a {@link Surface} carries the same value
 * as its `paths`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Include, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString }
 * })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 *
 * Include.paths({ author: Person, comments: Include.nested(Comment, { author: Person }) })
 * // → ["author", "comments", "comments.author"]
 * ```
 *
 * @since 0.15.0
 * @category accessors
 */
export const paths = <const S extends AnySpec>(spec: S): ReadonlyArray<Paths<S>> => {
  const seen = new Set<string>()
  const out: Array<string> = []
  for (const entry of entriesOf(undefined, spec)) {
    if (seen.has(entry.path)) continue
    seen.add(entry.path)
    out.push(entry.path)
  }
  return out as unknown as ReadonlyArray<Paths<S>>
}

/**
 * The `included` union a declaration derives: one flat `Schema.Union` over
 * every resource the walk can hoist, at every depth.
 *
 * Members are deduplicated by schema **identity**, in walk order — two keys
 * pointing at the same resource contribute one member, and two genuinely
 * distinct resources that happen to share a shape do not collapse. The walk
 * appends to one flat list, so no nested unions arise to flatten.
 *
 * This is the standalone projection; a {@link Surface} carries the same schema
 * as its `included`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Include, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString }
 * })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 *
 * // `author` and `comments.author` are the same resource: one member, not two
 * const union = Include.included({
 *   author: Person,
 *   comments: Include.nested(Comment, { author: Person })
 * })
 *
 * union.members.length // 2
 * ```
 *
 * @since 0.15.0
 * @category accessors
 */
export const included = <const S extends AnySpec>(spec: S): Included<S> => {
  const seen = new Set<Any>()
  const members: Array<Any> = []
  for (const entry of entriesOf(undefined, spec)) {
    if (seen.has(entry.target)) continue
    seen.add(entry.target)
    members.push(entry.target)
  }
  return Schema.Union(members) as unknown as Included<S>
}

/**
 * Declares a resource's `?include=` surface — the one declaration the
 * whitelist, the `included` union and the advertised parameter all project
 * from.
 *
 * Every key must be one of the resource's **includable** relationships (a
 * `paginated` relationship carries no inline linkage, so it is never
 * includable) and must name the resource that relationship actually targets;
 * both are compile errors, and both are re-checked at construction so a
 * surface built from erased values can't advertise a path the graph doesn't
 * have. A declaration deeper than {@link MAX_DEPTH} hops throws here rather
 * than quietly advertising fewer paths than it declares.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Endpoint, Group, Include, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
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
 * // One declaration…
 * const surface = Include.make(Article, {
 *   author: Person,
 *   comments: Include.nested(Comment, { author: Person })
 * })
 *
 * surface.paths                 // ["author", "comments", "comments.author"]
 * surface.included.members.length // 2 — Person and Comment
 * surface.has("comments.author")  // true
 * surface.has("comments.editor")  // false — the whole path is matched
 *
 * // …and the endpoints project all three from it
 * const articles = Group.make(
 *   Article,
 *   Endpoint.get(Article, { include: surface }),
 *   Endpoint.list(Article, { include: surface })
 * )
 * ```
 *
 * @since 0.15.0
 * @category constructors
 */
export const make = <R extends Any, const S extends Spec<R>>(resource: R, spec: S): Surface<R, AsSpec<S>> => {
  const entries = entriesOf(resource, spec as AsSpec<S>)
  if (entries.length === 0) {
    throw new Error(
      `Include.make: the surface for "${resource.type}" declares no paths; ` +
        "omit the `include` option entirely for an endpoint that serves no walk"
    )
  }

  const seenPath = new Set<string>()
  const targets = new Map<string, Any>()
  const declared: Array<string> = []
  const seenTarget = new Set<Any>()
  const members: Array<Any> = []
  for (const entry of entries) {
    if (!seenPath.has(entry.path)) {
      seenPath.add(entry.path)
      declared.push(entry.path)
      targets.set(entry.path, entry.target)
    }
    if (!seenTarget.has(entry.target)) {
      seenTarget.add(entry.target)
      members.push(entry.target)
    }
  }

  // Built against the erased shape first — which pins `TAG` to the discriminant
  // the interfaces declare — then widened to the precise one, whose `paths` and
  // `targets` are the derived literals the runtime walk produced.
  const surface: AnySurface = {
    [TAG]: "surface",
    resource,
    paths: declared,
    included: Schema.Union(members),
    targets,
    has: (path: string) => seenPath.has(path)
  }
  return { ...surface, spec } as unknown as Surface<R, AsSpec<S>>
}
