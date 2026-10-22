import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { HttpApi } from "effect/http-api";
import * as Conformance from "../../Conformance.js";
import * as Endpoint from "../../Endpoint.js";
import * as Group from "../../Group.js";
import * as Resource from "../../Resource.js";
import { MEDIA_TYPE } from "../media.js";
import * as Core from "./core.js";
import * as Samples from "./samples.js";

const Article = Resource.make("articles", { attributes: { title: Schema.String } });
const Person = Resource.make("people", { attributes: { name: Schema.String } });

const api = HttpApi.make("samples")
  .add(Group.make(Article, Endpoint.get(Article), Endpoint.list(Article)))
  .add(Group.make(Person, Endpoint.get(Person)));

const BASE_URL = "http://fixture.test";

/**
 * A server holding `articles:1` and `people:9`: a `GET` of either answers it,
 * the collection answers it, anything else answers 404. `hits` counts the
 * requests per path.
 */
const server = () => {
  const hits = MutableHashMap.empty<string, number>();
  const held = MutableHashMap.make(
    ["/articles", [{ type: "articles", id: "1", attributes: { title: "t" } }]],
    ["/articles/1", { type: "articles", id: "1", attributes: { title: "t" } }],
    ["/people/9", { type: "people", id: "9", attributes: { name: "n" } }],
  );
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      MutableHashMap.modifyAt(hits, url.pathname, (count) =>
        Option.some(Option.getOrElse(count, () => 0) + 1),
      );
      const data =
        request.method === "GET" ? MutableHashMap.get(held, url.pathname) : Option.none();
      const status = Option.isNone(data) ? 404 : 200;
      const body = Option.match(data, {
        onNone: () => ({ errors: [{ status: "404" }] }),
        onSome: (resource) => ({ data: resource }),
      });
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), { status, headers: { "content-type": MEDIA_TYPE } }),
      );
    }),
  );
  return { client, hits };
};

const run = (client: HttpClient.HttpClient, options: Conformance.Options) =>
  Effect.runPromise(Conformance.verifyWith(api, { client, baseUrl: BASE_URL, ...options }));

describe("Conformance: Report.samples (#319)", () => {
  it("records every `/:type/:id` read the `ids` resolve, with its status", async () => {
    const { client } = server();
    const report = await run(client, { ids: { articles: "1", people: "missing" } });
    expect(report.samples).toEqual([
      { type: "articles", id: "1", url: "/articles/1", status: 200 },
      { type: "people", id: "missing", url: "/people/missing", status: 404 },
    ]);
    // An unresolved sample is not a gap, and fails no rule on its own account.
    expect(report.gaps).toEqual(Conformance.gaps);
  });

  it("names the samples that answered non-2xx in the formatted report", async () => {
    const { client } = server();
    const unresolved = Conformance.format(
      await run(client, { ids: { articles: "1", people: "missing" } }),
    );
    expect(unresolved).toContain("SAMPLES");
    expect(unresolved.replace(/\s+/g, " ")).toContain(
      "1 of 2 `ids` samples answered non-2xx, so every rule that reads it saw less of the api: people:missing (GET /people/missing: 404)",
    );
    expect(unresolved).not.toContain("articles:1 (GET");

    const clean = Conformance.format(await run(client, { ids: { articles: "1", people: "9" } }));
    expect(clean).not.toContain("SAMPLES");
  });

  it("sends no request of its own: a sample no selected rule read is left out", async () => {
    const { client, hits } = server();
    const report = await run(client, {
      ids: { articles: "1", people: "9" },
      only: ["spec/status/delete-response"],
    });
    expect(report.samples).toEqual([]);
    expect([
      MutableHashMap.get(hits, "/articles/1"),
      MutableHashMap.get(hits, "/people/9"),
    ]).toEqual([Option.none(), Option.none()]);
  });

  it("records only a plain read: a probe with its own Accept decides nothing", async () => {
    const ledger = Samples.ledger(Core.discover(api), {
      baseUrl: `${BASE_URL}/`,
      ids: { articles: "1" },
      paths: {},
      absentId: "absent",
      extensions: [],
      mutating: false,
      writes: {},
      requestTimeout: Option.none(),
    });
    const answering =
      (status: number): Core.Context["request"] =>
      (probe) =>
        Effect.succeed({
          probe: { method: "GET", url: probe.url, headers: {}, body: undefined },
          status,
          headers: {},
          contentType: undefined,
          text: "",
          body: undefined,
          transportError: undefined,
          redirects: [],
          unfollowed: Option.none(),
        });
    const samples = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Samples.recording(
          answering(406),
          ledger,
        )({ url: "/articles/1", headers: { accept: "application/json" } });
        yield* Samples.recording(answering(200), ledger)({ url: `${BASE_URL}/articles/1` });
        yield* Samples.recording(answering(500), ledger)({ url: "/articles/1" });
        return Samples.snapshot(ledger);
      }),
    );
    expect(samples).toEqual([{ type: "articles", id: "1", url: "/articles/1", status: 200 }]);
  });
});
