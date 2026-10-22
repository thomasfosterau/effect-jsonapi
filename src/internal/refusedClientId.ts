/**
 * The refusal of a client-generated id on a create payload (#450).
 *
 * `Resource.createPayload`'s resource object declares no `id`, and a struct
 * with fields drops a key it doesn't declare, so a `data.id` the client sent
 * used to be dropped without a word and the server created under an id of
 * its own. JSON:API 1.1 §Client-Generated IDs: "A server MUST return 403
 * Forbidden in response to an unsupported request to create a resource with
 * a client-generated ID." So the resource object rejects an `id` at
 * `/data/id`, with an issue `Middleware.SchemaErrorsLive` recognises and
 * answers with that 403 rather than the 400 of a malformed payload.
 *
 * @internal
 */
import { Predicate, Schema, SchemaAST, SchemaIssue } from "effect";

/**
 * The message of the issue a create payload's resource object reports for a
 * client-generated `id`, which `Middleware.SchemaErrorsLive` matches (with
 * the `/data/id` path) to answer 403 Forbidden.
 *
 * @internal
 */
export const CLIENT_ID_UNSUPPORTED = "Client-generated ids are not supported by this endpoint";

// Rejects an `id` member, at its own path. Anonymous, and rendering no JSON
// Schema of its own, for the reasons `closedStruct`'s check is: an identifier,
// title or description would be copied into every consumer's OpenAPI document.
// oxlint-disable-next-line effect/require-filter-metadata -- see above: this check must stay anonymous in consumers' OpenAPI
const noClientId = Schema.makeFilter<unknown>(
  (input) =>
    Predicate.hasProperty(input, "id")
      ? new SchemaIssue.Pointer(
          ["id"],
          new SchemaIssue.InvalidValue({ message: CLIENT_ID_UNSUPPORTED }, input.id),
        )
      : true,
  { toJsonSchema: () => ({}) },
);

/**
 * A resource-object struct that rejects a client-generated `id` member, in
 * both directions: as an encoding check, which the parser runs on the raw
 * input while decoding (a server reading a request body), and as a check,
 * which `SchemaAST.flip` makes the encoding check while encoding (a client
 * writing one) — the arrangement `closedStruct` describes. Its `fields`,
 * `Type`, `Encoded` and JSON Schema are unchanged. The check runs only once
 * the struct has parsed, so a `type` or member that fails is reported
 * instead.
 *
 * @internal
 */
export const refusingClientId = <const Fields extends Schema.Struct.Fields>(
  struct: Schema.Struct<Fields>,
): Schema.Struct<Fields> => {
  const { ast } = struct;
  const checks = [noClientId] as const;
  return struct.rebuild(
    new SchemaAST.Objects(
      ast.propertySignatures,
      ast.indexSignatures,
      ast.annotations,
      checks,
      ast.encoding,
      ast.context,
      checks,
    ),
  );
};

// The JSON pointer the refusal names.
const ID_PATH = ["data", "id"] as const;

/**
 * Whether a payload decode failure's leaf, in the wire names `wireLeaves`
 * reports, is the refusal of a client-generated id.
 *
 * @internal
 */
export const isRefusedClientId = (leaf: {
  readonly message: string;
  readonly wire: ReadonlyArray<PropertyKey>;
}): boolean =>
  leaf.message === CLIENT_ID_UNSUPPORTED &&
  leaf.wire.length === ID_PATH.length &&
  leaf.wire.every((key, index) => key === ID_PATH[index]);
