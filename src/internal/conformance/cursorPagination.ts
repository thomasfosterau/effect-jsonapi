/**
 * The Cursor Pagination profile's rules, run against every collection that
 * declares its `page[after]` and `page[before]` parameters: the required
 * `prev` / `next` links, the page size honoured, and the `page[size]` errors.
 *
 * @since 0.23.0
 * @internal
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type Context,
  coverageNote,
  describe,
  type Discovered,
  finding,
  type Finding,
  isJsonArray,
  isJsonObject,
  jsonApiAccept,
  probeable,
  type Rule,
  type RuleImpl,
  settle,
  skip,
  sourceParametersOf,
  topLevel,
  withQuery,
} from "./core.js";
import { render } from "../json.js";

const ERROR_TYPE = "https://jsonapi.org/profiles/ethanresnick/cursor-pagination/max-size-exceeded";

const cursorRule = (
  id: string,
  section: string,
  level: Rule["level"],
  requirement: string,
): Rule => ({
  id,
  tier: "profile",
  section: `cursor-pagination ${section}`,
  reference: "https://jsonapi.org/profiles/ethanresnick/cursor-pagination/",
  level,
  requirement,
});

// Collections that declare the profile's cursors.
const cursorTargets = (ctx: Context) => {
  const { resolved, unresolved } = probeable(ctx, ["collection", "related"]);
  return {
    targets: resolved.filter(({ endpoint }: { readonly endpoint: Discovered }) =>
      ["page[after]", "page[before]", "page[size]"].every((key) =>
        endpoint.queryKeys.includes(key),
      ),
    ),
    unresolved,
  };
};

const NO_CURSORS =
  "no collection declares the profile's `page[size]`, `page[after]` and `page[before]`";

const linksOf = (body: Parameters<typeof topLevel>[0]): Schema.JsonObject =>
  Option.getOrElse(Option.filter(topLevel(body, "links"), isJsonObject), () => ({}));

const itemsOf = (body: Parameters<typeof topLevel>[0]): Option.Option<number> =>
  Option.map(Option.filter(topLevel(body, "data"), isJsonArray), (data) => data.length);

const prevNext: RuleImpl = {
  rule: cursorRule(
    "profile/cursor-pagination/prev-next",
    "Pagination Links",
    "MUST",
    "Every page of paginated data MUST carry `links.prev` and `links.next`, and a page requested without `page[after]` MUST carry `prev: null` when it starts the collection, as the first page does.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const { targets, unresolved } = cursorTargets(ctx);
      if (Arr.isReadonlyArrayEmpty(targets)) return skip(prevNext.rule, NO_CURSORS);
      const findings: Array<Finding> = [];
      yield* Effect.forEach(
        targets,
        ({ path }) =>
          Effect.gen(function* () {
            const observation = yield* ctx.request({ url: path, headers: jsonApiAccept });
            if (observation.status !== 200) return;
            const links = linksOf(observation.body);
            const missing = ["prev", "next"].filter((name) => !(name in links));
            if (!Arr.isReadonlyArrayEmpty(missing)) {
              findings.push(
                finding(prevNext.rule, {
                  detail: `${path} answered a page without ${missing.map((name) => `\`links.${name}\``).join(" or ")}`,
                  expected: "`links.prev` and `links.next`, each a link or `null`",
                  observed: render(links),
                  probe: observation.probe,
                }),
              );
            } else if (links["prev"] !== null) {
              findings.push(
                finding(prevNext.rule, {
                  detail: `${path}'s first page links a previous page`,
                  expected: "`links.prev: null`",
                  observed: render(links["prev"]),
                  probe: observation.probe,
                }),
              );
            }
          }),
        { concurrency: 1, discard: true },
      );
      return settle(prevNext.rule, targets.length, findings, coverageNote(unresolved));
    }),
};

const pageSize: RuleImpl = {
  rule: cursorRule(
    "profile/cursor-pagination/page-size",
    "Page Size",
    "MUST",
    "A response to `page[size]=1` MUST hold exactly one item when the collection has one.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const { targets, unresolved } = cursorTargets(ctx);
      if (Arr.isReadonlyArrayEmpty(targets)) return skip(pageSize.rule, NO_CURSORS);
      const findings: Array<Finding> = [];
      let probes = 0;
      yield* Effect.forEach(
        targets,
        ({ path }) =>
          Effect.gen(function* () {
            const whole = yield* ctx.request({ url: path, headers: jsonApiAccept });
            if (!Option.exists(itemsOf(whole.body), (count) => count > 0)) return;
            const observation = yield* ctx.request({
              url: withQuery(path, [["page[size]", "1"]]),
              headers: jsonApiAccept,
            });
            probes += 1;
            if (!Option.exists(itemsOf(observation.body), (count) => count === 1)) {
              findings.push(
                finding(pageSize.rule, {
                  detail: `${path}?page[size]=1 did not answer a page of one item`,
                  expected: "200 OK with one item in `data`",
                  observed: describe(observation),
                  probe: observation.probe,
                }),
              );
            }
          }),
        { concurrency: 1, discard: true },
      );
      if (probes === 0) return skip(pageSize.rule, "no cursor-paginated collection had an item");
      return settle(pageSize.rule, probes, findings, coverageNote(unresolved));
    }),
};

const invalidSize: RuleImpl = {
  rule: cursorRule(
    "profile/cursor-pagination/invalid-size",
    "Page Size, Errors",
    "MUST",
    "A `page[size]` that is not a positive base-10 integer (`0`, `1e1`) MUST be answered 400 Bad Request with an error naming `page[size]` in `source.parameter`.",
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const { targets, unresolved } = cursorTargets(ctx);
      if (Arr.isReadonlyArrayEmpty(targets)) return skip(invalidSize.rule, NO_CURSORS);
      const findings: Array<Finding> = [];
      const probes = Arr.flatMap(targets, ({ path }) =>
        ["0", "1e1"].map((size) => ({ path, size })),
      );
      yield* Effect.forEach(
        probes,
        ({ path, size }) =>
          Effect.gen(function* () {
            const observation = yield* ctx.request({
              url: withQuery(path, [["page[size]", size]]),
              headers: jsonApiAccept,
            });
            if (
              observation.status !== 400 ||
              !sourceParametersOf(observation).includes("page[size]")
            ) {
              findings.push(
                finding(invalidSize.rule, {
                  detail: `${path}?page[size]=${size} was not refused naming \`page[size]\``,
                  expected: '400 Bad Request with source: { parameter: "page[size]" }',
                  observed: describe(observation),
                  probe: observation.probe,
                }),
              );
            }
          }),
        { concurrency: 1, discard: true },
      );
      return settle(invalidSize.rule, probes.length, findings, coverageNote(unresolved));
    }),
};

const MaxSizeError = Schema.Struct({
  links: Schema.Struct({ type: Schema.Literal(ERROR_TYPE) }),
  source: Schema.Struct({ parameter: Schema.Literal("page[size]") }),
  meta: Schema.Struct({ page: Schema.Struct({ maxSize: Schema.Int }) }),
});

const maxSizeExceeded: RuleImpl = {
  rule: cursorRule(
    "profile/cursor-pagination/max-size-exceeded",
    "Errors, Max Page Size Exceeded",
    "MUST",
    `A \`page[size]\` over the server's maximum MUST be answered 400 Bad Request with an error whose \`links.type\` is ${ERROR_TYPE}, whose \`source.parameter\` is \`page[size]\` and whose \`meta.page.maxSize\` is the maximum, an integer. A server with no maximum serves the page.`,
  ),
  run: (ctx) =>
    Effect.gen(function* () {
      const { targets, unresolved } = cursorTargets(ctx);
      if (Arr.isReadonlyArrayEmpty(targets)) return skip(maxSizeExceeded.rule, NO_CURSORS);
      const findings: Array<Finding> = [];
      yield* Effect.forEach(
        targets,
        ({ path }) =>
          Effect.gen(function* () {
            const observation = yield* ctx.request({
              url: withQuery(path, [["page[size]", "2147483647"]]),
              headers: jsonApiAccept,
            });
            if (observation.status === 200) return;
            const errors = Option.getOrElse(
              Option.filter(topLevel(observation.body, "errors"), isJsonArray),
              () => [],
            );
            if (observation.status === 400 && errors.some(Schema.is(MaxSizeError))) return;
            findings.push(
              finding(maxSizeExceeded.rule, {
                detail: `${path}?page[size]=2147483647 was neither served nor refused with the profile's error`,
                expected: "200 OK, or 400 Bad Request with the max-size-exceeded error",
                observed: describe(observation),
                probe: observation.probe,
              }),
            );
          }),
        { concurrency: 1, discard: true },
      );
      return settle(maxSizeExceeded.rule, targets.length, findings, coverageNote(unresolved));
    }),
};

/**
 * The Cursor Pagination profile's rules, in report order.
 *
 * @internal
 */
export const rules: ReadonlyArray<RuleImpl> = [prevNext, pageSize, invalidSize, maxSizeExceeded];
