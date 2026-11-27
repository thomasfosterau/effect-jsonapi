/**
 * Type-level tests for a relationship's linkage policy: the presets keep their
 * types, `toOne` / `toMany` record the policy they were given, and the resource
 * object, include paths and payloads read it.
 *
 * Type-checked by `tsconfig.json`; the `@ts-expect-error` annotations are the
 * assertions.
 */
import * as Schema from "effect/Schema";
import { Document, Relationship, Resource } from "@thomasfosterau/effect-jsonapi";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertTrue = <T extends true>(): T[] => [];

const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } });
const Comment = Resource.make("comments", { attributes: { body: Schema.String } });

// The presets are their constructors' annotation types and wire schemas.
export const one: Relationship.one<typeof Person> = Relationship.one(() => Person);
export const many: Relationship.many<typeof Comment> = Relationship.many(() => Comment);
export const oneSchema =
  assertTrue<Equals<Relationship.SchemaFor<typeof one>, Relationship.OneSchema<typeof Person>>>();
export const manySchema =
  assertTrue<
    Equals<Relationship.SchemaFor<typeof many>, Relationship.ManySchema<typeof Comment>>
  >();

// `toOne(ref)` / `toMany(ref)` are the presets.
export const toOne: Relationship.one<typeof Person> = Relationship.toOne(() => Person);
export const toOptional: Relationship.optional<typeof Person> = Relationship.toOne(() => Person, {
  nullable: true,
});
export const toMany: Relationship.many<typeof Comment> = Relationship.toMany(() => Comment);

const Article = Resource.make("articles", {
  attributes: { title: Schema.String },
  relationships: {
    author: Relationship.toOne(() => Person, { linkage: "whenIncluded" }),
    reviewer: Relationship.toOne(() => Person, { nullable: true, linkage: "never" }),
    comments: Relationship.toMany(() => Comment, { paginationLinks: true }),
    history: Relationship.toMany(() => Comment, { writable: false }),
  },
});

type Relationships = NonNullable<(typeof Article.Type)["relationships"]>;

// `whenIncluded` linkage, and the relationship itself, may be left out.
export const authorOmittable =
  assertTrue<Equals<undefined extends Relationships["author"] ? true : false, true>>();
export const authorData =
  assertTrue<
    Equals<NonNullable<NonNullable<Relationships["author"]>["data"]>, typeof Person.identifier.Type>
  >();
// A links-only to-one has no `data` and a required `related` link.
export const reviewerLinks =
  assertTrue<
    Equals<undefined extends Relationships["reviewer"]["links"]["related"] ? true : false, false>
  >();
// @ts-expect-error a links-only relationship carries no linkage
export const reviewerData = (relationships: Relationships) => relationships.reviewer.data;
// Pagination links page the linkage of `comments`.
export const commentsNext =
  assertTrue<
    Equals<NonNullable<NonNullable<Relationships["comments"]["links"]>["next"]>, Document.Link>
  >();
export const commentsNextNullable =
  assertTrue<
    Equals<
      null extends NonNullable<Relationships["comments"]["links"]>["next"] ? true : false,
      true
    >
  >();

// `never` linkage is not an include path.
export const includable =
  assertTrue<Equals<Resource.IncludableKeys<typeof Article>, "author" | "comments" | "history">>();

type Create = (typeof Article.createPayload.Type)["data"]["relationships"];
// Writes carry linkage whatever the response policy; `writable: false` is not settable.
export const createKeys =
  assertTrue<Equals<keyof NonNullable<Create>, "author" | "reviewer" | "comments">>();
export const createAuthorData =
  assertTrue<Equals<NonNullable<Create>["author"]["data"], typeof Person.identifier.Type>>();
