/**
 * The resources a read endpoint's `include` option brings into reach, at the
 * type level and at runtime alike: the legal include paths, the resources
 * those paths reach, and from them the types the endpoint's `included` union
 * admits (`Endpoint`'s default document, #320) and the types `fields: true`
 * declares a sparse fieldset for (`Query.FieldsetResources`, #311).
 *
 * Both consumers derive from this one walk, so the resources a document can
 * carry and the fieldsets a client can request for them cannot drift apart.
 *
 * @internal
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import type { IncludePathsOf } from "../Query.js";
import type { Any, IncludableTargets, ResolveIncludePath } from "../Resource.js";
import { directTargets, includePaths, isFamily } from "../Resource.js";

// Each resource once, by identity, first occurrence first.
const dedupe = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> =>
  Arr.dedupeWith(values, (a, b) => a === b);

/**
 * Whether an `include` option turns the parameter on: `true`, or an object
 * (`Query.IncludeOptions` or a declared `Include.Surface`). Everything else
 * (`false`, absent, a widened `boolean`) leaves it off.
 */
export type IncludeEnabled<I> = [I] extends [true] ? true : [I] extends [object] ? true : false;

/**
 * Whether an `include` option is a declared `Include.Surface`, whose own
 * `included` union replaces the relationship graph's default.
 */
export type DeclaresSurface<I> = [I] extends [
  { readonly "~@thomasfosterau/effect-jsonapi/include": "surface" },
]
  ? true
  : false;

// The direct targets a response may carry beside the include paths' walk:
// each member's non-`paginated` relationship targets, the default `included`
// union (`Resource.DefaultIncluded`), which a server MAY include by default —
// none under a declared surface, whose own `included` union replaces that
// default. A `paginated` relationship's target never appears in `included`.
type DefaultTargets<R extends Any, I> =
  DeclaresSurface<I> extends true
    ? never
    : R extends Any
      ? IncludableTargets<R["relationships"]>
      : never;

// The resource definitions each of `R`'s members reaches along `Paths`. The
// paths are the whole endpoint's, so on a heterogeneous endpoint each member
// walks every path, and one it has no includable relationship for reaches
// nothing — `Resource.ResolveIncludePath`, which never crosses a `paginated`
// relationship.
type ReachedBy<R extends Any, Paths> = ResolveIncludePath<R, Paths>;

/**
 * The resource definitions a response of an endpoint over `R` with the
 * `include` option `I` can carry in `included`: the non-`paginated` direct
 * targets (unless `I` is a declared `Include.Surface`) and, when `I` turns
 * `include` on, every resource a legal include path reaches — the leaf of each
 * path and every resource on the way to it. The walk is bounded as the paths
 * are: two hops under `include: true`, the `depth` a `Query.IncludeOptions`
 * names, or the exact `paths` of an allow-list or a surface.
 *
 * Distributes over unions of resource definitions.
 */
export type IncludedResources<R extends Any, I> =
  | DefaultTargets<R, I>
  | (IncludeEnabled<I> extends true ? ReachedBy<R, IncludePathsOf<R, I>> : never);

/**
 * `R` with every `Resource.family` in it replaced by its members, and a
 * member that is itself a family by that family's members in turn. A
 * family's `type` is its name, never a wire type: the resource objects a
 * response carries for it are its members', so a sparse fieldset names a
 * member type, and the family itself names none (#350). A plain resource
 * definition stays as it is, including one whose `type` is a family's name
 * (the base of a base-anchored family, reached in its own right).
 *
 * Distributes over unions of resource definitions.
 */
export type ExpandFamilies<R> = R extends {
  readonly members: ReadonlyArray<infer M extends Any>;
}
  ? ExpandFamilies<M>
  : R;

/**
 * The runtime {@link ExpandFamilies}: each resource, a family replaced by its
 * members (recursively, for a family among them), each once.
 */
export const expandFamilies = (resources: ReadonlyArray<Any>): ReadonlyArray<Any> =>
  dedupe(resources.flatMap((r) => (isFamily(r) ? expandFamilies(r.members) : [r])));

/**
 * The include paths an `include` option legalises, at runtime. A declared
 * `Include.Surface` and an explicit `paths` allow-list are the same shape here
 * — both carry the whole dotted paths to legalise — so both take the first
 * branch and neither is ever widened back to a graph walk.
 */
export const includePathsFor = (
  resources: ReadonlyArray<Any>,
  options?: { readonly paths?: ReadonlyArray<string>; readonly depth?: number },
): ReadonlyArray<string> =>
  options?.paths !== undefined
    ? dedupe(options.paths)
    : dedupe(resources.flatMap((r) => includePaths(r, options?.depth ?? 2)));

// The resource definitions `resource` reaches along an include path's
// segments: every resource on the way down, its leaf included, stopping at the
// first segment that names none of the current resource's relationships or
// names a `paginated` one. The runtime mirror of `ReachedBy`.
const reachedBy = (resource: Any, segments: ReadonlyArray<string>): ReadonlyArray<Any> =>
  Arr.matchLeft(segments, {
    onEmpty: (): ReadonlyArray<Any> => [],
    onNonEmpty: (segment, rest) =>
      Option.match(Rec.get(resource.relationships, segment), {
        onNone: (): ReadonlyArray<Any> => [],
        onSome: (descriptor) => {
          if (descriptor.kind === "paginated") return [];
          const target = descriptor.ref();
          return [target, ...reachedBy(target, rest)];
        },
      }),
  });

/**
 * The runtime mirror of {@link IncludedResources}: the resources'
 * non-`paginated` direct targets unless `include` is a declared `surface`,
 * then every resource the endpoint's legal include `paths` reach (none while
 * `include` is off), in that order and without repeats.
 */
export const includedResources = (
  resources: ReadonlyArray<Any>,
  surface: boolean,
  paths: ReadonlyArray<string>,
): ReadonlyArray<Any> =>
  dedupe([
    ...(surface ? [] : resources.flatMap(directTargets)),
    ...paths.flatMap((path) =>
      resources.flatMap((resource) => reachedBy(resource, path.split("."))),
    ),
  ]);
