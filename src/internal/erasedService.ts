/**
 * A `ResourceService.Service` with its resource erased, which the generic
 * layer and the built-in services are written against.
 *
 * @internal
 */
import type * as Effect from "effect/Effect";
import type { LinkageValue, ResourceIdentifierValue, ResourceValue } from "../Handlers.js";
import type {
  Complete,
  Definition,
  ListQuery,
  Page,
  ReadQuery,
  WriteData,
} from "../ResourceService.js";

type Of<A, E, R> = Effect.Effect<A, E, R>;

/**
 * Method signatures, whose parameters compare bivariantly, so every
 * `Service<Res, E, R>` is one.
 *
 * @internal
 */
export interface ErasedService<E = unknown, R = unknown> {
  find(id: string, query: ReadQuery): Of<ResourceValue, E, R>;
  findMany?(ids: ReadonlyArray<string>): Of<ReadonlyArray<ResourceValue>, E, R>;
  list?(query: ListQuery): Of<Page<ResourceValue>, E, R>;
  create?(data: WriteData): Of<ResourceValue, E, R>;
  update?(id: string, data: WriteData): Of<ResourceValue, E, R>;
  delete?(id: string): Of<void, E, R>;
  related?(id: string, relationship: string, query: ListQuery): Of<Page<ResourceValue>, E, R>;
  setRelationship?(id: string, relationship: string, data: LinkageValue): Of<void, E, R>;
  addToRelationship?(
    id: string,
    relationship: string,
    data: ReadonlyArray<ResourceIdentifierValue>,
  ): Of<void, E, R>;
  removeFromRelationship?(
    id: string,
    relationship: string,
    data: ReadonlyArray<ResourceIdentifierValue>,
  ): Of<void, E, R>;
}

/**
 * An erased service, typed back for the resource whose values it stores and
 * whose shapes it reads: the caller's guarantee, as a `SAFETY` comment.
 *
 * @internal
 */
export function forResource<Res extends Definition, E>(
  service: Required<ErasedService<E, never>>,
): Complete<Res, E>;
export function forResource(
  service: Required<ErasedService<unknown, never>>,
): Required<ErasedService<unknown, never>> {
  return service;
}
