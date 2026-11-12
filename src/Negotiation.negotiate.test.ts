/**
 * The JSON:API half of a generic negotiator, driven end to end (#577):
 * `@thomasfosterau/effect-ext/Negotiate`'s `negotiateRepresentation` decides
 * from the request line and headers, handed `Negotiation.representation(...)`
 * as the JSON:API `Representation`, and `Negotiation.toApiError` turns its
 * refusals into the §5 / §6 errors.
 *
 * The 406 / 415 cases are derived from JSON:API 1.1 §5 and §6 (a server MUST
 * answer `415` to a `Content-Type` carrying a media-type parameter other than
 * `ext` / `profile`, and `406` to an `Accept` whose every JSON:API instance is
 * so modified, or names an unsupported extension): effect-ext's former
 * `tests/web/negotiate.test.ts` was not readable from this session.
 */
import { it } from "@effect/vitest";
import {
  Negotiation as Verdict,
  negotiateRepresentation,
} from "@thomasfosterau/effect-ext/Negotiate";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";
import * as ApiError from "./ApiError.js";
import { MEDIA_TYPE } from "./internal/media.js";
import * as Negotiation from "./Negotiation.js";

const ORIGIN = "https://example.test";
const ATOMIC = "https://jsonapi.org/ext/atomic";
const UNDECLARED = "https://example.com/ext/unknown";

const jsonApi = Negotiation.representation({
  extensions: [ATOMIC],
  servesPath: (path) => path === "/articles" || path.startsWith("/articles/"),
});

const options = { accept: [jsonApi], contentType: [jsonApi] };

const read = (path: string, accept?: string, method = "GET") =>
  HttpServerRequest.fromWeb(
    new Request(`${ORIGIN}${path}`, { method, headers: accept === undefined ? {} : { accept } }),
  );

const write = (path: string, contentType: string, method = "POST") =>
  HttpServerRequest.fromWeb(
    new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": contentType } }),
  );

// The §5 error a verdict maps to, as the status / code a client would read.
const wireError = (outcome: Negotiation.Outcome) =>
  Option.flatMap(Negotiation.toApiError(outcome), (error) =>
    Arr.head(ApiError.toDocument(error).errors),
  );

describe("negotiateRepresentation with the JSON:API representation (#577)", () => {
  describe("Accept", () => {
    it.effect("selects a plain application/vnd.api+json", () =>
      Effect.sync(() => {
        const verdict = negotiateRepresentation(read("/articles", MEDIA_TYPE), options);
        expect(verdict._tag).toBe("Selected");
        expect(Verdict.$is("Selected")(verdict) && verdict.representation).toBe(jsonApi);
        expect(Negotiation.toApiError(verdict)).toEqual(Option.none());
      }),
    );

    it.effect("selects on HEAD and over a lower-ranked HTML range", () =>
      Effect.sync(() => {
        expect(negotiateRepresentation(read("/articles", MEDIA_TYPE, "HEAD"), options)._tag).toBe(
          "Selected",
        );
        expect(
          negotiateRepresentation(read("/articles/1", `${MEDIA_TYPE}, text/html;q=0.5`), options)
            ._tag,
        ).toBe("Selected");
      }),
    );

    it.effect("selects a declared ext and a profile", () =>
      Effect.sync(() => {
        expect(
          negotiateRepresentation(read("/articles", `${MEDIA_TYPE};ext="${ATOMIC}"`), options)._tag,
        ).toBe("Selected");
        expect(
          negotiateRepresentation(
            read("/articles", `${MEDIA_TYPE};profile="https://x.test"`),
            options,
          )._tag,
        ).toBe("Selected");
      }),
    );

    it.effect("selects a clean instance beside a parameterised one (§5)", () =>
      Effect.sync(() => {
        expect(
          negotiateRepresentation(
            read("/articles", `${MEDIA_TYPE};charset=utf-8, ${MEDIA_TYPE}`),
            options,
          )._tag,
        ).toBe("Selected");
      }),
    );

    it.effect("refuses an undeclared ext as 406 not_acceptable", () =>
      Effect.sync(() => {
        const verdict = negotiateRepresentation(
          read("/articles", `${MEDIA_TYPE};ext="${UNDECLARED}"`),
          options,
        );
        expect(verdict._tag).toBe("NotAcceptable");
        expect(Option.map(wireError(verdict), (e) => [e.status, e.code])).toEqual(
          Option.some(["406", "not_acceptable"]),
        );
        expect(Negotiation.toApiError(verdict)).toEqual(Option.some(new ApiError.NotAcceptable()));
      }),
    );

    it.effect("refuses a media-type parameter other than ext / profile as 406", () =>
      Effect.forEach(
        [
          `${MEDIA_TYPE};charset=utf-8`,
          `${MEDIA_TYPE};profile="https://x.test";foo=bar`,
          `${MEDIA_TYPE};ext="${ATOMIC}";version=1`,
        ],
        (accept) =>
          Effect.sync(() => {
            const verdict = negotiateRepresentation(read("/articles", accept), options);
            expect(verdict._tag).toBe("NotAcceptable");
            expect(Option.map(wireError(verdict), (e) => e.status)).toEqual(Option.some("406"));
          }),
        { concurrency: 1, discard: true },
      ),
    );

    it.effect("refuses every ext when none is declared", () =>
      Effect.sync(() => {
        const bare = { accept: [Negotiation.representation()] };
        expect(
          negotiateRepresentation(read("/articles", `${MEDIA_TYPE};ext="${ATOMIC}"`), bare)._tag,
        ).toBe("NotAcceptable");
      }),
    );

    it.effect("falls back for a browser navigation, a bare wildcard and no Accept", () =>
      Effect.forEach(
        ["text/html,application/xhtml+xml,*/*;q=0.8", "*/*", "application/json", undefined],
        (accept) =>
          Effect.sync(() => {
            const verdict = negotiateRepresentation(read("/articles", accept), options);
            expect(verdict._tag).toBe("Fallback");
            expect(Negotiation.toApiError(verdict)).toEqual(Option.none());
          }),
        { concurrency: 1, discard: true },
      ),
    );
  });

  describe("Content-Type", () => {
    it.effect("selects a plain application/vnd.api+json write", () =>
      Effect.forEach(
        ["POST", "PUT", "PATCH", "DELETE"],
        (method) =>
          Effect.sync(() => {
            expect(
              negotiateRepresentation(write("/articles", MEDIA_TYPE, method), options)._tag,
            ).toBe("Selected");
          }),
        { concurrency: 1, discard: true },
      ),
    );

    it.effect("selects a declared ext", () =>
      Effect.sync(() => {
        expect(
          negotiateRepresentation(write("/articles", `${MEDIA_TYPE};ext="${ATOMIC}"`), options)
            ._tag,
        ).toBe("Selected");
      }),
    );

    it.effect("refuses an undeclared ext as 415 unsupported_media_type", () =>
      Effect.sync(() => {
        const verdict = negotiateRepresentation(
          write("/articles", `${MEDIA_TYPE};ext="${UNDECLARED}"`),
          options,
        );
        expect(verdict._tag).toBe("UnsupportedMediaType");
        expect(Option.map(wireError(verdict), (e) => [e.status, e.code])).toEqual(
          Option.some(["415", "unsupported_media_type"]),
        );
        expect(Negotiation.toApiError(verdict)).toEqual(
          Option.some(new ApiError.UnsupportedMediaType()),
        );
      }),
    );

    it.effect("refuses a media-type parameter other than ext / profile as 415", () =>
      Effect.forEach(
        [`${MEDIA_TYPE};charset=utf-8`, `${MEDIA_TYPE};profile="https://x.test";foo=bar`],
        (contentType) =>
          Effect.sync(() => {
            const verdict = negotiateRepresentation(write("/articles", contentType), options);
            expect(verdict._tag).toBe("UnsupportedMediaType");
            expect(Option.map(wireError(verdict), (e) => e.status)).toEqual(Option.some("415"));
          }),
        { concurrency: 1, discard: true },
      ),
    );

    it.effect("falls back for another content type, or none", () =>
      Effect.sync(() => {
        expect(negotiateRepresentation(write("/articles", "application/json"), options)._tag).toBe(
          "Fallback",
        );
        expect(
          negotiateRepresentation(
            write("/articles", "application/x-www-form-urlencoded;charset=utf-8"),
            options,
          )._tag,
        ).toBe("Fallback");
        const none = HttpServerRequest.fromWeb(
          new Request(`${ORIGIN}/articles`, { method: "POST" }),
        );
        expect(negotiateRepresentation(none, options)._tag).toBe("Fallback");
      }),
    );
  });

  describe("servesPath", () => {
    it.effect("falls back for a path the representation does not serve", () =>
      Effect.sync(() => {
        expect(negotiateRepresentation(read("/about", MEDIA_TYPE), options)._tag).toBe("Fallback");
        // Even a parameterised instance is no 406 where JSON:API isn't served.
        expect(
          negotiateRepresentation(read("/about", `${MEDIA_TYPE};charset=utf-8`), options)._tag,
        ).toBe("Fallback");
        expect(
          negotiateRepresentation(write("/about", `${MEDIA_TYPE};charset=utf-8`), options)._tag,
        ).toBe("Fallback");
      }),
    );

    it.effect("serves every path when none is given", () =>
      Effect.sync(() => {
        const everywhere = { accept: [Negotiation.representation()] };
        expect(negotiateRepresentation(read("/about", MEDIA_TYPE), everywhere)._tag).toBe(
          "Selected",
        );
      }),
    );
  });

  describe("toApiError", () => {
    it.effect("is none for a refusal of another representation, and for non-refusals", () =>
      Effect.suspend(() => {
        const markdown = { mediaType: "text/markdown" };
        const outcomes: ReadonlyArray<Negotiation.Outcome> = [
          Verdict.Selected({ representation: markdown }),
          Verdict.Fallback(),
          Verdict.NotAcceptable({ representation: markdown }),
          Verdict.UnsupportedMediaType({ representation: markdown }),
        ];
        return Effect.forEach(
          outcomes,
          (outcome) =>
            Effect.sync(() => {
              expect(Negotiation.toApiError(outcome)).toEqual(Option.none());
            }),
          { concurrency: 1, discard: true },
        );
      }),
    );
  });
});
