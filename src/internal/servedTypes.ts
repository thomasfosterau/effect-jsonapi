/**
 * The resource types a create or update endpoint serves, as an endpoint
 * annotation `Middleware.SchemaErrorsLive` reads to answer a payload whose
 * `data.type` is another type with JSON:API's 409 Conflict rather than the
 * generic 400 (#428).
 *
 * @internal
 */
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The `type`s a resource-object write endpoint accepts in `data.type`.
 *
 * @internal
 */
export class ServedTypes extends Context.Service<ServedTypes, ReadonlyArray<string>>()(
  "effect-jsonapi/ServedTypes",
) {}

// The JSON pointer every conflicting-type error object names.
const TYPE_PATH = ["data", "type"] as const;

/**
 * Whether a payload decode failure's leaf sits at `/data/type`, in the wire
 * names `wireLeaves` reports.
 *
 * @internal
 */
export const isTypePath = (path: ReadonlyArray<PropertyKey>): boolean =>
  path.length === TYPE_PATH.length && path.every((key, index) => key === TYPE_PATH[index]);

// A body's resource object `type`, when it sent one as a string; every other
// member is left to the payload schema that already rejected the body.
const decodeResourceObjectType = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Struct({ type: Schema.String }) })),
);

/**
 * The `data.type` a request body sent, when it is a string none of `served`
 * names: the resource object of another type JSON:API answers with 409
 * (§Creating Resources → 409 Conflict; §Updating Resources → 409 Conflict). A
 * body that is not JSON, has no resource object, or whose `type` is missing or
 * not a string is none — a malformed document, which stays a 400.
 *
 * @internal
 */
export const conflictingType = (
  body: string,
  served: ReadonlyArray<string>,
): Option.Option<string> =>
  Option.filter(
    Option.map(decodeResourceObjectType(body), ({ data }) => data.type),
    (type) => !served.includes(type),
  );
