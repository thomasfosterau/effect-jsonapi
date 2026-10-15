/**
 * Type-level tests for mutually-recursive resource definitions.
 *
 * `Relationship.one(() => Person)` is a thunk, so the *runtime* graph has
 * always been free to contain cycles. Inference was not: a pair like
 * `Article` ⇄ `Comment` made each definition's type depend on the other's, and
 * `Resource.make`'s return type is inferred, so TypeScript refused both with
 * `TS7022` / `TS7024`.
 *
 * The escape is the one Effect's own recursive schemas use — an explicit
 * annotation on the recursive binding. Here that is one `interface` per
 * resource in the cycle, extending `Resource.Resource<Type, Attributes, Rels>`
 * with the relationship record spelled out; the attribute record is hoisted to
 * a `const` and referenced with `typeof`, so no attribute schema is restated.
 *
 * This file is type-checked by `tsconfig.test.json`; the `@ts-expect-error`
 * annotations are the assertions. Every negative assertion is paired with a
 * positive control, so an assertion cannot pass because the whole expression
 * broke.
 */
import { Effect, Schema } from "effect";
import type { HttpApiEndpoint } from "effect/http-api";
import {
  Atomic,
  Document,
  Endpoint,
  Group,
  Query,
  Relationship,
  Resource,
} from "@thomasfosterau/effect-jsonapi";

// Asserts that a value is assignable to `Expected`.
const assertType = <Expected>(_value: Expected): void => {};

// ---------------------------------------------------------------------------
// The cycle: articles ⇄ comments, with every relationship kind in it
// ---------------------------------------------------------------------------

const articleAttributes = { title: Schema.NonEmptyString };
const commentAttributes = { body: Schema.NonEmptyString };

interface Article extends Resource.Resource<
  "articles",
  typeof articleAttributes,
  {
    readonly comments: Relationship.many<Comment>;
    readonly editor: Relationship.optional<Article>;
    readonly revisions: Relationship.paginated<Article>;
  }
> {}

interface Comment extends Resource.Resource<
  "comments",
  typeof commentAttributes,
  {
    readonly article: Relationship.one<Article>;
    readonly parent: Relationship.optional<Comment>;
  }
> {}

const Article: Article = Resource.make("articles", {
  attributes: articleAttributes,
  relationships: {
    comments: Relationship.many(() => Comment),
    editor: Relationship.optional(() => Article),
    revisions: Relationship.paginated(() => Article),
  },
});

const Comment: Comment = Resource.make("comments", {
  attributes: commentAttributes,
  relationships: {
    article: Relationship.one(() => Article),
    parent: Relationship.optional(() => Comment),
  },
});

// ---------------------------------------------------------------------------
// Inference survives the cycle — neither side degraded to `any`
// ---------------------------------------------------------------------------

// If `Article` were `any`, every one of these would pass vacuously; the
// `@ts-expect-error` lines below are what prove they didn't.
assertType<"articles">(Article.type);
assertType<"comments">(Comment.type);

// @ts-expect-error -- the type tag is the literal "articles", not any string
assertType<"people">(Article.type);
// @ts-expect-error -- ...and `any` would make this pass
assertType<number>(Comment.type);

// Attributes are the declared schemas, on both sides of the cycle.
assertType<string>(Article.fields.attributes.fields.title.Type);
assertType<string>(Comment.fields.attributes.fields.body.Type);

// @ts-expect-error -- `body` is a Comment attribute, not an Article one
const noBodyOnArticle = Article.fields.attributes.fields.body;
// @ts-expect-error -- `title` is an Article attribute, not a Comment one
const noTitleOnComment = Comment.fields.attributes.fields.title;

// Ids stay branded per resource type, across the cycle.
const articleId = Article.Id.make("1");
const commentId = Comment.Id.make("2");
assertType<string>(articleId);
assertType<typeof articleId>(articleId);
// @ts-expect-error -- an articles id is not a comments id
assertType<typeof commentId>(articleId);

// ---------------------------------------------------------------------------
// Traversal through the cycle keeps its types
// ---------------------------------------------------------------------------

// Article → comments → article → comments: three hops back into the cycle.
const backAround = Article.relationships.comments
  .ref()
  .relationships.article.ref()
  .relationships.comments.ref();
assertType<"comments">(backAround.type);
// @ts-expect-error -- three hops lands on comments, not articles
assertType<"articles">(backAround.type);

// Self-edges resolve too.
assertType<"articles">(Article.relationships.editor.ref().type);
assertType<"comments">(Comment.relationships.parent.ref().type);

// @ts-expect-error -- `author` is not a declared relationship of Article
const noAuthorOnArticle = Article.relationships.author;

// ---------------------------------------------------------------------------
// Include-path derivation across the cycle (#105 is where this bites hardest)
// ---------------------------------------------------------------------------

type ArticlePaths = Resource.IncludePath<Article>;

const path1: ArticlePaths = "comments";
const path2: ArticlePaths = "editor";
const path3: ArticlePaths = "comments.article";
const path4: ArticlePaths = "comments.parent";
const path5: ArticlePaths = "editor.comments";

// @ts-expect-error -- `revisions` is paginated, so it is not includable
const badPath1: ArticlePaths = "revisions";
// @ts-expect-error -- `author` is not a relationship of Article
const badPath2: ArticlePaths = "author";
// @ts-expect-error -- `title` is an attribute, not a relationship
const badPath3: ArticlePaths = "comments.title";

// The union terminates: depth is bounded by the derivation, not by the graph.
type CommentPaths = Resource.IncludePathsTo<Comment, 3>;
const deep: CommentPaths = "article.comments.article";
// @ts-expect-error -- four hops exceeds the declared depth
const tooDeep: CommentPaths = "article.comments.article.comments";

// Resolving a dotted path yields the resources it hoists, intermediates included.
type Resolved = Resource.ResolveIncludePath<Article, "comments.article">;
assertType<Resolved>(Comment);
assertType<Resolved>(Article);
// @ts-expect-error -- the path hoists comments and articles, nothing else
assertType<Resolved>(Schema.String);

// ---------------------------------------------------------------------------
// The `included` union is finite: one hop, not the transitive closure
// ---------------------------------------------------------------------------

type ArticleIncluded = Resource.DefaultIncluded<Article["relationships"]>["Type"];

// `comments` and `editor` are linkable; `revisions` is paginated and excluded.
const included1: ArticleIncluded = {
  type: "comments",
  id: Comment.Id.make("1"),
  attributes: { body: "hi" },
};
// @ts-expect-error -- an unrelated resource type is not in the union
const badIncluded: ArticleIncluded = { type: "people", id: "1", attributes: {} };

// ---------------------------------------------------------------------------
// Write projections are unaffected on both sides of the cycle
// ---------------------------------------------------------------------------

// A required `one` makes the create payload's `relationships` member required.
const createComment: typeof Comment.createPayload.Type = {
  data: {
    type: "comments",
    attributes: { body: "first" },
    relationships: { article: { data: Article.ref("1") } },
  },
};

const badCreateComment: typeof Comment.createPayload.Type = {
  // @ts-expect-error -- `article` is a required `one`, so it cannot be omitted
  data: { type: "comments", attributes: { body: "first" }, relationships: {} },
};

// Update payloads stay partial on both sides.
const updateArticle: typeof Article.updatePayload.Type = {
  data: { type: "articles", id: Article.Id.make("1"), attributes: { title: "new" } },
};
const badUpdateArticle: typeof Article.updatePayload.Type = {
  data: {
    type: "articles",
    id: Article.Id.make("1"),
    // @ts-expect-error -- `revisions` is paginated, so it is not writable here
    relationships: { revisions: { links: { related: "/x" } } },
  },
};

// ---------------------------------------------------------------------------
// Derived surfaces: documents, refs, queries, endpoints, groups, atomics
// ---------------------------------------------------------------------------

const articleDocument = Article.document();
const articleCollection = Article.collection();
const commentDocument = Comment.document();
const nullableArticle = Document.DataDocument(Article.nullable());
const articleRef = Resource.Ref(Article);

assertType<"articles">(articleDocument.fields.data.type);
assertType<"comments">(commentDocument.fields.data.type);

// @ts-expect-error -- the document's primary data is Article, not Comment
assertType<"comments">(articleDocument.fields.data.type);

// Query schemas derive their include whitelist from the cyclic graph.
const articleQuery = Query.schema(Article, { include: true });
const decodedQuery = Schema.decodeUnknownSync(articleQuery)({ include: "comments.article" });
assertType<ReadonlyArray<string> | undefined>(decodedQuery.include);

// Endpoints derive their path and success document from the resource.
const getArticle = Endpoint.get(Article);
const listArticles = Endpoint.list(Article, { include: true });

// Whether two types are identical, not merely mutually assignable.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// The `included` member type of an endpoint's success document.
type IncludedOf<E> =
  HttpApiEndpoint.Success<E> extends { readonly Type: { readonly included?: infer I } }
    ? NonNullable<I> extends ReadonlyArray<infer M>
      ? M
      : never
    : never;
// The walk stays bounded on the cycle: the depth-2 paths reach `comments` and
// `articles` (via `editor` and `comments.article`) and nothing else.
assertType<Equals<IncludedOf<typeof listArticles>, Article["Type"] | Comment["Type"]>>(true);
// Negative control: `Comment` alone is not the union.
assertType<Equals<IncludedOf<typeof listArticles>, Comment["Type"]>>(false);
const getComment = Endpoint.get(Comment);
const articleGroup = Group.resource(Article);

// The path literal proves `Type` was inferred as "articles", not widened to
// `string` — the failure mode an interface-annotated definition used to hit.
assertType<"/articles/:id">(getArticle.path);
assertType<"/comments/:id">(getComment.path);
// @ts-expect-error -- the path is derived from the resource's own type tag
assertType<"/comments/:id">(getArticle.path);

// Atomic operations derive across the cycle too.
const addComment = Atomic.add(Comment, {
  attributes: { body: "first" },
  relationships: { article: { data: Article.ref("1") } },
});
assertType<"add">(addComment.op);

// ---------------------------------------------------------------------------
// Negative control: the annotation is load-bearing
// ---------------------------------------------------------------------------

// Without the interface annotation the pair is exactly the TS7022 / TS7024
// failure this file exists to pin. `Loop` has no annotation and `Knot` refers
// back to it, so `Loop` is "referenced directly or indirectly in its own
// initializer".
// @ts-expect-error -- TS7022: implicitly has type 'any'
const Loop = Resource.make("loops", {
  attributes: { name: Schema.String },
  // @ts-expect-error -- TS7024: thunk implicitly has return type 'any'
  relationships: { knot: Relationship.one(() => Knot) },
});

// @ts-expect-error -- TS7022: the other half of the same cycle
const Knot = Resource.make("knots", {
  attributes: { name: Schema.String },
  // @ts-expect-error -- TS7024: thunk implicitly has return type 'any'
  relationships: { loop: Relationship.one(() => Loop) },
});

// ---------------------------------------------------------------------------
// Runtime values are reachable from the derived schemas (documents decode)
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const decoded = yield* Schema.decodeUnknownEffect(articleDocument)({
    data: {
      type: "articles",
      id: "1",
      attributes: { title: "JSON:API" },
      relationships: { comments: { data: [{ type: "comments", id: "9" }] } },
    },
    included: [{ type: "comments", id: "9", attributes: { body: "nice" } }],
  });
  assertType<string>(decoded.data.attributes.title);
  const first = decoded.included?.[0];
  if (first !== undefined && first.type === "comments") {
    assertType<string>(first.attributes.body);
  }
  return decoded;
});

// ---------------------------------------------------------------------------
// A paginated relationship that declares a canonical order, inside a cycle
// ---------------------------------------------------------------------------

const feedAttributes = { name: Schema.NonEmptyString };
const postAttributes = { body: Schema.NonEmptyString, createdAt: Schema.String };

// `Relationship.paginated` carries its declared `Order` in a second type
// parameter, so the annotation has to name it — as the `const` tuple the
// constructor infers, the same way a filterable `one` names its operators.
interface Feed extends Resource.Resource<
  "feeds",
  typeof feedAttributes,
  {
    readonly posts: Relationship.paginated<
      Post,
      readonly [{ readonly field: "createdAt"; readonly direction: "desc" }]
    >;
  }
> {}

interface Post extends Resource.Resource<
  "posts",
  typeof postAttributes,
  {
    readonly feed: Relationship.one<Feed>;
  }
> {}

const Feed: Feed = Resource.make("feeds", {
  attributes: feedAttributes,
  relationships: {
    posts: Relationship.paginated(() => Post, {
      order: [{ field: "createdAt", direction: "desc" }],
    }),
  },
});

const Post: Post = Resource.make("posts", {
  attributes: postAttributes,
  relationships: { feed: Relationship.one(() => Feed) },
});

assertType<"desc">(Feed.relationships.posts.order[0].direction);
// @ts-expect-error -- the declared order is read back as its literal tuple
assertType<"asc">(Feed.relationships.posts.order[0].direction);

// An order-less `paginated` in a cycle keeps the constructor's `undefined`.
assertType<undefined>(Article.relationships.revisions.order);

type FeedPaths = Resource.IncludePath<Feed>;
// @ts-expect-error -- a paginated relationship is never includable, order or not
const badFeedPath: FeedPaths = "posts";
const feedEndpoint = Endpoint.related(Feed, "posts");

// ---------------------------------------------------------------------------
// Longer cycles, a custom id, `extend` and `family` over cyclic members
// ---------------------------------------------------------------------------

const nodeAttributes = { label: Schema.NonEmptyString };
const edgeAttributes = { weight: Schema.Number };
const graphAttributes = { name: Schema.NonEmptyString };

// A three-resource cycle (node → edge → graph → node), a self-edge, and a
// custom id schema on the resource the cycle passes through last.
interface Node extends Resource.Resource<
  "nodes",
  typeof nodeAttributes,
  {
    readonly edges: Relationship.many<Edge>;
    readonly twin: Relationship.optional<Node>;
  }
> {}

interface Edge extends Resource.Resource<
  "edges",
  typeof edgeAttributes,
  {
    readonly graph: Relationship.one<Graph>;
    readonly history: Relationship.paginated<Node>;
  }
> {}

interface Graph extends Resource.Resource<
  "graphs",
  typeof graphAttributes,
  { readonly root: Relationship.optional<Node> },
  typeof Schema.Unknown,
  Schema.brand<Schema.String, "graphId">
> {}

const Node: Node = Resource.make("nodes", {
  attributes: nodeAttributes,
  relationships: { edges: Relationship.many(() => Edge), twin: Relationship.optional(() => Node) },
});

const Edge: Edge = Resource.make("edges", {
  attributes: edgeAttributes,
  relationships: {
    graph: Relationship.one(() => Graph),
    history: Relationship.paginated(() => Node),
  },
});

const Graph: Graph = Resource.make("graphs", {
  attributes: graphAttributes,
  meta: Schema.Unknown,
  id: Schema.String.pipe(Schema.brand("graphId")),
  relationships: { root: Relationship.optional(() => Node) },
});

// Three hops around the longer cycle land back where they started.
assertType<"nodes">(
  Node.relationships.edges.ref().relationships.graph.ref().relationships.root.ref().type,
);

type NodePaths = Resource.IncludePath<Node>;
const longPath: NodePaths = "edges.graph";
// @ts-expect-error -- `history` is paginated, so it is not includable
const badLongPath: NodePaths = "edges.history";

// `extend` and `family` both take a resource definition apart into its type
// parameters, so both had to keep inferring `Type` from an annotated one.
const TaggedNode = Resource.extend(Node, "taggedNodes", { attributes: { tag: Schema.String } });
const AnyNode = Resource.family("elements", [Node, Edge]);

assertType<"taggedNodes">(TaggedNode.type);
assertType<"elements">(AnyNode.type);
// @ts-expect-error -- `extend` carries the new type tag, not the base's
assertType<"nodes">(TaggedNode.type);

// The inherited relationship still points into the cycle.
assertType<"edges">(TaggedNode.relationships.edges.ref().type);

const graphEndpoint = Endpoint.get(Graph);
assertType<"/graphs/:id">(graphEndpoint.path);

export {
  addComment,
  badFeedPath,
  feedEndpoint,
  AnyNode,
  badLongPath,
  graphEndpoint,
  longPath,
  TaggedNode,
  noAuthorOnArticle,
  noBodyOnArticle,
  noTitleOnComment,
  articleCollection,
  articleGroup,
  articleRef,
  backAround,
  badCreateComment,
  badIncluded,
  badPath1,
  badPath2,
  badPath3,
  badUpdateArticle,
  createComment,
  deep,
  Knot,
  listArticles,
  Loop,
  nullableArticle,
  path1,
  path2,
  path3,
  path4,
  path5,
  program,
  tooDeep,
  updateArticle,
  included1,
};
