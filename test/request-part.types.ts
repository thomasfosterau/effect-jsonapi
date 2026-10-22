/**
 * Type-level tests for `Middleware.RequestPart` (#228).
 *
 *   - It is exactly HttpApi's request-side `HttpApiSchemaError` kinds:
 *     `"Params"`, `"Headers"`, `"Query"` and `"Payload"`.
 *   - `"Body"` — HttpApi's kind for a failure to encode the handler's
 *     *response* — is not a request part: `schemaError` and
 *     `schemaErrorDocument` refuse it, and a request body is `"Payload"`.
 *
 * This file is type-checked by the `typecheck` task; the `@ts-expect-error`
 * annotations are the assertions, each paired with the negative control that
 * shows the error is the part's and not the call's. Every binding is exported
 * so an unused-local error can never stand in for the assertion an
 * `@ts-expect-error` expects.
 */
import * as Schema from "effect/Schema";
import { Middleware } from "@thomasfosterau/effect-jsonapi";

// Whether two types are identical (not merely mutually assignable).
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export const requestPartIsTheRequestKinds: Equals<
  Middleware.RequestPart,
  "Params" | "Headers" | "Query" | "Payload"
> = true;

declare const issue: Schema.SchemaError;

// The negative control: the request body is `"Payload"`.
export const payloadError = Middleware.schemaError("Payload");
export const payloadDocument = Middleware.schemaErrorDocument("Payload", issue);

// @ts-expect-error -- `"Body"` names HttpApi's response encoding, not a request part
export const bodyError = Middleware.schemaError("Body");
// @ts-expect-error -- `"Body"` names HttpApi's response encoding, not a request part
export const bodyDocument = Middleware.schemaErrorDocument("Body", issue);
