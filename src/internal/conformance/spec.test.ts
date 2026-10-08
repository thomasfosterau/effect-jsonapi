import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import { unlinkedIncluded } from "./spec.js";

/** A resource identifier object, which a resource object extends. */
const ref = (type: string, id: string) => ({ type, id });

/** A resource identifier object: a `type` and either an `id` or a `lid`. */
type Identifier = { readonly type: string } & ({ readonly id: string } | { readonly lid: string });

/** A to-one or to-many relationship whose resource linkage is `linkage`. */
const one = (linkage: Identifier | ReadonlyArray<Identifier>) => ({ data: linkage });

/** The `type:id` (or `type:lid`) of each member the kit reports, in order. */
const orphans = (document: Parameters<typeof unlinkedIncluded>[0]) =>
  Arr.map(
    unlinkedIncluded(document),
    (resource) => `${String(resource["type"])}:${String(resource["id"] ?? resource["lid"])}`,
  );

describe("unlinkedIncluded (spec/document/full-linkage)", () => {
  it("reports a cycle of members the primary data no longer links to (#239)", () => {
    // The #239 reproduction: `articles:1`'s relationships stripped, so the
    // `people:9` ⇄ `articles:2` cycle links only to itself.
    const included = [
      { ...ref("people", "9"), relationships: { articles: one([ref("articles", "2")]) } },
      { ...ref("articles", "2"), relationships: { author: one(ref("people", "9")) } },
    ];
    expect(orphans({ data: ref("articles", "1"), included })).toEqual(["people:9", "articles:2"]);
    // …and passes it once the primary data links into the cycle.
    expect(
      orphans({
        data: { ...ref("articles", "1"), relationships: { author: one(ref("people", "9")) } },
        included,
      }),
    ).toEqual([]);
  });

  it("reports a member whose only reference is its own relationship", () => {
    const manager = { ...ref("people", "9"), relationships: { manager: one(ref("people", "9")) } };
    expect(orphans({ data: [ref("articles", "1")], included: [manager] })).toEqual(["people:9"]);
  });

  it("walks from every element of array primary data", () => {
    // Only the second primary links `people:9`.
    const data = [
      ref("articles", "1"),
      { ...ref("articles", "2"), relationships: { author: one(ref("people", "9")) } },
    ];
    expect(orphans({ data, included: [ref("people", "9")] })).toEqual([]);
  });

  it("does not count the primary data's own identity as linked", () => {
    // An included copy of the primary resource is reachable only if something links to it.
    expect(orphans({ data: ref("articles", "1"), included: [ref("articles", "1")] })).toEqual([
      "articles:1",
    ]);
  });

  it("keys members by `lid` when they have no `id`, apart from an `id` of the same value", () => {
    const document = {
      data: {
        type: "articles",
        lid: "a",
        relationships: { author: one({ type: "people", lid: "p1" }) },
      },
      included: [
        {
          type: "people",
          lid: "p1",
          relationships: { friend: one({ type: "people", lid: "p2" }) },
        },
        { type: "people", lid: "p2" },
        // Nothing links to `lid: "p3"`, and `id: "p1"` is not `lid: "p1"`.
        { type: "people", lid: "p3" },
        ref("people", "p1"),
      ],
    };
    expect(orphans(document)).toEqual(["people:p3", "people:p1"]);
  });

  it("follows only identifiers: null, empty, meta-only and links-only relationships end the walk", () => {
    const document = {
      data: {
        ...ref("articles", "1"),
        relationships: {
          author: one(ref("people", "9")),
          editor: { data: null },
          tags: one([]),
          stats: { meta: { count: 2 } },
          comments: { links: { related: "/articles/1/comments" } },
        },
      },
      included: [ref("people", "9"), ref("comments", "5"), "not a resource", { id: "7" }],
    };
    // A non-record member is not a resource object, so it is not reported; a
    // record with no identity can never be reached, so it is.
    expect(orphans(document)).toEqual(["comments:5", "undefined:7"]);
  });

  it("follows the later of two members with the same identity", () => {
    const linked = { ...ref("people", "9"), relationships: { manager: one(ref("people", "8")) } };
    const bare = ref("people", "9");
    const document = (included: ReadonlyArray<unknown>) => ({
      data: { ...ref("articles", "1"), relationships: { author: one(ref("people", "9")) } },
      included,
    });
    expect(orphans(document([bare, linked, ref("people", "8")]))).toEqual([]);
    expect(orphans(document([linked, bare, ref("people", "8")]))).toEqual(["people:8"]);
  });

  it("walks a 30,000-member chain without overflowing the stack", () => {
    const length = 30_000;
    const included = Arr.makeBy(length, (i) => ({
      ...ref("people", String(i)),
      relationships: {
        manager: i + 1 < length ? one(ref("people", String(i + 1))) : { data: null },
      },
    }));
    const document = {
      data: { ...ref("articles", "1"), relationships: { author: one(ref("people", "0")) } },
      included: [...included, ref("people", "unreached")],
    };
    expect(orphans(document)).toEqual(["people:unreached"]);
  });
});
