/**
 * The error a declaration helper throws when it is handed an invalid
 * definition (a malformed resource, include path, filter or relationship
 * option). These are programmer errors raised synchronously while the api is
 * declared, never an Effect failure, so they stay thrown; the tag only gives
 * them a stable `name` and `_tag` to match on. Still an `Error`.
 *
 * @internal
 */
import * as Schema from "effect/Schema";

/** An invalid declaration, thrown while an api is being declared. */
class DeclarationError extends Schema.TaggedError<
  DeclarationError,
  { readonly brand: unique symbol }
>()("DeclarationError", { message: Schema.String }) {}

/** Builds the {@link DeclarationError} to `throw` for `message`. */
export const declarationError = (message: string): DeclarationError =>
  new DeclarationError({ message });
