/**
 * Type-level tests for the public include-path resolvers over a union of
 * resource definitions (#347).
 *
 * `Resource.ResolveIncludePath`, `Resource.IncludedFor`,
 * `Resource.FamilyIncluded` and `Client.narrowIncluded` distribute over the
 * members and walk each member's includable relationships only. A path legal
 * for one member (`author`, a to-one there) can name another member's
 * `paginated` relationship, whose target never appears in `included`, so the
 * walk stops there, at the first hop or any later one. A path segment one
 * member does not declare reaches nothing for that member, and still reaches
 * the target of every member that does declare it.
 *
 * This file is type-checked by `tsconfig.json`; the `Pin` tuples and the
 * `@ts-expect-error` annotations are the assertions. The runtime half — the
 * server admits and sends exactly these types — is the paginated-member cases
 * of `src/Endpoint.included.test.ts`.
 */
import * as Schema from "effect/Schema";
import { Client, Relationship, Resource } from "@thomasfosterau/effect-jsonapi";

// Compiles only when `A` and `B` are identical, not merely mutually assignable.
type Pin<A, B> = [
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false,
] extends [true]
  ? true
  : never;

// ---------------------------------------------------------------------------
// First hop: `author` is paginated on Draft and a to-one on Post
// ---------------------------------------------------------------------------

const Revision = Resource.make("revisions", { attributes: { editedAt: Schema.String } });
const Person = Resource.make("people", { attributes: { name: Schema.String } });
const Editor = Resource.make("editors", { attributes: { name: Schema.String } });
const Entry = Resource.make("entries", { attributes: { title: Schema.String } });
const Draft = Resource.extend(Entry, "drafts", {
  relationships: { author: Relationship.paginated(() => Revision) },
  inheritId: true,
});
const Post = Resource.extend(Entry, "posts", {
  relationships: {
    // Declared by Post alone.
    editor: Relationship.one(() => Editor),
    author: Relationship.one(() => Person),
  },
  inheritId: true,
});
const Entries = Resource.family(Entry, [Post, Draft]);

type Members = typeof Post | typeof Draft;

export const firstHop: [
  Pin<Resource.ResolveIncludePath<Members, "author">, typeof Person>,
  Pin<Resource.IncludedFor<Members, ["author"]>, typeof Person>,
  Pin<Resource.FamilyIncluded<typeof Entries, ["author"]>, typeof Person>,
  // A key only one member declares still reaches that member's target.
  Pin<Resource.ResolveIncludePath<Members, "editor">, typeof Editor>,
  Pin<Resource.FamilyIncluded<typeof Entries, ["author", "editor"]>, typeof Person | typeof Editor>,
  // A single resource: a paginated key reaches nothing, a to-one its target.
  Pin<Resource.ResolveIncludePath<typeof Draft, "author">, never>,
  Pin<Resource.ResolveIncludePath<typeof Post, "author">, typeof Person>,
] = [true, true, true, true, true, true, true];

// Positive control for the negative one below.
export const person: Resource.IncludedFor<Members, ["author"]> = Person;
// @ts-expect-error -- `revisions` is reached only through Draft's paginated `author`
export const revision: Resource.IncludedFor<Members, ["author"]> = Revision;

// ---------------------------------------------------------------------------
// Second hop: `author.employer` crosses Writer's paginated `employer`
// ---------------------------------------------------------------------------

const Archive = Resource.make("archives", { attributes: { label: Schema.String } });
const Company = Resource.make("companies", { attributes: { name: Schema.String } });
const Staff = Resource.make("staff", {
  attributes: { name: Schema.String },
  relationships: { employer: Relationship.one(() => Company) },
});
const Writer = Resource.make("writers", {
  attributes: { name: Schema.String },
  relationships: { employer: Relationship.paginated(() => Archive) },
});
const Article = Resource.extend(Entry, "articles", {
  relationships: { author: Relationship.one(() => Staff) },
  inheritId: true,
});
const Note = Resource.extend(Entry, "notes", {
  relationships: { author: Relationship.one(() => Writer) },
  inheritId: true,
});
const Writings = Resource.family(Entry, [Article, Note]);

type Hop2Members = typeof Article | typeof Note;
type Hop2 = typeof Staff | typeof Company | typeof Writer;

export const secondHop: [
  Pin<Resource.ResolveIncludePath<Hop2Members, "author.employer">, Hop2>,
  Pin<Resource.IncludedFor<Hop2Members, ["author.employer"]>, Hop2>,
  Pin<Resource.FamilyIncluded<typeof Writings, ["author.employer"]>, Hop2>,
] = [true, true, true];

export const writer: Resource.IncludedFor<Hop2Members, ["author.employer"]> = Writer;
// @ts-expect-error -- `archives` is reached only through Writer's paginated `employer`
export const archive: Resource.IncludedFor<Hop2Members, ["author.employer"]> = Archive;

// ---------------------------------------------------------------------------
// Client.narrowIncluded over the member union
// ---------------------------------------------------------------------------

type EntryDocument = ReturnType<typeof Post.document>["Type"];

// Narrows a fetched document over either member to the `author` include.
export const narrowAuthor = (member: Members, document: EntryDocument) =>
  Client.narrowIncluded(member, ["author"], document);

type NarrowedType = NonNullable<ReturnType<typeof narrowAuthor>["included"]>[number]["type"];

export const narrowed: Pin<NarrowedType, "people"> = true;
// A branch on a type the server never sends no longer type-checks.
// @ts-expect-error -- `revisions` is never in `included`: Draft's `author` is paginated
export const neverSent: NarrowedType = "revisions";
