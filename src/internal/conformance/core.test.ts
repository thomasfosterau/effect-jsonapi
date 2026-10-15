import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse, HttpServerError, HttpServerRequest } from "effect/http";
import {
  answeredAsDeployed,
  type Context,
  finding,
  type Observation,
  pass,
  type Rule,
  runner,
  skip,
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
  return { sent, request: runner(client, "http://origin.test") };
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
        `not decided: 1 of 2 requests the rule sent were answered by a redirect the kit does not follow (${named("/b")}), and a rule is not passed on the answers it did read alone`,
      ),
    );
  });

  it("keeps the rule's own note when every request was redirected", () => {
    expect(undecidedByRedirects(pass(rule, 1, "its note"), [redirected("/b")])).toEqual(
      skip(
        rule,
        `no answer to decide on: every request the rule sent was answered by a redirect the kit does not follow (${named("/b")}); the rule's own note: its note`,
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
        `no answer to decide on: every request the rule sent was answered by a redirect the kit does not follow (${named("/b")})`,
      ),
    );
  });

  it("names the redirects in the reason of a rule that skipped on its own", () => {
    expect(
      undecidedByRedirects(skip(rule, "nothing to grade"), [read("/a"), redirected("/b")]),
    ).toEqual(
      skip(
        rule,
        `nothing to grade; 1 of 2 requests the rule sent were answered by a redirect the kit does not follow (${named("/b")})`,
      ),
    );
  });
});
