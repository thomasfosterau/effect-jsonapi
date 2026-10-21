/**
 * The representation verdict, pinned against the consuming applications'
 * negotiation corpus: which requests dispatch to the JSON:API surface, the
 * normalised representation token, the §5 negotiation statuses, the
 * path-match that keeps a page-only URL out of the JSON:API namespace, and
 * an alternate representation negotiated ahead of JSON:API.
 */
import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import { MEDIA_TYPE } from "./internal/media.js";
import * as Negotiation from "./Negotiation.js";
import * as Resource from "./Resource.js";

const Contest = Resource.make("contests", { attributes: { name: Schema.NonEmptyString } });
const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } });

const Api = HttpApi.make("test")
  .add(Group.make(Contest, Endpoint.get(Contest), Endpoint.list(Contest)))
  .add(
    Group.make(
      Person,
      Endpoint.get(Person),
      Endpoint.list(Person),
      Endpoint.create(Person),
      Endpoint.update(Person),
      Endpoint.delete(Person),
    ),
  )
  .add(
    HttpApiGroup.make("feed")
      .add(HttpApiEndpoint.post("crawl", "/crawl", { success: Schema.Unknown }))
      .add(HttpApiEndpoint.get("status", "/crawl/:origin", { success: Schema.Unknown }))
      .prefix("/feed"),
  )
  .add(
    HttpApiGroup.make("root").add(HttpApiEndpoint.get("home", "/", { success: Schema.Unknown })),
  );

const { isApiPath, negotiate } = Negotiation.make({ api: Api });

const ORIGIN = "https://example.test";
const UUID = "0b9aab8a-3d24-4b85-a3a6-046cba9856ce";

const get = (path: string, accept?: string): Request =>
  new Request(`${ORIGIN}${path}`, {
    method: "GET",
    headers: accept === undefined ? {} : { accept },
  });

const write = (method: string, path: string, contentType?: string): Request =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: contentType === undefined ? {} : { "content-type": contentType },
  });

/** Assert a verdict is a clean HTML fall-through (no dispatch, no §5 error). */
const expectHtmlFallthrough = (verdict: Negotiation.Verdict): void => {
  expect(verdict.dispatch).toBe(false);
  expect(verdict.representation).toBe("text/html");
  expect(verdict.error).toBeUndefined();
};

describe("isApiPath", () => {
  it("matches known endpoint paths, with or without a trailing slash", () => {
    expect(isApiPath("/contests")).toBe(true);
    expect(isApiPath("/contests/")).toBe(true);
    expect(isApiPath(`/contests/${UUID}`)).toBe(true);
    expect(isApiPath(`/people/${UUID}`)).toBe(true);
    expect(isApiPath("/feed/crawl")).toBe(true);
    expect(isApiPath("/feed/crawl/https:%2F%2Fmediafeed.aec.gov.au")).toBe(true);
  });

  it("rejects page-only and non-endpoint paths, and never matches on a root route", () => {
    expect(isApiPath("/about")).toBe(false);
    expect(isApiPath("/")).toBe(false);
    expect(isApiPath(`/people/${UUID}/edit`)).toBe(false);
    expect(isApiPath("/api/auth/session")).toBe(false);
  });

  it("accepts the group list the api was assembled from, equivalently", () => {
    const fromGroups = Negotiation.make({ api: Object.values(Api.groups) });
    expect(fromGroups.isApiPath("/contests")).toBe(true);
    expect(fromGroups.isApiPath("/about")).toBe(false);
  });
});

describe("negotiate — reads (Accept)", () => {
  it("dispatches when the JSON:API media type wins on an API path", () => {
    const verdict = negotiate(get("/contests", MEDIA_TYPE));
    expect(verdict).toEqual({ representation: MEDIA_TYPE, dispatch: true });
  });

  it("dispatches a HEAD the same way as a GET", () => {
    const verdict = negotiate(
      new Request(`${ORIGIN}/contests`, { method: "HEAD", headers: { accept: MEDIA_TYPE } }),
    );
    expect(verdict.dispatch).toBe(true);
  });

  it("falls through to HTML for a browser navigation Accept", () => {
    expectHtmlFallthrough(
      negotiate(
        get("/contests", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
      ),
    );
  });

  it("normalises distinct browser Accept strings to one cache-key token", () => {
    const a = negotiate(get("/contests", "text/html,*/*;q=0.8"));
    const b = negotiate(get("/contests", "text/html,application/xml;q=0.9"));
    expect(a.representation).toBe("text/html");
    expect(b.representation).toBe(a.representation);
  });

  it("never matches application/json or the wildcard range", () => {
    expect(negotiate(get("/contests", "application/json")).dispatch).toBe(false);
    expect(negotiate(get("/contests", "*/*")).dispatch).toBe(false);
  });

  it("falls through to HTML when the path is not an API resource, or there is no Accept", () => {
    expectHtmlFallthrough(negotiate(get("/about", MEDIA_TYPE)));
    expectHtmlFallthrough(negotiate(get("/contests")));
  });

  it("allows ext / profile parameters (clean instance)", () => {
    expect(negotiate(get("/contests", `${MEDIA_TYPE};profile=https://x`)).dispatch).toBe(true);
    expect(negotiate(get("/contests", `${MEDIA_TYPE};ext=atomic`)).dispatch).toBe(true);
  });

  it("§5: 406 when every JSON:API instance is parameterised, but not on a page-only path", () => {
    const verdict = negotiate(get("/contests", `${MEDIA_TYPE};version=1`));
    expect(verdict.dispatch).toBe(false);
    expect(verdict.error).toBe(Negotiation.NOT_ACCEPTABLE);
    expect(verdict.error?.status).toBe(406);
    const page = negotiate(get("/about", `${MEDIA_TYPE};version=1`));
    expect(page.error).toBeUndefined();
    expect(page.dispatch).toBe(false);
  });

  it("loses to a higher-q competitor, wins on a tie", () => {
    expect(negotiate(get("/contests", `${MEDIA_TYPE};q=0.5, text/html;q=0.9`)).dispatch).toBe(
      false,
    );
    expect(negotiate(get("/contests", `${MEDIA_TYPE}, text/html`)).dispatch).toBe(true);
  });

  it("treats a clean `q=0` instance as an explicit refusal, not a §5 parameterisation", () => {
    expectHtmlFallthrough(negotiate(get("/contests", `${MEDIA_TYPE};q=0, text/html`)));
  });

  it("treats an unparseable q= as the default 1 (still wins on a tie)", () => {
    expect(negotiate(get("/contests", `${MEDIA_TYPE};q=abc`)).dispatch).toBe(true);
  });

  it.each(["", "0x0", "-1", "1e-9", "2", ".5"])(
    "treats q=%s, outside the RFC 9110 qvalue grammar, as unparseable — never as a q=0 refusal",
    (q) => {
      expect(negotiate(get("/contests", `${MEDIA_TYPE};q=${q}`)).dispatch).toBe(true);
    },
  );

  it("does not read an out-of-range q as a weight above 1 that beats every competitor", () => {
    expect(negotiate(get("/contests", `${MEDIA_TYPE};q=2, text/html;q=1`)).dispatch).toBe(true);
    expect(negotiate(get("/contests", `text/html;q=2, ${MEDIA_TYPE}`)).dispatch).toBe(true);
  });
});

describe("negotiate — writes (Content-Type)", () => {
  it("dispatches a JSON:API write on an API path, a bodyless DELETE included", () => {
    expect(negotiate(write("POST", "/people", MEDIA_TYPE)).dispatch).toBe(true);
    expect(negotiate(write("DELETE", `/people/${UUID}`, MEDIA_TYPE)).dispatch).toBe(true);
  });

  it("does not dispatch an application/json write, or one with no Content-Type", () => {
    expect(negotiate(write("POST", "/people", "application/json")).dispatch).toBe(false);
    expectHtmlFallthrough(negotiate(write("POST", "/people")));
  });

  it("§5: 415 when the write Content-Type carries a disallowed parameter", () => {
    const verdict = negotiate(write("PATCH", `/people/${UUID}`, `${MEDIA_TYPE};charset=utf-8`));
    expect(verdict.dispatch).toBe(false);
    expect(verdict.error).toBe(Negotiation.UNSUPPORTED_MEDIA_TYPE);
  });

  it("allows ext / profile on a write Content-Type", () => {
    expect(negotiate(write("POST", "/people", `${MEDIA_TYPE};ext=atomic`)).dispatch).toBe(true);
  });

  it("falls through for a JSON:API write to a non-API path", () => {
    expect(negotiate(write("POST", "/about", MEDIA_TYPE)).dispatch).toBe(false);
  });
});

describe("negotiate — non-read, non-write methods", () => {
  it("falls through to HTML for OPTIONS even on an API path", () => {
    expectHtmlFallthrough(negotiate(new Request(`${ORIGIN}/contests`, { method: "OPTIONS" })));
  });
});

describe("alternates and the fallback", () => {
  const markdown = Negotiation.make({
    api: Api,
    fallback: "text/html",
    alternates: [
      { mediaType: "text/markdown", matches: Negotiation.detailPages(["contests", "posts"]) },
    ],
  });

  it("serves the alternate on its paths when the client names it, ahead of JSON:API", () => {
    expect(markdown.negotiate(get(`/contests/${UUID}`, "text/markdown"))).toEqual({
      representation: "text/markdown",
      dispatch: false,
    });
    expect(markdown.negotiate(get(`/contests/${UUID}`, `text/markdown, ${MEDIA_TYPE}`))).toEqual({
      representation: "text/markdown",
      dispatch: false,
    });
  });

  it("never wins on a browser Accept, a collection path, or a lower weight", () => {
    expect(markdown.negotiate(get(`/contests/${UUID}`, "text/html,*/*;q=0.8")).representation).toBe(
      "text/html",
    );
    expect(markdown.negotiate(get("/contests", "text/markdown")).representation).toBe("text/html");
    expect(
      markdown.negotiate(get(`/contests/${UUID}`, `text/markdown;q=0.5, ${MEDIA_TYPE}`)).dispatch,
    ).toBe(true);
  });

  it("reports the host's own fallback token", () => {
    const custom = Negotiation.make({ api: Api, fallback: "text/plain" });
    expect(custom.negotiate(get("/contests")).representation).toBe("text/plain");
  });
});

describe("onExplicitRefusal", () => {
  const refusing = Negotiation.make({
    api: Api,
    onExplicitRefusal: "notAcceptable",
    alternates: [{ mediaType: "text/markdown", matches: Negotiation.detailPages(["contests"]) }],
  });

  it('defaults to falling through on a lone `q=0`, as does an explicit "fallthrough"', () => {
    expectHtmlFallthrough(negotiate(get("/contests", `${MEDIA_TYPE};q=0`)));
    const explicit = Negotiation.make({ api: Api, onExplicitRefusal: "fallthrough" });
    expectHtmlFallthrough(explicit.negotiate(get("/contests", `${MEDIA_TYPE};q=0`)));
  });

  it("406s a lone `q=0` JSON:API range, with a detail distinct from the §6.3.2 406", () => {
    const verdict = refusing.negotiate(get("/contests", `${MEDIA_TYPE};q=0`));
    expect(verdict.dispatch).toBe(false);
    expect(verdict.error).toBe(Negotiation.NOT_ACCEPTABLE_REFUSED);
    expect(verdict.error?.status).toBe(406);
    expect(verdict.error?.code).toBe(Negotiation.NOT_ACCEPTABLE.code);
    expect(verdict.error?.detail).not.toBe(Negotiation.NOT_ACCEPTABLE.detail);
    expect(refusing.negotiate(get("/contests", `${MEDIA_TYPE};q=0.0, text/html;q=0`)).error).toBe(
      Negotiation.NOT_ACCEPTABLE_REFUSED,
    );
    expect(refusing.negotiate(get("/contests", `${MEDIA_TYPE};q=0, */*;q=0`)).error).toBe(
      Negotiation.NOT_ACCEPTABLE_REFUSED,
    );
  });

  // #234's reproduction: a `q` outside the RFC 9110 qvalue grammar is
  // malformed (the default weight), never the explicit `q=0` refusal this
  // option answers with a 406.
  it.each(["", "0x0", "-1", "abc", "2", ".5"])(
    "dispatches a lone JSON:API range weighted `q=%s`",
    (q) => {
      const verdict = refusing.negotiate(get("/contests", `${MEDIA_TYPE};q=${q}`));
      expect(verdict.error).toBeUndefined();
      expect(verdict).toEqual({ representation: MEDIA_TYPE, dispatch: true });
    },
  );

  it.each(["0", "0.000"])("still 406s a lone JSON:API range weighted `q=%s`", (q) => {
    expect(refusing.negotiate(get("/contests", `${MEDIA_TYPE};q=${q}`)).error).toBe(
      Negotiation.NOT_ACCEPTABLE_REFUSED,
    );
  });

  it("406s a lone `q=0` refusal of a clean `ext` instance", () => {
    expect(
      refusing.negotiate(get("/contests", `${MEDIA_TYPE};ext="https://jsonapi.org/ext/atomic";q=0`))
        .error,
    ).toBe(Negotiation.NOT_ACCEPTABLE_REFUSED);
  });

  it("serves the host's representation, or an alternate, when another range has `q > 0`", () => {
    expectHtmlFallthrough(
      refusing.negotiate(get("/contests", `${MEDIA_TYPE};q=0, text/html;q=0.5`)),
    );
    expect(
      refusing.negotiate(get(`/contests/${UUID}`, `${MEDIA_TYPE};q=0, text/markdown;q=0.5`)),
    ).toEqual({ representation: "text/markdown", dispatch: false });
  });

  it("treats `application/json` or a wildcard alongside the refusal as acceptable", () => {
    expectHtmlFallthrough(
      refusing.negotiate(get("/contests", `${MEDIA_TYPE};q=0, application/json`)),
    );
    expectHtmlFallthrough(refusing.negotiate(get("/contests", `${MEDIA_TYPE};q=0, */*;q=0.1`)));
  });

  it("dispatches when another clean JSON:API instance is acceptable", () => {
    expect(
      refusing.negotiate(get("/contests", `${MEDIA_TYPE};q=0, ${MEDIA_TYPE};ext=atomic`)),
    ).toEqual({ representation: MEDIA_TYPE, dispatch: true });
  });

  // Pending an owner decision recorded on #198
  // (https://github.com/thomasfosterau/effect-jsonapi/issues/198#issuecomment-6050059821):
  // this pins today's behaviour, not a settled one. A parameterised JSON:API
  // range with `q > 0` counts as "another acceptable range", so adding the
  // refusal turns the §6.3.2 406 that range earns on its own into a page.
  it("falls through when a parameterised JSON:API range with `q > 0` accompanies the refusal", () => {
    expect(refusing.negotiate(get("/contests", `${MEDIA_TYPE};version=1`)).error).toBe(
      Negotiation.NOT_ACCEPTABLE,
    );
    expectHtmlFallthrough(
      refusing.negotiate(get("/contests", `${MEDIA_TYPE};version=1, ${MEDIA_TYPE};q=0`)),
    );
  });

  it("leaves the §6.3.2 406, page-only paths, writes and a missing Accept as they were", () => {
    expect(refusing.negotiate(get("/contests", `${MEDIA_TYPE};version=1;q=0`)).error).toBe(
      Negotiation.NOT_ACCEPTABLE,
    );
    expectHtmlFallthrough(refusing.negotiate(get("/about", `${MEDIA_TYPE};q=0`)));
    expectHtmlFallthrough(refusing.negotiate(get("/contests")));
    expect(refusing.negotiate(write("POST", "/people", MEDIA_TYPE)).dispatch).toBe(true);
  });
});

describe("isMutatingMethod", () => {
  it("classifies mutating methods", () => {
    for (const m of ["POST", "put", "Patch", "DELETE"])
      expect(Negotiation.isMutatingMethod(m)).toBe(true);
    for (const m of ["GET", "HEAD", "OPTIONS"]) expect(Negotiation.isMutatingMethod(m)).toBe(false);
  });
});

describe("requestForRouter", () => {
  it("relabels a JSON:API write Content-Type to application/json, and leaves reads unchanged", () => {
    const router = Negotiation.requestForRouter(write("POST", "/people", MEDIA_TYPE));
    expect(router.headers.get("content-type")).toBe("application/json");
    const original = get("/contests", MEDIA_TYPE);
    expect(Negotiation.requestForRouter(original)).toBe(original);
  });
});

describe("errorResponse", () => {
  it("serialises a JSON:API error document with the media type", async () => {
    const response = Negotiation.errorResponse({
      status: 415,
      code: "unsupported-media-type",
      title: "Unsupported Media Type",
      detail: "nope",
    });
    expect(response.status).toBe(415);
    expect(response.headers.get("content-type")).toBe(MEDIA_TYPE);
    const body = (await response.json()) as {
      errors: ReadonlyArray<{ status: string; code: string }>;
      jsonapi: { version: string };
    };
    expect(body.jsonapi.version).toBe("1.1");
    expect(body.errors[0]).toEqual({
      status: "415",
      code: "unsupported-media-type",
      title: "Unsupported Media Type",
      detail: "nope",
    });
  });

  it("serialises the host guards as 403 / 503 documents", async () => {
    const forbidden = Negotiation.errorResponse(Negotiation.CROSS_ORIGIN_REJECTED);
    expect(forbidden.status).toBe(403);
    expect(
      ((await forbidden.json()) as { errors: ReadonlyArray<{ code: string }> }).errors[0]?.code,
    ).toBe("auth.forbidden");
    const unavailable = Negotiation.errorResponse(Negotiation.SERVICE_UNAVAILABLE);
    expect(unavailable.status).toBe(503);
    expect(
      ((await unavailable.json()) as { errors: ReadonlyArray<{ code: string }> }).errors[0]?.code,
    ).toBe("unavailable");
  });
});
