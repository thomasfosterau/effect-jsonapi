/**
 * The link an endpoint serves, as an endpoint annotation `Handlers.links`
 * reads to build resource and relationship links from the route table.
 *
 * @internal
 */
import * as Context from "effect/Context";

/**
 * The key of the link an endpoint's URL is: a resource's `self`, or a
 * relationship's `self` (its linkage) or `related` resource(s).
 *
 * @internal
 */
export class LinkRoutes extends Context.Service<LinkRoutes, string>()(
  "effect-jsonapi/LinkRoutes",
) {}

/** @internal */
export const resourceSelf = (type: string): string => `self ${type}`;

/** @internal */
export const relationshipSelf = (type: string, name: string): string => `self ${type} ${name}`;

/** @internal */
export const relationshipRelated = (type: string, name: string): string =>
  `related ${type} ${name}`;
