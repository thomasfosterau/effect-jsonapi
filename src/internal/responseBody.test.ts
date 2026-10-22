import { describe, expect, it } from "vite-plus/test";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { unlinkedOnWire } from "./responseBody.js";

const ref = (type: string, id: string) => ({ type, id });

describe("unlinkedOnWire", () => {
  // `GET /articles/1/relationships/comments?include=comments,comments.author`:
  // the primary identifiers seed the walk the endpoint middleware re-runs (#423).
  const relationshipDocument = (included: ReadonlyArray<unknown>) =>
    HttpServerResponse.jsonUnsafe({
      data: [ref("comments", "5")],
      included,
    });
  const comment = {
    ...ref("comments", "5"),
    attributes: { body: "…" },
    relationships: { author: { data: ref("people", "9") } },
  };

  it("passes the members a relationship document's identifiers reach", () => {
    expect(unlinkedOnWire(relationshipDocument([comment, ref("people", "9")]))).toEqual([]);
  });

  it("reports a member a relationship document's identifiers do not reach", () => {
    expect(
      unlinkedOnWire(relationshipDocument([comment, ref("people", "9"), ref("people", "7")])),
    ).toEqual(["people:7"]);
  });
});
