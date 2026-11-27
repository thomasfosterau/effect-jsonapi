import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiGroup } from "effect/http-api";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";

const Person = Resource.make("people", { attributes: { name: Schema.String } });
const Comment = Resource.make("comments", { attributes: { body: Schema.String } });
const Article = Resource.make("articles", {
  attributes: { title: Schema.String },
  relationships: {
    author: Relationship.one(() => Person),
    comments: Relationship.many(() => Comment),
  },
});

const article = Article.make({
  id: Article.Id.make("a/1"),
  attributes: { title: "Hi" },
  relationships: {
    author: { data: { type: "people", id: Person.Id.make("9") } },
    comments: { data: [{ type: "comments", id: Comment.Id.make("5") }] },
  },
});

const Api = HttpApi.make("blog")
  .add(
    Group.make(
      Article,
      Endpoint.get(Article, { include: true }),
      Endpoint.related(Article, "author"),
      Endpoint.getRelationship(Article, "author"),
      // `comments` declares only its related route, at a custom path.
      Endpoint.related(Article, "comments", { path: "/articles/:id/discussion" }),
    ),
  )
  .add(Group.make(Person, Endpoint.get(Person)))
  .prefix("/api");

describe("Handlers.links", () => {
  it("fills resource and relationship links from the declared routes, prefix included", () => {
    const document = Handlers.data(article, { onResource: Handlers.links(Api) });
    expect(document.data.links).toEqual({ self: "/api/articles/a%2F1" });
    expect(document.data.relationships?.author.links).toEqual({
      self: "/api/articles/a%2F1/relationships/author",
      related: "/api/articles/a%2F1/author",
    });
    // No `getRelationship` for comments: no `self`, which would promise a route.
    expect(document.data.relationships?.comments.links).toEqual({
      related: "/api/articles/a%2F1/discussion",
    });
  });

  it("fills included resources too, and leaves a type with no `get` route alone", () => {
    const person = Person.make({ id: Person.Id.make("9"), attributes: { name: "Ada" } });
    const comment = Comment.make({ id: Comment.Id.make("5"), attributes: { body: "First" } });
    const document = Handlers.data(article, {
      included: [person, comment],
      onResource: Handlers.links(Api, { base: "https://example.com/" }),
    });
    expect(document.included).toEqual([
      { ...person, links: { self: "https://example.com/api/people/9" } },
      comment,
    ]);
  });

  it("never overwrites a link the handler set", () => {
    const linked = {
      ...article,
      links: { self: "/canonical/1", describedby: "/schema" },
      relationships: {
        ...article.relationships,
        author: { ...article.relationships?.author, links: { related: "/elsewhere" } },
      },
    };
    const document = Handlers.data(linked, { onResource: Handlers.links(Api) });
    expect(document.data.links).toEqual({ self: "/canonical/1", describedby: "/schema" });
    expect(document.data.relationships?.author.links).toEqual({
      related: "/elsewhere",
      self: "/api/articles/a%2F1/relationships/author",
    });
  });

  it("skips a route with path parameters besides `:id`", () => {
    const Scoped = HttpApi.make("scoped").add(
      HttpApiGroup.make("articles").add(
        Endpoint.get(Article, { path: "/tenants/:tenant/articles/:id" }),
      ),
    );
    const document = Handlers.data(article, { onResource: Handlers.links(Scoped) });
    expect("links" in document.data).toBe(false);
  });
});
