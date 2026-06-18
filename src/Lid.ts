/**
 * Lid (local id) resolution.
 *
 * JSON:API v1.1 lets clients identify resources they are creating — before the
 * server has assigned them an `id` — with a `lid` (local id): in creation
 * payloads, and across the operations of an atomic operations request, where
 * later operations may reference resources created by earlier ones.
 *
 * {@link lidMap} is the server-side counterpart: while a handler processes a
 * request, it records the real id assigned to each lid and resolves lid-based
 * refs back to typed identifiers — including inside relationship linkage.
 *
 * ```ts
 * const lids = lidMap()
 *
 * // when a creation with a lid succeeds:
 * lids.assign(operation.data.lid, createdId)
 *
 * // when a later operation references it:
 * const ref = lids.identifier(Article, operation.ref)          // { type, id }
 * const linkage = lids.resolveLinkage(Article, operation.data.relationships)
 * ```
 */
import type { MetaValue } from "./Handlers.js"
import type * as Relationship from "./Relationship.js"
import type { Any, RefValue } from "./Resource.js"

/**
 * Thrown when resolving a ref whose `lid` was never assigned an id — the
 * client referenced a local id that no earlier operation declared.
 */
export class UnknownLidError extends Error {
  override readonly name = "UnknownLidError"
  readonly lid: string
  constructor(lid: string) {
    super(`Unknown lid "${lid}": no resource with this local id was created by an earlier operation in the request`)
    this.lid = lid
  }
}

/**
 * The minimal runtime shape of relationship linkage holding refs (identifiers
 * that may be lid-based).
 */
export interface RefLinkageValue {
  readonly [key: string]: {
    readonly data?: RefValue | ReadonlyArray<RefValue> | null
    readonly meta?: MetaValue
  }
}

/**
 * Maps relationship-descriptor records to their resolved (id-based) linkage
 * value type — the shape the resource's own schemas expect:
 *
 *   - `one` → `{ data: identifier }` (never null)
 *   - `optional` → `{ data: identifier | null }`
 *   - `many` → `{ data: identifier[] }`
 *   - `paginated` → excluded (no inline linkage)
 */
export type ResolvedLinkage<R extends Any> = {
  readonly [K in keyof R["relationships"] as R["relationships"][K] extends Relationship.Paginated<Any>
    ? never
    : K]?: R["relationships"][K] extends Relationship.One<infer T>
    ? { readonly data: T["identifier"]["Type"]; readonly meta?: MetaValue }
    : R["relationships"][K] extends Relationship.Optional<infer T>
      ? { readonly data: T["identifier"]["Type"] | null; readonly meta?: MetaValue }
      : R["relationships"][K] extends Relationship.Many<infer T>
        ? { readonly data: ReadonlyArray<T["identifier"]["Type"]>; readonly meta?: MetaValue }
        : never
}

/**
 * Tracks the server-assigned ids of resources created with `lid`s while a
 * handler processes a request, and resolves lid-based refs to real
 * identifiers.
 *
 * Resolution throws {@link UnknownLidError} for lids no earlier operation
 * assigned — convert it to your 4xx error of choice with `Effect.try`.
 */
export interface LidMap {
  /** Records the server-assigned id for a lid. */
  readonly assign: (lid: string, id: string) => void
  /** The id assigned to a lid, if any. */
  readonly id: (lid: string) => string | undefined
  /**
   * Resolves a ref (id- or lid-based) to the resource's typed identifier.
   * Throws {@link UnknownLidError} for unassigned lids.
   */
  readonly identifier: <R extends Any>(resource: R, ref: RefValue) => R["identifier"]["Type"]
  /**
   * Resolves every lid-based identifier inside relationship linkage to an
   * id-based identifier — the shape the resource's own relationship schemas
   * expect. `undefined` linkage resolves to an empty record. Throws
   * {@link UnknownLidError} for unassigned lids.
   */
  readonly resolveLinkage: <R extends Any>(
    resource: R,
    relationships: RefLinkageValue | undefined
  ) => ResolvedLinkage<R>
}

/**
 * Creates an empty {@link LidMap}.
 */
export const lidMap = (): LidMap => {
  const ids = new Map<string, string>()

  const resolveRef = (ref: RefValue): { readonly type: string; readonly id: string } => {
    if ("id" in ref) return ref
    const id = ids.get(ref.lid)
    if (id === undefined) throw new UnknownLidError(ref.lid)
    return { type: ref.type, id }
  }

  return {
    assign: (lid, id) => {
      ids.set(lid, id)
    },
    id: (lid) => ids.get(lid),
    identifier: <R extends Any>(resource: R, ref: RefValue) => {
      if (ref.type !== resource.type) {
        throw new Error(`Ref type "${ref.type}" does not match resource type "${resource.type}"`)
      }
      return resolveRef(ref) as R["identifier"]["Type"]
    },
    // `_resource` only pins down the return type.
    resolveLinkage: <R extends Any>(_resource: R, relationships: RefLinkageValue | undefined) => {
      if (relationships === undefined) return {} as ResolvedLinkage<R>
      const resolved: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(relationships)) {
        const linkage = value.data
        resolved[key] = {
          ...value,
          data:
            linkage === null || linkage === undefined
              ? null
              : Array.isArray(linkage)
                ? linkage.map(resolveRef)
                : resolveRef(linkage as RefValue)
        }
      }
      return resolved as ResolvedLinkage<R>
    }
  }
}
