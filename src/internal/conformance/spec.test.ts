import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import type * as Schema from "effect/Schema";
import { requestedFieldsets, unlinkedIncluded } from "../linkage.js";

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

  it("does not count a primary resource object's own identity as linked", () => {
    // An included copy of the primary resource is reachable only if something links to it.
    const primary = { ...ref("articles", "1"), attributes: { title: "Hi" } };
    expect(orphans({ data: primary, included: [ref("articles", "1")] })).toEqual(["articles:1"]);
  });

  describe("when the primary data is resource linkage (#423)", () => {
    // `GET /articles/1/relationships/comments?include=comments,comments.author`:
    // the primary identifiers are where the walk starts.
    const comment = (id: string, author: string) => ({
      ...ref("comments", id),
      attributes: { body: "First!" },
      relationships: { author: one(ref("people", author)) },
    });

    it("seeds the walk from to-many primary identifiers", () => {
      const document = {
        data: [ref("comments", "5"), ref("comments", "12")],
        included: [comment("5", "2"), comment("12", "9"), ref("people", "2"), ref("people", "9")],
      };
      expect(orphans(document)).toEqual([]);
    });

    it("seeds the walk from a to-one primary identifier, `meta` and all", () => {
      const document = {
        data: { ...ref("comments", "5"), meta: { pinned: true } },
        included: [comment("5", "2"), ref("people", "2")],
      };
      expect(orphans(document)).toEqual([]);
    });

    it("seeds from a `lid` identifier by its `lid`", () => {
      const document = {
        data: [{ type: "comments", lid: "c1" }],
        included: [{ type: "comments", lid: "c1", attributes: { body: "Draft" } }],
      };
      expect(orphans(document)).toEqual([]);
    });

    it("still reports a member no identifier reaches", () => {
      const document = {
        data: [ref("comments", "5")],
        included: [comment("5", "2"), ref("people", "2"), ref("articles", "1")],
      };
      expect(orphans(document)).toEqual(["articles:1"]);
    });

    it("reports everything when the linkage is empty or null", () => {
      expect(orphans({ data: [], included: [ref("comments", "5")] })).toEqual(["comments:5"]);
      expect(orphans({ data: null, included: [ref("comments", "5")] })).toEqual(["comments:5"]);
    });

    it("does not seed from resource objects' own identities", () => {
      // One resource object makes the primary data resource data, not linkage.
      const document = {
        data: [ref("comments", "5"), { ...ref("comments", "12"), attributes: { body: "Hi" } }],
        included: [comment("5", "2")],
      };
      expect(orphans(document)).toEqual(["comments:5"]);
    });
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
    const document = (included: ReadonlyArray<Schema.Json>) => ({
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

  // §Compound Documents: full linkage is waived "when relationship fields that
  // would otherwise contain linkage data are excluded due to sparse fieldsets"
  // (#494). The wire cannot show what the excluded relationship linked.
  describe("the sparse-fieldset exemption", () => {
    const person = ref("people", "9");
    const comment = { ...ref("comments", "5"), relationships: { author: one(person) } };

    it("reports nothing once the walk reaches a resource of a type a fieldset names", () => {
      // `?include=author&fields[articles]=title`: the primary article.
      const document = {
        data: { ...ref("articles", "1"), attributes: { title: "Hi" } },
        included: [person],
      };
      expect(orphans(document)).toEqual(["people:9"]);
      expect(unlinkedIncluded(document, { articles: ["title"] })).toEqual([]);
      expect(unlinkedIncluded(document, { articles: [] })).toEqual([]);
      // `?include=comments.author&fields[people]=name`: a member the walk
      // reaches, whose own relationships the fieldset may have excluded.
      const linked = {
        data: { ...ref("articles", "1"), relationships: { comments: one([ref("comments", "5")]) } },
        included: [comment, person, ref("tags", "3")],
      };
      expect(unlinkedIncluded(linked, { people: ["name"] })).toEqual([]);
    });

    it("still reports when the walk reaches no resource of a type a fieldset names", () => {
      const document = {
        data: { ...ref("articles", "1"), attributes: { title: "Hi" } },
        included: [person],
      };
      // `people:9` is unreached, so its own fieldset excludes nothing that
      // could link it.
      expect(unlinkedIncluded(document, { people: ["name"] })).toEqual([person]);
      // A relationship document's identifiers are no resource objects.
      expect(
        unlinkedIncluded(
          { data: [ref("comments", "5")], included: [ref("comments", "6")] },
          { comments: ["body"] },
        ),
      ).toEqual([ref("comments", "6")]);
    });
  });

  describe("requestedFieldsets", () => {
    it("reads every `fields[TYPE]`, comma-separated or repeated, empty as the empty set", () => {
      expect(
        requestedFieldsets([
          ["include", "author"],
          ["fields[articles]", "title,author"],
          ["fields[articles]", "body"],
          ["fields[people]", ""],
          ["fields", "x"],
          ["fields[a][b]", "y"],
        ]),
      ).toEqual({ articles: ["title", "author", "body"], people: [] });
    });

    it("keeps a type named `__proto__` as an own member", () => {
      const fieldsets = requestedFieldsets([["fields[__proto__]", "a"]]);
      expect(Object.hasOwn(fieldsets, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(fieldsets)).toBe(Object.prototype);
    });
  });
});
