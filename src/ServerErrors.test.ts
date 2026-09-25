/**
 * The error seam, pinned against the behaviour three consuming applications
 * converged on: the schema-issue walk's pointers and codes, every catalogue
 * arm of `fromTaggedError`, the `ApiError.make` pass-through (the Conflict
 * arm), and `respond`'s two catch paths.
 */
import { describe, expect, it } from "vite-plus/test";
import { Cause, Effect, Exit, Option, Schema, SchemaIssue } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import * as ApiError from "./ApiError.js";
import * as ServerErrors from "./ServerErrors.js";

describe("pathToJsonPointer", () => {
  it("returns empty string for an empty path", () => {
    expect(ServerErrors.pathToJsonPointer([])).toBe("");
  });

  it("joins segments with /", () => {
    expect(ServerErrors.pathToJsonPointer(["data", "attributes", "name"])).toBe(
      "/data/attributes/name",
    );
  });

  it("encodes / as ~1 and ~ as ~0 per RFC 6901", () => {
    expect(ServerErrors.pathToJsonPointer(["a/b"])).toBe("/a~1b");
    expect(ServerErrors.pathToJsonPointer(["a~b"])).toBe("/a~0b");
    expect(ServerErrors.pathToJsonPointer(["a~/b"])).toBe("/a~0~1b");
  });

  it("handles numeric path segments", () => {
    expect(ServerErrors.pathToJsonPointer(["candidates", 0, "partyId"])).toBe(
      "/candidates/0/partyId",
    );
  });
});

/** Decode through a schema and return the raised issue tree. */
const issueFor = <S extends Schema.Top>(
  schema: S,
  input: unknown,
  options?: { readonly errors: "first" | "all" },
): SchemaIssue.Issue => {
  const exit = Effect.runSyncExit(
    Schema.decodeUnknownEffect(schema as unknown as Schema.Codec<S["Type"]>)(input, options),
  );
  if (Exit.isSuccess(exit)) throw new Error("expected schema to fail");
  const error = Cause.findErrorOption(exit.cause);
  if (Option.isNone(error)) throw new Error("Cause has no failure");
  return (error.value as { readonly issue: SchemaIssue.Issue }).issue;
};

describe("schemaIssueToErrors", () => {
  it("emits a top-level error for a wrong root type", () => {
    const errors = ServerErrors.schemaIssueToErrors(issueFor(Schema.String, 42));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.source).toEqual({ pointer: "/data/attributes" });
    expect(errors[0]?.code).toBe("InvalidType");
    expect(errors[0]?.status).toBe("400");
  });

  it("maps a nested attribute path into /data/attributes/<field>", () => {
    const schema = Schema.Struct({ name: Schema.String, slug: Schema.optional(Schema.String) });
    const errors = ServerErrors.schemaIssueToErrors(issueFor(schema, { name: 42 }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.source).toEqual({ pointer: "/data/attributes/name" });
    expect(errors[0]?.code).toBe("InvalidType");
  });

  it("flattens a hand-rolled Composite into one error per child", () => {
    const a = new SchemaIssue.Pointer(["name"], new SchemaIssue.MissingKey(undefined));
    const b = new SchemaIssue.Pointer(["seats"], new SchemaIssue.InvalidValue());
    const errors = ServerErrors.schemaIssueToErrors(
      new SchemaIssue.Composite(Schema.String.ast, [a, b]),
    );
    expect(errors.map((e) => e.source)).toEqual(
      expect.arrayContaining([
        { pointer: "/data/attributes/name" },
        { pointer: "/data/attributes/seats" },
      ]),
    );
    expect(errors.map((e) => e.code).toSorted()).toEqual(["InvalidValue", "MissingKey"]);
  });

  it("handles array index paths", () => {
    const schema = Schema.Struct({
      candidates: Schema.Array(Schema.Struct({ partyId: Schema.String })),
    });
    const errors = ServerErrors.schemaIssueToErrors(
      issueFor(schema, { candidates: [{ partyId: 1 }] }),
    );
    expect(errors[0]?.source).toEqual({ pointer: "/data/attributes/candidates/0/partyId" });
  });

  it("emits MissingKey for required fields", () => {
    const errors = ServerErrors.schemaIssueToErrors(
      issueFor(Schema.Struct({ name: Schema.String }), {}),
    );
    expect(errors[0]?.code).toBe("MissingKey");
    expect(errors[0]?.source).toEqual({ pointer: "/data/attributes/name" });
  });

  it("honours a custom status and an empty prefix (full-document inputs)", () => {
    const errors = ServerErrors.schemaIssueToErrors(
      issueFor(Schema.Struct({ name: Schema.String }), { name: 42 }),
      { status: 422, prefix: [] },
    );
    expect(errors[0]?.source).toEqual({ pointer: "/name" });
    expect(errors[0]?.status).toBe("422");
  });

  it("omits `source` entirely when neither prefix nor path names a location", () => {
    const errors = ServerErrors.schemaIssueToErrors(issueFor(Schema.String, 42), { prefix: [] });
    expect(errors[0]?.source).toBeUndefined();
    expect(errors[0]?.detail?.length).toBeGreaterThan(0);
  });

  it("recurses through a Filter into its inner leaf, preserving the path", () => {
    const schema = Schema.Struct({ name: Schema.String.check(Schema.isMinLength(3)) });
    const errors = ServerErrors.schemaIssueToErrors(issueFor(schema, { name: "ab" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("InvalidValue");
    expect(errors[0]?.source).toEqual({ pointer: "/data/attributes/name" });
  });

  it("recurses through an Encoding wrapper into its inner leaf", () => {
    const encoding = new SchemaIssue.Encoding(
      Schema.String.ast,
      new SchemaIssue.InvalidType(Schema.String.ast),
    );
    const errors = ServerErrors.schemaIssueToErrors(encoding);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("InvalidType");
  });

  it("renders each leaf's `detail` with Effect's default issue formatter", () => {
    const schema = Schema.Struct({
      name: Schema.String,
      seats: Schema.Number,
      slug: Schema.String.check(Schema.isMinLength(3)),
      handle: Schema.String.check(
        Schema.makeFilter((s) => s.startsWith("@"), {
          identifier: "Handle",
          title: "handle",
          description: "a string starting with @",
          message: "Handles start with @",
        }),
      ),
      kind: Schema.Literals(["a", "b"]),
    });
    const errors = ServerErrors.schemaIssueToErrors(
      issueFor(schema, { seats: "four", slug: "ab", handle: "x", kind: "c" }, { errors: "all" }),
      { status: 422 },
    );
    // An issue node has no `toString` of its own: `String(leaf)` renders
    // `[object Object]`, which the length-only assertion above accepted.
    expect(errors).toEqual([
      {
        status: "422",
        code: "MissingKey",
        detail: "Missing key",
        source: { pointer: "/data/attributes/name" },
      },
      {
        status: "422",
        code: "InvalidType",
        detail: "Expected number",
        source: { pointer: "/data/attributes/seats" },
      },
      {
        status: "422",
        code: "InvalidValue",
        detail: "Expected a value with a length of at least 3",
        source: { pointer: "/data/attributes/slug" },
      },
      {
        status: "422",
        code: "InvalidValue",
        detail: "Handles start with @",
        source: { pointer: "/data/attributes/handle" },
      },
      {
        status: "422",
        code: "AnyOf",
        detail: 'Expected "a" | "b"',
        source: { pointer: "/data/attributes/kind" },
      },
    ]);
  });

  it("emits one error per branch for a non-empty AnyOf, one leaf for an empty one", () => {
    const a = new SchemaIssue.Pointer(["name"], new SchemaIssue.InvalidValue());
    const b = new SchemaIssue.Pointer(["seats"], new SchemaIssue.MissingKey(undefined));
    const anyOf = new SchemaIssue.AnyOf(Schema.Union([Schema.String, Schema.Number]).ast, [a, b]);
    expect(ServerErrors.schemaIssueToErrors(anyOf)).toHaveLength(2);
    const literal = ServerErrors.schemaIssueToErrors(
      issueFor(Schema.Union([Schema.Literal("a"), Schema.Literal("b")]), "c"),
    );
    expect(literal).toHaveLength(1);
    expect(literal[0]?.code).toBe("AnyOf");
  });
});

/** Unwrap the mapping's verdict, failing the test when it declined to map. */
const mapped = (error: unknown): ServerErrors.JsonapiError => {
  const result = ServerErrors.fromTaggedError(error);
  if (Option.isNone(result)) throw new Error("expected the seam to map the error");
  expect(result.value).toBeInstanceOf(ServerErrors.JsonapiError);
  return result.value;
};

describe("fromTaggedError", () => {
  it("maps Unauthorized to auth.unauthorised / 401, defaulting the detail", () => {
    const error = mapped(new ServerErrors.Unauthorized({ message: "no session" }));
    expect(error.status).toBe(401);
    expect(error.errors[0]).toMatchObject({
      status: "401",
      code: "auth.unauthorised",
      detail: "no session",
    });
    expect(mapped(new ServerErrors.Unauthorized({})).errors[0]?.detail).toBe(
      "Authentication required.",
    );
  });

  it("maps Forbidden to auth.forbidden / 403, defaulting the detail", () => {
    const error = mapped(new ServerErrors.Forbidden({ message: "admin only" }));
    expect(error.status).toBe(403);
    expect(error.errors[0]).toMatchObject({ code: "auth.forbidden", detail: "admin only" });
    expect(mapped(new ServerErrors.Forbidden({})).errors[0]?.detail).toBe(
      "You do not have permission to perform this action.",
    );
  });

  it("maps NotFound to not-found / 404 with resource/id in detail", () => {
    const error = mapped(new ServerErrors.NotFound({ resource: "people", id: "abc" }));
    expect(error.status).toBe(404);
    expect(error.errors[0]).toMatchObject({
      status: "404",
      code: "not-found",
      detail: "people abc not found",
    });
  });

  it("maps HttpError(409) to conflict / 409 and other statuses to http.<status>", () => {
    const conflict = mapped(new ServerErrors.HttpError({ status: 409, message: "id mismatch" }));
    expect(conflict.status).toBe(409);
    expect(conflict.errors[0]).toMatchObject({ code: "conflict", detail: "id mismatch" });
    const other = mapped(new ServerErrors.HttpError({ status: 422, message: "validation" }));
    expect(other.status).toBe(422);
    expect(other.errors[0]).toMatchObject({ status: "422", code: "http.422" });
  });

  it("maps an ApiError.make class through its own wire — the Conflict arm", () => {
    const error = mapped(new ApiError.Conflict({ detail: "URL id differs" }));
    expect(error.status).toBe(409);
    expect(error.errors[0]).toMatchObject({
      status: "409",
      code: "conflict",
      title: "Conflict",
      detail: "URL id differs",
    });
    // …and the package's include error, meta.includablePaths included.
    const include = mapped(
      new ApiError.UnsupportedIncludePath({ path: "nope", includablePaths: ["author"] }),
    );
    expect(include.status).toBe(400);
    expect(include.errors[0]).toMatchObject({
      code: "unsupported.include-path",
      meta: { includablePaths: ["author"] },
    });
  });

  it("maps ValidationFailure to one 400 error per issue, pointing field issues at their attribute", () => {
    const error = mapped(
      new ServerErrors.ValidationFailure({
        issues: [
          "Something is off",
          { message: "Required", path: ["name"] },
          { message: "Bad key", path: [{ key: "slug" }, 0] },
          { message: "Nope" },
          42,
        ],
      }),
    );
    expect(error.status).toBe(400);
    expect(error.errors).toEqual([
      { status: "400", code: "validation", title: "Validation failed", detail: "Something is off" },
      {
        status: "400",
        code: "validation",
        title: "Validation failed",
        detail: "Required",
        source: { pointer: "/data/attributes/name" },
      },
      {
        status: "400",
        code: "validation",
        title: "Validation failed",
        detail: "Bad key",
        source: { pointer: "/data/attributes/slug/0" },
      },
      {
        status: "400",
        code: "validation",
        title: "Validation failed",
        detail: "Nope",
        source: { pointer: "/data/attributes" },
      },
      { status: "400", code: "validation", title: "Validation failed", detail: "42" },
    ]);
  });

  it("formats a schema issue handed to ValidationFailure rather than stringifying it", () => {
    const issue = issueFor(Schema.Struct({ name: Schema.String }), {});
    const error = mapped(new ServerErrors.ValidationFailure({ issues: [issue] }));
    expect(error.errors).toEqual([
      {
        status: "400",
        code: "validation",
        title: "Validation failed",
        detail: 'Missing key\n  at ["name"]',
      },
    ]);
  });

  it("maps Redirect to its 3xx status with the target in meta.location", () => {
    const error = mapped(new ServerErrors.Redirect({ to: "/people/ada", status: 303 }));
    expect(error.status).toBe(303);
    expect(error.errors[0]).toMatchObject({
      status: "303",
      code: "redirect",
      meta: { location: "/people/ada" },
    });
  });

  it("passes a JsonapiError through and declines unknown errors", () => {
    const own = new ServerErrors.JsonapiError({ status: 418, errors: [] });
    expect(Option.getOrThrow(ServerErrors.fromTaggedError(own))).toBe(own);
    expect(Option.isNone(ServerErrors.fromTaggedError(new Error("oops")))).toBe(true);
    expect(Option.isNone(ServerErrors.fromTaggedError("strings are not errors"))).toBe(true);
    expect(Option.isNone(ServerErrors.fromTaggedError({ random: "object" }))).toBe(true);
  });
});

describe("JsonapiError.toDocument", () => {
  it("builds a spec-conformant document with jsonapi.version, and meta.requestId when given", () => {
    const error = new ServerErrors.JsonapiError({
      status: 400,
      errors: [{ status: "400", code: "InvalidType", detail: "expected string" }],
    });
    expect(error.toDocument()).toEqual({
      errors: [{ status: "400", code: "InvalidType", detail: "expected string" }],
      jsonapi: { version: "1.1" },
    });
    expect(error.toDocument("req-123").meta).toEqual({ requestId: "req-123" });
  });
});

const responseOf = async (effect: Effect.Effect<unknown, never, never>) => {
  const value = await Effect.runPromise(effect);
  if (!HttpServerResponse.isHttpServerResponse(value)) throw new Error("expected a response");
  const web = HttpServerResponse.toWeb(value);
  return {
    status: web.status,
    contentType: web.headers.get("content-type"),
    body: (await web.json()) as { errors: ReadonlyArray<{ code?: string }> },
  };
};

describe("respond", () => {
  it("passes a success through untouched", async () => {
    expect(await Effect.runPromise(ServerErrors.respond(Effect.succeed({ data: 1 })))).toEqual({
      data: 1,
    });
  });

  it("answers a mapped failure as a JSON:API error response", async () => {
    const response = await responseOf(
      ServerErrors.respond(Effect.fail(new ServerErrors.NotFound({ resource: "people", id: "1" }))),
    );
    expect(response.status).toBe(404);
    expect(response.contentType).toBe("application/vnd.api+json");
    expect(response.body.errors[0]?.code).toBe("not-found");
  });

  it("answers a mapped defect too — a thrown ApiError reaches the seam", async () => {
    const response = await responseOf(
      ServerErrors.respond(
        Effect.sync(() => {
          throw new ApiError.UnsupportedIncludePath({ path: "x", includablePaths: [] });
        }),
      ),
    );
    expect(response.status).toBe(400);
    expect(response.body.errors[0]?.code).toBe("unsupported.include-path");
  });

  it("answers an unmapped failure or defect with the opaque 500", async () => {
    const failed = await responseOf(ServerErrors.respond(Effect.fail(new Error("db down"))));
    expect(failed.status).toBe(500);
    expect(failed.body.errors[0]?.code).toBe("internal");
    const died = await responseOf(ServerErrors.respond(Effect.die("boom")));
    expect(died.status).toBe(500);
  });

  it("consults the caller's extra arms after the catalogue", async () => {
    const materialise = (cause: unknown) =>
      typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505"
        ? Option.some(
            new ServerErrors.JsonapiError({
              status: 409,
              errors: [{ status: "409", code: "conflict" }],
            }),
          )
        : Option.none();
    const response = await responseOf(
      ServerErrors.respond(Effect.fail({ code: "23505" }), { materialise }),
    );
    expect(response.status).toBe(409);
    // …but the catalogue still wins for its own members.
    const catalogue = await responseOf(
      ServerErrors.respond(Effect.fail(new ServerErrors.Forbidden({})), { materialise }),
    );
    expect(catalogue.status).toBe(403);
  });
});
