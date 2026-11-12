/**
 * The library's one JSON text codec, so no module calls `JSON.parse` /
 * `JSON.stringify` directly (`effect/avoid-direct-json`). Each helper is a
 * `Schema.fromJsonString` codec, which parses and serialises with the same
 * engine `JSON` does: same bytes, same key order, same spacing.
 *
 * @internal
 */
import { flow } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Encoding goes through `Schema.Unknown`, so a value is serialised exactly as
// `JSON.stringify` would (a `toJSON` honoured, nothing validated first).
const encoder = Schema.fromJsonString(Schema.Unknown);

/** Parses JSON text; throws a `SchemaError` when the text is not JSON. */
const parseText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

/** Serialises a value to JSON text; throws a `SchemaError` when it has none. */
const stringifyValue = Schema.encodeUnknownSync(encoder);

/**
 * Serialises a value to JSON text, or `None` when JSON has no text for it
 * (`undefined`, a symbol, a function) or the value cannot be serialised (a
 * cycle, a `BigInt`).
 */
const tryStringifyValue = Schema.encodeUnknownOption(encoder);

/**
 * A value quoted for a diagnostic message: its JSON text, or `"undefined"`
 * where `tryStringify` has none, exactly what interpolating a bare
 * `JSON.stringify(value)` printed.
 */
export const render = flow(
  tryStringifyValue,
  Option.getOrElse(() => "undefined"),
);

export { parseText as parse, stringifyValue as stringify, tryStringifyValue as tryStringify };
