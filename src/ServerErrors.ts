/**
 * The server's error seam: the domain error catalogue an operation raises,
 * the dynamic JSON:API error carrier a boundary answers with, the mapping
 * from one to the other, and the `respond` wrapper that applies it to every
 * handler.
 *
 * Three consuming applications each carried a copy of this module
 * (`packages/api/src/jsonapi-error.ts` + `apps/api/src/respond.ts`); it is
 * the same ~250 lines in each, so it lives here. What stays in the
 * application is anything that knows a database: a Postgres unique violation
 * becoming a 409 is `@thomasfosterau/effect-drizzle-ext`'s to recognise, and
 * plugs in through {@link RespondOptions.materialise}.
 *
 * ## The pieces
 *
 * - The **catalogue** — {@link NotFound}, {@link Unauthorized},
 *   {@link Forbidden}, {@link Redirect}, {@link HttpError},
 *   {@link ValidationFailure} — is the vocabulary an operation fails with.
 *   Each tag carries a stable shape so the boundary maps it to a specific
 *   HTTP status without sniffing.
 * - {@link JsonapiError} is the **carrier**: a tagged failure holding a
 *   pre-materialised error-object array plus the HTTP status the boundary
 *   should use. A handler may raise one directly for a one-off.
 * - {@link fromTaggedError} is the **mapping**: every catalogue member, plus
 *   every `ApiError.make` class (`ApiError.Conflict` and the package's own
 *   include / sort / fieldset errors included), to its `JsonapiError`.
 *   Anything else is `Option.none()`: an unmapped failure stays a defect
 *   rather than being guessed at.
 * - {@link respond} wraps a handler effect so expected failures become
 *   JSON:API error responses and genuine defects are logged and answered
 *   with an opaque 500.
 *
 * @since 0.16.0
 */
import { Effect, Match, Option, Predicate, Schema } from "effect";
import * as SchemaIssue from "effect/SchemaIssue";
import { HttpServerResponse } from "effect/http";
import * as ApiError from "./ApiError.js";
import * as Document from "./Document.js";
import { MEDIA_TYPE } from "./internal/media.js";
import { issueLeaves, pathToJsonPointer as toPointer } from "./internal/schemaExt.js";
import { definedMember } from "./internal/members.js";

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/**
 * The requested resource does not exist or is not visible to the caller.
 * Answered as `404 not-found`.
 *
 * @since 0.16.0
 * @category errors
 */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  resource: Schema.String,
  id: Schema.String,
}) {}

/**
 * No authenticated session was found on the request. Answered as
 * `401 auth.unauthorised`.
 *
 * @since 0.16.0
 * @category errors
 */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  message: Schema.optional(Schema.String),
}) {}

/**
 * An authenticated session exists but lacks the required privilege. Answered
 * as `403 auth.forbidden`.
 *
 * @since 0.16.0
 * @category errors
 */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  message: Schema.optional(Schema.String),
}) {}

/**
 * Redirect the client to a new URL. Answered as the 3xx `status` with the
 * target in `meta.location` (`code: "redirect"`); a framework boundary turns
 * it into a `Location` header.
 *
 * @since 0.16.0
 * @category errors
 */
export class Redirect extends Schema.TaggedError<Redirect>()("Redirect", {
  to: Schema.String,
  status: Schema.Number,
}) {}

/**
 * Catch-all HTTP error for status codes outside the dedicated tags. Answered
 * as its `status` with `code: "http.<status>"` — except `409`, which is the
 * conflict path (`code: "conflict"`).
 *
 * @since 0.16.0
 * @category errors
 */
export class HttpError extends Schema.TaggedError<HttpError>()("HttpError", {
  status: Schema.Number,
  message: Schema.String,
}) {}

/**
 * A form-level validation failure carrying one or more issues. Each issue is
 * either a plain string (a whole-resource issue) or a Standard-Schema-shaped
 * `{ message, path }` (a field-level issue whose path lands under
 * `/data/attributes`). Answered as one `400 validation` error object per
 * issue.
 *
 * An Effect `SchemaIssue` passed as an issue is rendered with Effect's
 * default formatter as one error object, with no `source` and a multi-line
 * `detail`: each leaf's message, followed by an `at <path>` line when it has
 * a path. For one error object per leaf, each with its own
 * `source.pointer`, use {@link schemaIssueToErrors} instead.
 *
 * @since 0.16.0
 * @category errors
 */
export class ValidationFailure extends Schema.TaggedError<ValidationFailure>()(
  "ValidationFailure",
  { issues: Schema.Array(Schema.Unknown) },
) {}

// ---------------------------------------------------------------------------
// The carrier
// ---------------------------------------------------------------------------

/**
 * One JSON:API error object as the seam materialises it — the package's
 * {@link Document.ErrorObject} value.
 *
 * @since 0.16.0
 * @category models
 */
export type ErrorObject = typeof Document.ErrorObject.Type;

/**
 * The document {@link JsonapiError.toDocument} builds: `errors` plus the
 * `jsonapi` member, and `meta.requestId` when a request id was given.
 *
 * @since 0.16.0
 * @category models
 */
export interface ErrorDocument {
  readonly errors: ReadonlyArray<ErrorObject>;
  readonly meta?: { readonly requestId: string };
  readonly jsonapi: { readonly version: "1.1" };
}

/**
 * A tagged failure carrying a pre-materialised JSON:API error array plus the
 * HTTP status the boundary should use. {@link respond} answers it as-is; a
 * handler may raise one directly for an error the catalogue has no tag for.
 *
 * @example
 * ```ts
 * import { ServerErrors } from "@thomasfosterau/effect-jsonapi"
 *
 * const gone = new ServerErrors.JsonapiError({
 *   status: 410,
 *   errors: [{ status: "410", code: "gone", title: "Gone" }]
 * })
 * console.log(gone.toDocument("req-1"))
 * // → { errors: [{ status: "410", code: "gone", title: "Gone" }],
 * //     meta: { requestId: "req-1" }, jsonapi: { version: "1.1" } }
 * ```
 *
 * @since 0.16.0
 * @category models
 */
export class JsonapiError extends Schema.TaggedError<JsonapiError>()("JsonapiError", {
  status: Schema.Number,
  errors: Schema.Array(Document.ErrorObject),
}) {
  /**
   * The full `{ errors, jsonapi }` document, with `meta.requestId` when given.
   *
   * @since 0.16.0
   */
  toDocument(requestId?: string): ErrorDocument {
    return {
      errors: this.errors,
      ...definedMember("meta", requestId === undefined ? undefined : { requestId }),
      jsonapi: { version: "1.1" },
    };
  }
}

// ---------------------------------------------------------------------------
// Schema issues → error objects
// ---------------------------------------------------------------------------

/**
 * An RFC 6901 JSON Pointer from a path of property keys:
 * `["data", "attributes", "name"]` → `/data/attributes/name`. The empty path
 * is `""` (the whole document); segments are escaped (`~` → `~0`, `/` →
 * `~1`).
 *
 * @example
 * ```ts
 * import { ServerErrors } from "@thomasfosterau/effect-jsonapi"
 *
 * ServerErrors.pathToJsonPointer(["data", "attributes", "a/b"])
 * // → "/data/attributes/a~1b"
 * ```
 *
 * @since 0.16.0
 * @category utils
 */
export const pathToJsonPointer: (path: ReadonlyArray<PropertyKey>) => string = toPointer;

/** The pointer prefix a flat attribute-keyed input maps onto. */
const ATTRIBUTES_PREFIX: ReadonlyArray<PropertyKey> = ["data", "attributes"];

/**
 * Effect's default issue formatter. An issue node has no `toString` of its
 * own — `String(issue)` renders `[object Object]` — so every `detail` drawn
 * from a schema issue goes through this.
 */
const formatIssue = SchemaIssue.makeFormatterDefault();

/**
 * Options of {@link schemaIssueToErrors}.
 *
 * @since 0.16.0
 * @category models
 */
export interface SchemaIssueOptions {
  /** The HTTP status stamped on every emitted error object. Defaults to `400`. */
  readonly status?: number | undefined;
  /**
   * The pointer prefix every accumulated path is placed under. Defaults to
   * `["data", "attributes"]`, the canonical location of a flat,
   * attribute-keyed input; a caller that decoded a whole JSON:API document
   * passes `[]`.
   */
  readonly prefix?: ReadonlyArray<PropertyKey> | undefined;
}

/**
 * One JSON:API error object per leaf of an Effect Schema issue tree:
 * `source.pointer` from the accumulated path (under `prefix`), `code` from
 * the leaf's `_tag`, `detail` from its message as Effect's default issue
 * formatter (`SchemaIssue.makeFormatterDefault`) renders it — for a failed
 * check, the check's own message.
 *
 * This is the seam for a decode a handler runs itself (a form body, a
 * command input); request-part decoding inside `HttpApi` is already rendered
 * by `Middleware.schemaErrorDocument`.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { ServerErrors } from "@thomasfosterau/effect-jsonapi"
 *
 * const Input = Schema.Struct({ name: Schema.String })
 * const failed = Schema.decodeUnknownEffect(Input)({ name: 42 }).pipe(Effect.flip, Effect.runSync)
 * const errors = ServerErrors.schemaIssueToErrors(failed.issue)
 * console.log(errors[0]?.code, errors[0]?.source, errors[0]?.detail)
 * // → InvalidType { pointer: "/data/attributes/name" } Expected string
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const schemaIssueToErrors = (
  issue: SchemaIssue.Issue,
  options?: SchemaIssueOptions,
): ReadonlyArray<ErrorObject> => {
  const status = String(options?.status ?? 400);
  const prefix = options?.prefix ?? ATTRIBUTES_PREFIX;
  return issueLeaves(issue).map(({ path, issue: leaf, describedBy }) => {
    const pointer = pathToJsonPointer([...prefix, ...path]);
    return {
      status,
      code: leaf._tag,
      detail: formatIssue(describedBy),
      ...definedMember("source", pointer === "" ? undefined : { pointer }),
    };
  });
};

// ---------------------------------------------------------------------------
// Tagged failure → JsonapiError
// ---------------------------------------------------------------------------

const single = (status: number, error: ErrorObject): JsonapiError =>
  new JsonapiError({ status, errors: [error] });

/**
 * A `Schema.TaggedError`'s `message` is never `undefined` — one constructed
 * without a message carries the empty string `Error` defaults to — so the
 * fallback keys off emptiness, not absence.
 */
const detailOr = (message: string, fallback: string): string =>
  message === "" ? fallback : message;

/**
 * One {@link ValidationFailure} issue: a plain string (a whole-resource issue)
 * or a Standard-Schema-shaped `{ message, path }` (a field-level issue whose
 * path segments become the pointer under `/data/attributes`).
 */
const ValidationIssue = Schema.Union([
  Schema.String,
  Schema.Struct({
    message: Schema.String,
    path: Schema.optional(
      Schema.Array(
        Schema.Union([Schema.String, Schema.Number, Schema.Struct({ key: Schema.Unknown })]),
      ),
    ),
  }),
]);

const decodeValidationIssue = Schema.decodeUnknownOption(ValidationIssue);

/** A Standard Schema path segment is either a property key or a `{ key }` object. */
const pathSegment = (segment: string | number | { readonly key: unknown }): PropertyKey =>
  Predicate.isObject(segment) ? String(segment.key) : segment;

const VALIDATION = { status: "400", code: "validation", title: "Validation failed" } as const;

/** A decoded {@link ValidationIssue} as its error object. */
const validationIssueToError = (issue: typeof ValidationIssue.Type): ErrorObject => {
  if (Predicate.isString(issue)) return { ...VALIDATION, detail: issue };
  const pointer = pathToJsonPointer([...ATTRIBUTES_PREFIX, ...(issue.path ?? []).map(pathSegment)]);
  return { ...VALIDATION, detail: issue.message, source: { pointer } };
};

/** What an `ApiError.make` class carries statically: the wire schema and the status. */
interface ApiErrorConstructor {
  readonly status: number;
  readonly wire: unknown;
}

/** An instance of any `ApiError.make` class, recognised by its constructor's statics. */
const isApiError = (
  error: unknown,
): error is ApiError.Any & { readonly constructor: ApiErrorConstructor } => {
  if (!ApiError.isApiError(error)) return false;
  const ctor: Partial<ApiErrorConstructor> | undefined = (
    error as { readonly constructor?: Partial<ApiErrorConstructor> }
  ).constructor;
  return ctor !== undefined && Predicate.isNumber(ctor.status) && Schema.isSchema(ctor.wire);
};

const apiErrorToJsonapi = (
  error: ApiError.Any & { readonly constructor: ApiErrorConstructor },
): JsonapiError =>
  new JsonapiError({
    status: error.constructor.status,
    errors: ApiError.toDocument(error).errors,
  });

/**
 * Maps a tagged failure (the `cause` a handler failed with) to its
 * {@link JsonapiError}, per the contract code
 * taxonomy:
 *
 * | Failure                          | Status | `code`               |
 * | -------------------------------- | ------ | -------------------- |
 * | {@link Unauthorized}             | 401    | `auth.unauthorised`  |
 * | {@link Forbidden}                | 403    | `auth.forbidden`     |
 * | {@link NotFound}                 | 404    | `not-found`          |
 * | any `ApiError.make` class        | its own | its own (`ApiError.Conflict` → `conflict`) |
 * | {@link HttpError} with 409       | 409    | `conflict`           |
 * | {@link HttpError} otherwise      | status | `http.<status>`      |
 * | {@link ValidationFailure}        | 400    | `validation` (one object per issue) |
 * | {@link Redirect}                 | 3xx    | `redirect` (`meta.location`) |
 * | a {@link JsonapiError}           | itself |                      |
 *
 * Errors with no `source` are whole-resource errors; `source.pointer` is
 * reserved for validation issues that name an input location. Anything the
 * table doesn't list is `Option.none()`: an unmapped failure propagates as a
 * defect (a 500) rather than being guessed at.
 *
 * @example
 * ```ts
 * import { Option } from "effect"
 * import { ApiError, ServerErrors } from "@thomasfosterau/effect-jsonapi"
 *
 * const notFound = ServerErrors.fromTaggedError(
 *   new ServerErrors.NotFound({ resource: "people", id: "abc" })
 * )
 * console.log(Option.map(notFound, (e) => [e.status, e.errors[0]?.detail]))
 * // → { _id: "Option", _tag: "Some", value: [404, "people abc not found"] }
 *
 * // an `ApiError.make` class renders through its own wire schema
 * const conflict = ServerErrors.fromTaggedError(new ApiError.Conflict({ detail: "id mismatch" }))
 * console.log(Option.map(conflict, (e) => e.errors[0]?.code))
 * // → { _id: "Option", _tag: "Some", value: "conflict" }
 *
 * // anything else is none — it stays a defect
 * console.log(ServerErrors.fromTaggedError(new Error("boom")))
 * // → { _id: "Option", _tag: "None" }
 * ```
 *
 * @since 0.16.0
 * @category utils
 */
export const fromTaggedError: (cause: unknown) => Option.Option<JsonapiError> =
  Match.type<unknown>().pipe(
    Match.when(Match.instanceOf(JsonapiError), (error) => Option.some(error)),
    Match.when(Match.instanceOf(Unauthorized), (error) =>
      Option.some(
        single(401, {
          status: "401",
          code: "auth.unauthorised",
          title: "Unauthorized",
          detail: detailOr(error.message, "Authentication required."),
        }),
      ),
    ),
    Match.when(Match.instanceOf(Forbidden), (error) =>
      Option.some(
        single(403, {
          status: "403",
          code: "auth.forbidden",
          title: "Forbidden",
          detail: detailOr(error.message, "You do not have permission to perform this action."),
        }),
      ),
    ),
    Match.when(Match.instanceOf(NotFound), (error) =>
      Option.some(
        single(404, {
          status: "404",
          code: "not-found",
          title: "Not found",
          detail: `${error.resource} ${error.id} not found`,
        }),
      ),
    ),
    // The package's own error classes (`ApiError.Conflict` from
    // `ResourceHandlers.assertIdMatchesPath`, `ApiError.UnsupportedIncludePath`
    // from the include walk, …) render through the same wire schema the
    // endpoint middleware applies, so the body here matches what the contract
    // advertises — `meta.includablePaths` included.
    Match.when(isApiError, (error) => Option.some(apiErrorToJsonapi(error))),
    // HTTP 409 from an operation is the conflict path; other statuses pass
    // through with a generic `http.<status>` code so clients can still branch.
    Match.when(Match.instanceOf(HttpError), (error) =>
      Option.some(
        error.status === 409
          ? single(409, {
              status: "409",
              code: "conflict",
              title: "Conflict",
              detail: error.message,
            })
          : single(error.status, {
              status: String(error.status),
              code: `http.${error.status}`,
              detail: error.message,
            }),
      ),
    ),
    Match.when(Match.instanceOf(ValidationFailure), (error) =>
      Option.some(
        new JsonapiError({
          status: 400,
          // Each issue is decoded here, at the seam; one that is not a
          // `ValidationIssue` keeps only its message, with no pointer.
          errors: error.issues.map((issue) =>
            Option.match(decodeValidationIssue(issue), {
              onNone: () => ({
                ...VALIDATION,
                detail: SchemaIssue.isIssue(issue) ? formatIssue(issue) : String(issue),
              }),
              onSome: validationIssueToError,
            }),
          ),
        }),
      ),
    ),
    // A redirect has no JSON:API rendering of its own: at this seam it is the
    // 3xx status with the target in `meta.location`.
    Match.when(Match.instanceOf(Redirect), (error) =>
      Option.some(
        single(error.status, {
          status: String(error.status),
          code: "redirect",
          title: "Redirect",
          detail: `Redirecting to ${error.to}`,
          meta: { location: error.to },
        }),
      ),
    ),
    Match.orElse(() => Option.none()),
  );

// ---------------------------------------------------------------------------
// respond
// ---------------------------------------------------------------------------

/**
 * The opaque document a genuine defect is answered with.
 *
 * @since 0.16.0
 * @category constants
 */
export const SERVER_ERROR: JsonapiError = new JsonapiError({
  status: 500,
  errors: [
    {
      status: "500",
      code: "internal",
      title: "Internal server error",
      detail: "The request could not be completed.",
    },
  ],
});

/**
 * Serialises a {@link JsonapiError} into its HTTP response: the document as
 * the body, `status` as the status, the JSON:API media type as the content
 * type. `HttpServerResponse.json` can only fail on an unserialisable body,
 * and the document is plain data, so that path dies rather than widening the
 * error channel.
 *
 * @since 0.16.0
 * @category constructors
 */
export const errorResponse = (
  error: JsonapiError,
  requestId?: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.orDie(
    HttpServerResponse.json(error.toDocument(requestId), {
      status: error.status,
      contentType: MEDIA_TYPE,
    }),
  );

/**
 * Options of {@link respond}.
 *
 * @since 0.16.0
 * @category models
 */
export interface RespondOptions {
  /**
   * Extra mapping arms consulted after {@link fromTaggedError} declines —
   * the place an application recognises what only it can (a database
   * driver's unique-violation error as a `409 conflict`, say). `none` leaves
   * the cause a defect.
   */
  readonly materialise?: ((cause: unknown) => Option.Option<JsonapiError>) | undefined;
}

/**
 * Wraps a handler effect for registration with `HttpApiBuilder`: expected
 * failures — anything {@link fromTaggedError} (or the caller's
 * {@link RespondOptions.materialise}) maps — become JSON:API error responses
 * with the right status; anything else is logged with its original cause and
 * answered with the opaque {@link SERVER_ERROR}.
 *
 * Both the error channel and defects are caught: an `Effect.die` reaching
 * here is the only place a genuine defect on the server gets recorded, since
 * the router would otherwise swallow it into its own bodyless 500.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { ServerErrors } from "@thomasfosterau/effect-jsonapi"
 *
 * const handler = Effect.fail(new ServerErrors.NotFound({ resource: "people", id: "abc" }))
 * const response = Effect.runSync(ServerErrors.respond(handler))
 * // the failure became a 404 JSON:API error response
 * console.log(typeof response === "object" && "status" in response ? response.status : response)
 * // → 404
 * ```
 *
 * @since 0.16.0
 * @category combinators
 */
export const respond = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: RespondOptions,
): Effect.Effect<A | HttpServerResponse.HttpServerResponse, never, R> => {
  const materialise = (cause: unknown): Option.Option<JsonapiError> =>
    fromTaggedError(cause).pipe(
      Option.orElse(() => options?.materialise?.(cause) ?? Option.none()),
    );
  return effect.pipe(
    Effect.catch((cause) =>
      Option.match(materialise(cause), {
        onNone: () => Effect.die(cause),
        onSome: (error) => errorResponse(error),
      }),
    ),
    Effect.catchDefect((defect) =>
      Option.match(materialise(defect), {
        onNone: () =>
          Effect.andThen(
            Effect.logError("[ServerErrors.respond] unhandled defect", defect),
            errorResponse(SERVER_ERROR),
          ),
        onSome: (error) => errorResponse(error),
      }),
    ),
  );
};
