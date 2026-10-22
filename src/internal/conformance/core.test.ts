import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerError,
  HttpServerRequest,
} from "effect/http";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { TestClock } from "effect/testing";
import * as Endpoint from "../../Endpoint.js";
import * as Group from "../../Group.js";
import * as Relationship from "../../Relationship.js";
import * as Resource from "../../Resource.js";
import {
  answeredAsDeployed,
  type Context,
  DEFAULT_REQUEST_TIMEOUT,
  discover,
  finding,
  type Observation,
  pass,
  type Rule,
  requestTimeoutOf,
  runner,
  skip,
  timedOutNote,
  undecidedByRedirects,
} from "./core.js";
import { budgeted } from "./crawl.js";

const request = HttpServerRequest.fromWeb(new Request("http://in-process.test/articles/1/moved"));

/** A router that fails the request with `reason`. */
const failingWith = (reason: HttpServerError.HttpServerErrorReason) =>
  Effect.fail(new HttpServerError.HttpServerError({ reason }));

describe("answeredAsDeployed (the in-process transport)", () => {
  it("answers a request no route serves with the router's own empty 404", async () => {
    const exit = await Effect.runPromiseExit(
      answeredAsDeployed(failingWith(new HttpServerError.RouteNotFound({ request }))),
    );
    expect(Exit.isSuccess(exit) && exit.value.status).toBe(404);
  });

  it("does not answer any other router failure: it dies, as it did before #168", async () => {
    // A deployed server's answer to these is not known, so reading one as a
    // 500 (or any status) would put words in the server's mouth.
    const reasons = [
      new HttpServerError.InternalError({ request }),
      new HttpServerError.RequestParseError({ request }),
    ];
    const exits = await Effect.runPromiseExit(
      Effect.forEach(reasons, (reason) => Effect.exit(answeredAsDeployed(failingWith(reason))), {
        concurrency: 1,
      }),
    );
    expect(
      Exit.isSuccess(exits) &&
        exits.value.map((exit) => Exit.isFailure(exit) && Cause.hasDies(exit.cause)),
    ).toEqual([true, true]);
  });
});

describe("discover (the Idempotency-Key header)", () => {
  const post = (name: string, headers?: Schema.Top) =>
    HttpApiEndpoint.post(name, `/${name}`, { headers, success: Schema.Unknown });
  const declared = discover(
    HttpApi.make("headers").add(
      HttpApiGroup.make("writes").add(
        post("none"),
        post("other", Schema.Struct({ "x-trace": Schema.String })),
        post("optional", Schema.Struct({ "idempotency-key": Schema.optionalKey(Schema.String) })),
        post("required", Schema.Struct({ "idempotency-key": Schema.String })),
        // HTTP header names are case-insensitive, so a schema spelling it in
        // another case declares the same header.
        post("mixed", Schema.Struct({ "Idempotency-Key": Schema.String })),
        post("upper", Schema.Struct({ "IDEMPOTENCY-KEY": Schema.optionalKey(Schema.String) })),
        // Beside another header, only the key's own property decides: another
        // header being required does not make the key so, nor another being
        // optional make a required key optional.
        post(
          "beside-required",
          Schema.Struct({
            "x-trace": Schema.String,
            "idempotency-key": Schema.optionalKey(Schema.String),
          }),
        ),
        post(
          "beside-optional",
          Schema.Struct({
            "x-trace": Schema.optionalKey(Schema.String),
            "idempotency-key": Schema.String,
          }),
        ),
        // A union requires the key only when every member does; a member
        // declaring it optionally, or not at all, accepts a request without it.
        post(
          "union-required",
          Schema.Union([
            Schema.Struct({ "idempotency-key": Schema.String, "x-tenant": Schema.String }),
            Schema.Struct({ "idempotency-key": Schema.String, authorization: Schema.String }),
          ]),
        ),
        post(
          "union-optional",
          Schema.Union([
            Schema.Struct({ "idempotency-key": Schema.String, "x-tenant": Schema.String }),
            Schema.Struct({
              "idempotency-key": Schema.optionalKey(Schema.String),
              authorization: Schema.String,
            }),
          ]),
        ),
        post(
          "union-omitted",
          Schema.Union([
            Schema.Struct({ "idempotency-key": Schema.String, "x-tenant": Schema.String }),
            Schema.Struct({ authorization: Schema.String }),
          ]),
        ),
        // A suspended member is read through to its target.
        post(
          "union-suspended",
          Schema.Union([
            Schema.Struct({ "idempotency-key": Schema.String }),
            Schema.suspend(() => Schema.Struct({ "Idempotency-Key": Schema.String })),
          ]),
        ),
      ),
    ),
  );

  it("tells a required key from an optional one, matching the name case-insensitively", () => {
    expect(declared.map(({ name, idempotencyKey }) => `${name}: ${idempotencyKey}`)).toEqual([
      "none: absent",
      "other: absent",
      "optional: optional",
      "required: required",
      "mixed: required",
      "upper: optional",
      "beside-required: optional",
      "beside-optional: required",
      "union-required: required",
      "union-optional: optional",
      "union-omitted: optional",
      "union-suspended: required",
    ]);
  });
});

/** Runs `effect` to its value; a failure or defect fails the test. */
const valueOf = async <A>(effect: Effect.Effect<A>): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isFailure(exit)) return expect.unreachable(Cause.pretty(exit.cause));
  return exit.value;
};

/** One request a {@link served} client was sent. */
interface Sent {
  readonly method: string;
  readonly url: string;
  readonly body: Option.Option<string>;
}

/**
 * A client over `answer`, keyed by path: a status, and the `Location` to
 * redirect to with it. `sent` is every request.
 */
const served = (answer: (path: string) => readonly [status: number, location?: string]) => {
  const sent: Array<Sent> = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      sent.push({
        method: request.method,
        url: url.href,
        body:
          request.body._tag === "Uint8Array"
            ? Option.some(new TextDecoder().decode(request.body.body))
            : Option.none(),
      });
      const [status, location] = answer(url.pathname);
      return HttpClientResponse.fromWeb(
        request,
        new Response(status === 200 ? '{"data":null}' : null, {
          status,
          headers: location === undefined ? {} : { location },
        }),
      );
    }),
  );
  return { sent, request: runner(client, "http://origin.test", Option.none()) };
};

/** `/n` redirects (`status`) to `/n+1` until `/end`, which answers 200. */
const chain = (status: number, end: number) => (path: string) => {
  const n = Number(path.slice(1));
  return n >= end ? ([200] as const) : ([status, `/${n + 1}`] as const);
};

describe("runner (redirects)", () => {
  it("follows a `307` or `308` with the same method and body, and a `302` only for a `GET`", async () => {
    const preserved = served(chain(307, 1));
    const observation = await valueOf(
      preserved.request({ method: "POST", url: "/0", body: { data: 1 } }),
    );
    expect(observation.status).toBe(200);
    expect(observation.redirects).toEqual(["http://origin.test/1"]);
    expect(
      preserved.sent.map(
        ({ method, url, body }) => `${method} ${url} ${Option.getOrElse(body, () => "")}`,
      ),
    ).toEqual(['POST http://origin.test/0 {"data":1}', 'POST http://origin.test/1 {"data":1}']);
    const changed = served(chain(302, 1));
    const refused = await valueOf(
      changed.request({ method: "POST", url: "/0", body: { data: 1 } }),
    );
    expect(changed.sent).toHaveLength(1);
    expect(refused.status).toBe(0);
    expect(Option.map(refused.unfollowed, ({ reason }) => reason)).toEqual(Option.some("method"));
    const read = served(chain(302, 1));
    expect((await valueOf(read.request({ url: "/0" }))).status).toBe(200);
  });

  it("follows a `303` for a `GET`", async () => {
    const read = served(chain(303, 1));
    const answer = await valueOf(read.request({ url: "/0" }));
    expect(answer.status).toBe(200);
    expect(answer.redirects).toEqual(["http://origin.test/1"]);
    expect(read.sent.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET http://origin.test/0",
      "GET http://origin.test/1",
    ]);
  });

  it.each(["POST", "PATCH"])(
    "refuses a `303` that would turn a `%s` into a `GET`",
    async (method) => {
      const write = served(chain(303, 1));
      const refused = await valueOf(write.request({ method, url: "/0", body: { data: 1 } }));
      expect(write.sent).toHaveLength(1);
      expect(refused.status).toBe(0);
      expect(Option.map(refused.unfollowed, ({ reason }) => reason)).toEqual(Option.some("method"));
    },
  );

  it.each([
    ["no", undefined],
    ["an empty", ""],
  ] as const)("answers a `3xx` with %s `Location` as itself", async (_, location) => {
    const target = served(() => (location === undefined ? [302] : [302, location]));
    const observation = await valueOf(target.request({ url: "/0" }));
    expect(target.sent).toHaveLength(1);
    expect(observation.status).toBe(302);
    expect(observation.unfollowed).toEqual(Option.none());
  });

  it.each([
    ["does not parse", "http://[", "unparseable"],
    ["has no origin", "javascript:alert(1)", "offsite"],
  ] as const)("does not follow a `Location` that %s", async (_, location, reason) => {
    const target = served((path) => (path === "/0" ? [301, location] : [200]));
    const observation = await valueOf(target.request({ url: "/0" }));
    expect(target.sent).toHaveLength(1);
    expect(Option.map(observation.unfollowed, (unfollowed) => unfollowed.reason)).toEqual(
      Option.some(reason),
    );
  });

  it("follows no more redirects than the request allows, the first request included", async () => {
    const target = served(chain(302, 3));
    const observation = await valueOf(target.request({ url: "/0", requests: 3 }));
    expect(target.sent).toHaveLength(3);
    expect(observation.redirects).toHaveLength(2);
    expect(Option.map(observation.unfollowed, ({ reason }) => reason)).toEqual(
      Option.some("budget"),
    );
  });
});

describe("runner (a client that rewrites the path too)", () => {
  it("adds a path prefix the client adds again to the path an absolute `Location` on its origin names", async () => {
    // The documented caveat on `resolvedLocation` (#359): the kit reads an
    // absolute `Location` on the rewritten origin as a path on its own, and the
    // client rewrites that path once more, so its prefix is added twice.
    const sent: Array<string> = [];
    const server = HttpClient.make((request, url) =>
      Effect.sync(() => {
        sent.push(url.href);
        return HttpClientResponse.fromWeb(
          request,
          url.pathname === "/v1/a"
            ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/v1/b" } })
            : new Response('{"data":null}', { status: 200 }),
        );
      }),
    );
    const rewriting = HttpClient.mapRequest(server, (request) =>
      HttpClientRequest.setUrl(request, `http://127.0.0.1:9/v1${new URL(request.url).pathname}`),
    );
    const observation = await valueOf(
      runner(rewriting, "http://origin.test", Option.none())({ url: "/a" }),
    );
    expect(sent).toEqual(["http://127.0.0.1:9/v1/a", "http://127.0.0.1:9/v1/v1/b"]);
    expect(observation.status).toBe(200);
    expect(observation.redirects).toEqual(["http://origin.test/v1/b"]);
  });
});

/**
 * What a {@link slow} client answers a path with: a status (and `Location`)
 * after `after`, or never; `held` sends the headers and then holds the body
 * open.
 */
interface Slow {
  readonly after: Duration.Input | "never";
  readonly status?: number;
  readonly location?: string;
  readonly held?: boolean;
}

/**
 * A runner with a one-second `requestTimeout` over a client that answers each
 * path as `answer` says. `sent` is every path requested, `interrupted` how
 * many requests were cut short.
 */
const slow = (answer: (path: string) => Slow, timeout = Option.some(Duration.seconds(1))) => {
  const sent: Array<string> = [];
  let interrupted = 0;
  const client = HttpClient.make((request, url) => {
    sent.push(url.pathname);
    const { after, status = 200, location, held = false } = answer(url.pathname);
    const respond = Effect.sync(() =>
      HttpClientResponse.fromWeb(
        request,
        new Response(held ? new ReadableStream() : status === 200 ? '{"data":null}' : null, {
          status,
          headers: location === undefined ? {} : { location },
        }),
      ),
    );
    return (after === "never" ? Effect.never : Effect.delay(respond, after)).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          interrupted += 1;
        }),
      ),
    );
  });
  return {
    sent,
    interrupted: () => interrupted,
    request: runner(client, "http://origin.test", timeout),
  };
};

/**
 * Runs `probe` under the test clock, advancing it by each of `steps` in turn;
 * `settled` says, after each step, whether the probe had its observation yet.
 */
const clocked = (probe: Effect.Effect<Observation>, steps: ReadonlyArray<Duration.Input>) =>
  valueOf(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(probe);
      const settled = yield* Effect.forEach(
        steps,
        (step) => Effect.map(TestClock.adjust(step), () => fiber.pollUnsafe() !== undefined),
        { concurrency: 1 },
      );
      return { settled, observation: yield* Fiber.join(fiber) };
    }).pipe(Effect.provide(TestClock.layer())),
  );

describe("runner (requestTimeout)", () => {
  it("reads a request still unanswered at the timeout as a lost response naming it", async () => {
    const target = slow(() => ({ after: "never" }));
    const { settled, observation } = await clocked(target.request({ url: "/0" }), [
      "999 millis",
      "1 millis",
    ]);
    expect(settled).toEqual([false, true]);
    expect(observation.status).toBe(0);
    expect(observation.transportError).toBe(timedOutNote(Duration.seconds(1)));
    expect(observation.transportError).toBe("no answer within 1s, the run's `requestTimeout`");
    // A transport error, not a redirect the kit did not follow.
    expect(observation.unfollowed).toEqual(Option.none());
    expect(target.interrupted()).toBe(1);
  });

  it("reads an answer within the timeout as before", async () => {
    const target = slow(() => ({ after: "999 millis" }));
    const { observation } = await clocked(target.request({ url: "/0" }), ["999 millis"]);
    expect(observation.status).toBe(200);
    expect(observation.transportError).toBeUndefined();
    expect(target.interrupted()).toBe(0);
  });

  it("cuts short an answer whose body is held open", async () => {
    const target = slow(() => ({ after: 0, held: true }));
    const { settled, observation } = await clocked(target.request({ url: "/0" }), [
      "999 millis",
      "1 millis",
    ]);
    expect(settled).toEqual([false, true]);
    expect(observation.status).toBe(0);
    expect(observation.transportError).toBe(timedOutNote(Duration.seconds(1)));
  });

  it("gives each redirect hop a timeout of its own, and names the hop it cut short", async () => {
    // Each hop takes 600ms, so the chain takes 1.2s, past one timeout but
    // within each hop's.
    const within = slow((path) =>
      path === "/0"
        ? { after: "600 millis", status: 308, location: "/1" }
        : { after: "600 millis" },
    );
    const answered = await clocked(within.request({ url: "/0" }), ["600 millis", "600 millis"]);
    expect(answered.observation.status).toBe(200);
    expect(answered.observation.redirects).toEqual(["http://origin.test/1"]);
    // A hop that never answers is cut short a second after it is requested,
    // and counts as a request (in `redirects`), as any hop the kit sent does.
    const held = slow((path) =>
      path === "/0" ? { after: "600 millis", status: 308, location: "/1" } : { after: "never" },
    );
    const lost = await clocked(held.request({ url: "/0" }), [
      "600 millis",
      "999 millis",
      "1 millis",
    ]);
    expect(lost.settled).toEqual([false, false, true]);
    expect(lost.observation.status).toBe(0);
    expect(lost.observation.redirects).toEqual(["http://origin.test/1"]);
    expect(lost.observation.transportError).toBe(timedOutNote(Duration.seconds(1)));
    expect(lost.observation.unfollowed).toEqual(Option.none());
    expect(held.sent).toEqual(["/0", "/1"]);
  });

  it("waits thirty seconds by default", async () => {
    const target = slow(() => ({ after: "never" }), await valueOf(requestTimeoutOf(Option.none())));
    const { settled, observation } = await clocked(target.request({ url: "/0" }), [
      "29999 millis",
      "1 millis",
    ]);
    expect(settled).toEqual([false, true]);
    expect(observation.status).toBe(0);
    expect(observation.transportError).toBe("no answer within 30s, the run's `requestTimeout`");
    expect(target.interrupted()).toBe(1);
  });

  it("runs a client's own `retry` within the timeout, not each attempt under one", async () => {
    // The first attempt never answers and the second would at once: were the
    // timeout inside the retry, failing the first attempt, the second would
    // answer 200. It bounds the client's whole `execute`, so the run reads a
    // lost response after one attempt, interrupted.
    let attempts = 0;
    let interrupted = 0;
    const client = HttpClient.retry(
      HttpClient.make((request) => {
        attempts += 1;
        return attempts === 1
          ? Effect.never.pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted += 1;
                }),
              ),
            )
          : Effect.succeed(HttpClientResponse.fromWeb(request, new Response('{"data":null}')));
      }),
      { times: 1 },
    );
    const request = runner(client, "http://origin.test", Option.some(Duration.seconds(1)));
    const { settled, observation } = await clocked(request({ url: "/0" }), [
      "999 millis",
      "1 millis",
    ]);
    expect(settled).toEqual([false, true]);
    expect(observation.status).toBe(0);
    expect(observation.transportError).toBe(timedOutNote(Duration.seconds(1)));
    expect(attempts).toBe(1);
    expect(interrupted).toBe(1);
  });

  it("waits as long as the transport does when the run turns it off", async () => {
    const target = slow(
      () => ({ after: "1 hour" }),
      await valueOf(requestTimeoutOf(Option.some("Infinity"))),
    );
    const { settled, observation } = await clocked(target.request({ url: "/0" }), [
      "59 minutes",
      "1 minute",
    ]);
    expect(settled).toEqual([false, true]);
    expect(observation.status).toBe(200);
  });
});

describe("requestTimeoutOf", () => {
  it("defaults to thirty seconds and keeps a positive duration", async () => {
    expect(await valueOf(requestTimeoutOf(Option.none()))).toEqual(
      Option.some(Duration.seconds(30)),
    );
    expect(DEFAULT_REQUEST_TIMEOUT).toEqual(Duration.seconds(30));
    expect(await valueOf(requestTimeoutOf(Option.some("5 seconds")))).toEqual(
      Option.some(Duration.seconds(5)),
    );
    expect(await valueOf(requestTimeoutOf(Option.some(1)))).toEqual(
      Option.some(Duration.millis(1)),
    );
  });

  it.each(["Infinity", Duration.infinity] as const)("reads %s as no timeout", async (off) => {
    expect(await valueOf(requestTimeoutOf(Option.some(off)))).toEqual(Option.none());
  });

  it.each([
    [0, "0"],
    [-1, "-1"],
    [Number.NaN, "NaN"],
    ["-5 seconds", '"-5 seconds"'],
    ["-Infinity", '"-Infinity"'],
    // The type admits these, but `Duration` cannot read them.
    ["1e3 seconds", '"1e3 seconds"'],
    [".5 seconds", '".5 seconds"'],
    [Duration.zero, null],
  ] as const)(
    "dies on a duration that is not positive, or not readable: %s",
    async (input, named) => {
      const exit = await valueOf(Effect.exit(requestTimeoutOf(Option.some(input))));
      const cause = Exit.isFailure(exit) ? Option.some(exit.cause) : Option.none();
      expect(Option.map(cause, Cause.hasDies)).toEqual(Option.some(true));
      const message = Option.match(cause, {
        onNone: () => "",
        onSome: (c) => String(Cause.squash(c)),
      });
      expect(message).toContain("`requestTimeout` must be a positive duration");
      expect(named === null || message.endsWith(`got ${named}`)).toBe(true);
    },
  );
});

describe("budgeted (each redirect is a request)", () => {
  const io = (budget: number, answer: (path: string) => readonly [number, string?]) => {
    const target = served(answer);
    const ctx: Context = {
      endpoints: [],
      options: {
        baseUrl: "http://origin.test",
        ids: {},
        paths: {},
        absentId: "absent",
        extensions: [],
        mutating: false,
        writes: {},
        requestTimeout: Option.none(),
      },
      writes: [],
      observed: MutableHashSet.empty(),
      request: target.request,
    };
    return { sent: target.sent, io: budgeted(ctx, budget) };
  };
  const at = (path: string) => ({ url: path, href: `http://origin.test${path}` });

  it("counts every hop it follows against the budget", async () => {
    const { io: budget } = io(10, chain(302, 2));
    const answer = await valueOf(budget.fetch(at("/0")));
    expect(Option.map(answer, ({ status }) => status)).toEqual(Option.some(200));
    expect(budget.spent()).toBe(3);
  });

  it("answers nothing when the budget runs out partway through a chain", async () => {
    const { io: budget, sent } = io(2, chain(302, 2));
    expect(await valueOf(budget.fetch(at("/0")))).toEqual(Option.none());
    expect(sent).toHaveLength(2);
    expect(budget.spent()).toBe(2);
    expect(await valueOf(budget.fetch(at("/0")))).toEqual(Option.none());
    expect(sent).toHaveLength(2);
  });
});

describe("undecidedByRedirects (a rule a redirect left undecided)", () => {
  const rule: Rule = {
    id: "spec/test/rule",
    tier: "spec",
    section: "Test",
    reference: "https://jsonapi.org/format/1.1/",
    level: "MUST",
    requirement: "A test rule.",
  };

  /** An answer the kit read: a 200 to `GET url`. */
  const read = (url: string): Observation => ({
    probe: { method: "GET", url, headers: {}, body: undefined },
    status: 200,
    headers: {},
    contentType: undefined,
    text: "",
    body: undefined,
    transportError: undefined,
    redirects: [],
    unfollowed: Option.none(),
  });

  /** `GET url`, answered by a `302` off the origin the kit did not follow. */
  const redirected = (url: string): Observation => ({
    ...read(url),
    status: 0,
    transportError: "redirected",
    unfollowed: Option.some({
      status: 302,
      location: `https://elsewhere.test${url}`,
      reason: "offsite",
      why: "off the origin",
    }),
  });

  const named = (url: string) =>
    `GET ${url} answered a 302 redirect to https://elsewhere.test${url}, which the kit does not follow: off the origin`;

  it("skips a rule that passed on the answers it read, with no own note to keep", () => {
    expect(undecidedByRedirects(pass(rule, 2), [read("/a"), redirected("/b")])).toEqual(
      skip(
        rule,
        `not decided: 1 of 2 requests the rule sent were answered by a redirect the kit does not follow or read (${named("/b")}), and a rule is not passed on the answers it did read alone`,
      ),
    );
  });

  it("keeps the rule's own note when every request was redirected", () => {
    expect(undecidedByRedirects(pass(rule, 1, "its note"), [redirected("/b")])).toEqual(
      skip(
        rule,
        `no answer to decide on: every request the rule sent was answered by a redirect the kit does not follow or read (${named("/b")}); the rule's own note: its note`,
      ),
    );
  });

  it("keeps a finding that names no probe, beside a redirected request", () => {
    const loose = finding(rule, {
      detail: "a finding on no one probe",
      expected: "x",
      observed: "y",
      probe: undefined,
    });
    const failed = { _tag: "Failed", rule, probes: 2, findings: [loose] } as const;
    expect(undecidedByRedirects(failed, [read("/a"), redirected("/b")])).toEqual(failed);
  });

  it("names a redirect once, however many identical requests it answered", () => {
    expect(undecidedByRedirects(pass(rule, 2), [redirected("/b"), redirected("/b")])).toEqual(
      skip(
        rule,
        `no answer to decide on: every request the rule sent was answered by a redirect the kit does not follow or read (${named("/b")})`,
      ),
    );
  });

  it("names the redirects in the reason of a rule that skipped on its own", () => {
    expect(
      undecidedByRedirects(skip(rule, "nothing to grade"), [read("/a"), redirected("/b")]),
    ).toEqual(
      skip(
        rule,
        `nothing to grade; 1 of 2 requests the rule sent were answered by a redirect the kit does not follow or read (${named("/b")})`,
      ),
    );
  });
});

describe("discover (a relationship endpoint's declared cardinality)", () => {
  const Person = Resource.make("people", { attributes: { name: Schema.String } });
  const Article = Resource.make("articles", {
    attributes: { title: Schema.String },
    relationships: {
      author: Relationship.one(() => Person),
      editor: Relationship.optional(() => Person),
      tags: Relationship.many(() => Person),
      comments: Relationship.paginated(() => Person),
    },
  });

  it("reads one or many off the success schema, and nothing off one it cannot read", () => {
    const declared = discover(
      HttpApi.make("relationships")
        .add(
          Group.make(
            Article,
            Endpoint.get(Article),
            Endpoint.getRelationship(Article, "author"),
            Endpoint.getRelationship(Article, "editor"),
            Endpoint.getRelationship(Article, "tags"),
            Endpoint.getRelationship(Article, "comments"),
          ),
        )
        .add(
          HttpApiGroup.make("hand-built").add(
            HttpApiEndpoint.get("unknown", "/people/:id/relationships/friends", {
              success: Schema.Unknown,
            }),
            HttpApiEndpoint.get("no-data", "/people/:id/relationships/pets", {
              success: Schema.Struct({ meta: Schema.Unknown }),
            }),
          ),
        ),
    );
    expect(declared.map(({ name, role, linkage }) => `${name} ${role}: ${linkage}`)).toEqual([
      "get resource: unshown",
      "authorRelationship relationship: one",
      "editorRelationship relationship: one",
      "tagsRelationship relationship: many",
      "commentsRelationship relationship: many",
      "unknown relationship: unshown",
      "no-data relationship: unshown",
    ]);
  });
});
