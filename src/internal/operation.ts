/**
 * The JSON:API operation an endpoint constructor built, as an endpoint
 * annotation `ResourceService.layer` dispatches on, so a renamed or re-pathed
 * endpoint is still served by the operation it implements.
 *
 * @internal
 */
import * as Context from "effect/Context";

/** @internal */
export type Kind =
  | { readonly _tag: "get" | "list" | "create" | "update" | "delete"; readonly type: string }
  | {
      readonly _tag:
        | "related"
        | "relationship"
        | "updateRelationship"
        | "addRelationship"
        | "removeRelationship";
      readonly type: string;
      readonly relationship: string;
    };

/** @internal */
export class Operation extends Context.Service<Operation, Kind>()("effect-jsonapi/Operation") {}
