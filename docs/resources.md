# Resources

```ts
const Person = Resource.make("people", {
  attributes: {
    firstName: Schema.NonEmptyString,
    lastName: Schema.NonEmptyString,
  },
});

const Tag = Resource.make("tags", {
  attributes: { name: Schema.NonEmptyString },
});

const Comment = Resource.make("comments", {
  attributes: { body: Schema.NonEmptyString, postedAt: Schema.DateFromString },
  relationships: {
    author: Relationship.one(() => Person), // a reference, not a string — typos don't compile
  },
});

const Article = Resource.make("articles", {
  attributes: {
    title: Schema.NonEmptyString,
    body: Schema.String,
    createdAt: Schema.DateFromString, // ISO string on the wire, Date in your code
  },
  relationships: {
    author: Relationship.one(() => Person), // required to-one
    editor: Relationship.optional(() => Person), // nullable to-one
    tags: Relationship.many(() => Tag), // bounded to-many, inlined
    comments: Relationship.paginated(() => Comment), // unbounded to-many, linked
  },
});
```

A resource's attributes and relationships share one namespace with each other and with `type` and `id` ([§Fields](https://jsonapi.org/format/1.1/#document-resource-object-fields)), so `Resource.make` and `Resource.extend` refuse an attribute or relationship named `type` or `id`, and a name declared as both an attribute and a relationship (including one an extension introduces against its base): a type error at the offending key, and a throw naming it when the definition is built.

## Relationship kinds

Each relationship declares its cardinality _and_ how its data travels — inline as resource identifiers, or behind a link to a paginated endpoint. The four constructors are presets over a [linkage policy](#linkage-policy-toone-and-tomany) the core `toOne` / `toMany` take as options:

| Constructor | Cardinality | Wire shape of the relationship object | In `?include=` | In create payload |
| --- | --- | --- | --- | --- |
| `Relationship.one` | to-one | `{ data: identifier }` — never null | ✓ | **required** |
| `Relationship.optional` | to-one | `{ data: identifier \| null }` | ✓ | optional |
| `Relationship.many` | to-many | `{ data: identifier[] }` | ✓ | optional |
| `Relationship.paginated` | to-many | `{ links: { related, self? } }` — **no data** | ✗ (only on its own relationship endpoint, see [compound relationship documents](endpoints.md#compound-relationship-documents)) | ✗ (use relationship endpoints) |

`one` / `optional` / `many` carry **inline linkage**: clients see the related identifiers right inside the parent resource and can pull the full resources into a compound document with `?include=`.

`paginated` is for **unbounded collections** (an article's comments, a user's repositories): the relationship object carries only a required `related` link pointing at a paginated collection endpoint (see [Relationship & related endpoints](endpoints.md#relationship--related-endpoints)).

### Linkage policy: `toOne` and `toMany`

The four constructors are presets. JSON:API 1.1 lets a server decide, per relationship, whether a relationship object carries `data` at all ([§7.2.2.2](https://jsonapi.org/format/1.1/#document-resource-object-relationships): it "MUST contain at least one of" `links`, `data` and `meta`), and the core constructors `Relationship.toOne` and `Relationship.toMany` take that decision, and the ones that follow from it, as options:

| Option | Values | Default |
| --- | --- | --- |
| `linkage` | `"always"`: `data` on every response. `"whenIncluded"`: `data` when the path is in `?include=`, otherwise it may be left out. `"optional"`: `data`, and the relationship itself, may be left out of any response. `"never"`: no `data`, a required `links.related`. | `"always"` |
| `includable` | whether `?include=` may name the relationship | `true`, or `false` under `"never"` |
| `writable` | whether create and update payloads may set it | `true` |
| `paginationLinks` (`toMany`) | whether `links` may carry `first` / `prev` / `next` / `last`, paging the linkage in `data` | `false` |
| `nullable` (`toOne`) | whether linkage may be `null` | `false` |

`toOne(ref)` is `one(ref)`, `toOne(ref, { nullable: true })` is `optional(ref)` and `toMany(ref)` is `many(ref)`; `paginated(ref)` is the `{ linkage: "never", includable: false, writable: false }` policy plus a canonical `order`. `toOne` takes `one`'s `filter` and `key` options, and every constructor takes `meta`.

```ts
const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString },
  relationships: {
    // ids loaded only when asked for
    author: Relationship.toOne(() => Person, { linkage: "whenIncluded" }),
    // an expensive lookup: only `links.related`
    reviewer: Relationship.toOne(() => Person, { nullable: true, linkage: "never" }),
    // a page of linkage, with `links.next` for the rest
    comments: Relationship.toMany(() => Comment, { paginationLinks: true }),
    // unbounded and links-only, but still settable on create
    watchers: Relationship.toMany(() => Person, { linkage: "never", writable: true }),
  },
});
```

The resource schema, its documents, the include paths, the create and update payloads, the atomic operations and the client all read the policy. A write always carries linkage: whatever the response policy, the payloads read `{ data }`. A combination the spec rules out throws when the relationship is declared: `"never"` with `includable` (an included resource must be reached through linkage, §Compound Documents) or with `paginationLinks` (they "MUST paginate the relationship data"), and `"whenIncluded"` without `includable`.

Under `"whenIncluded"` the handler decides what to send: put `data` on the relationship when the request's `include` names it, and leave it out otherwise. The full-linkage check still holds every included resource to being reached through `data`.

Paging is only well defined over a stable total order — `first` / `prev` / `next` / `last` denote a sequence of pages, and a cursor _is_ a position in an order — so a `paginated` relationship can declare the **canonical order** its related collection is paged in, in the same `{ field, direction }` terms `?sort=` decodes into:

```ts
const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString },
  relationships: {
    comments: Relationship.paginated(() => Comment, {
      // newest first, `id` breaking ties so the order — and any cursor into it — is total
      order: [
        { field: "postedAt", direction: "desc" },
        { field: "id", direction: "asc" },
      ],
    }),
  },
});

Resource.relationships(Article).comments.order; // Option.some(the declared terms); Option.none() when none is declared
```

Each term names an attribute of the **related** resource, or its `id`; anything else is a compile error, and an empty or repeating order is refused at definition time.

A to-one relationship is stored as a foreign key on the row that declares it, and every derivation from a resource definition into storage (a table, a sync engine's node graph) needs that key's name. `one` and `optional` take it as `key`, so it is declared once, beside the relationship:

```ts
const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString },
  relationships: {
    author: Relationship.one(() => Person, { key: "authorId" }),
    editor: Relationship.optional(() => Person, { key: "editorId", filter: ["eq", "isnull"] }),
  },
});

Resource.relationships(Article).author.key; // Option.some("authorId"); Option.none() when none is declared

// a derivation into storage falls back to its own column name
const column = Option.getOrElse(Resource.relationships(Article).author.key, () => "author_id");
```

The key is a **storage** fact, not a wire one: the document, the query grammar and the endpoints are unchanged, and on the wire `author` stays linkage, never an attribute. It must be non-empty, must not be an attribute name of the resource, and must not repeat across its to-one relationships; `Resource.make` (and `Resource.extend`) refuse a violation at definition time. The paginated `order` and the to-one `key` are the two storage-facing declarations a relationship carries.

Every relationship object may carry a `meta` member, which defaults to an open record. Every constructor takes a `meta` schema that types it instead. The schema then flows into the resource schema, its documents, `Document.wire` and the flat groups, and so into the endpoints' OpenAPI and their typed clients. A common case is a to-many arm whose linkage is capped per parent and so needs its true count:

```ts
const Contest = Resource.make("contests", {
  attributes: { name: Schema.String },
  relationships: {
    ballots: Relationship.many(() => Ballot, {
      meta: Schema.Struct({ totalCount: Schema.Finite }),
    }),
  },
});
// relationships.ballots.meta: { readonly totalCount: number } | undefined
```

Because the declaration lives in the resource, what `Assemble` and `ResourceHandlers` build over the resource's own type already fits the documents the endpoints declare. For a family whose **every** to-many arm carries the same meta, `Document.wire(schema, { toManyMeta })` and `Group.flat` / `Group.flatReadOnly({ …, toManyMeta })` narrow it at the call site instead. That covers every `many` and `paginated` arm, in the primary data and in `included`, and leaves to-one arms alone.

Everything below is **derived** — never assembled by hand:

| Derived | What it is |
| --- | --- |
| `Article` | the resource object `Schema.Struct` itself (`type`/`id`/`attributes`/…) |
| `Article.Id` | branded id schema — `Article.Id` values can't be mixed with `Person.Id` |
| `Article.identifier` | the `{ type: "articles", id }` resource-identifier schema |
| `Article.ref("1")` | a typed identifier _value_ — handy for relationship linkage |
| `Article.localIdentifier` | the `{ type: "articles", lid }` schema — identifies a resource being created (no server id yet) |
| `Article.lidRef("a1")` | a typed local-identifier _value_ — the `lid` counterpart of `ref` |
| `Article.createPayload` | `{ data: { type, lid?, attributes, relationships } }` — no `id` (a client-generated `data.id` is rejected at `/data/id`, which `Endpoint.create` answers with 403); `one` relationships required, `paginated` (and `writable: false`) relationships and non-`create` [attribute projections](#read-only--per-attribute-projections) excluded |
| `Article.updatePayload` | `{ data: { type, id, attributes? (partial), relationships? } }` — attributes are [tri-state](#update-payloads-set--unset--leave-unchanged); `paginated` (and `writable: false`) relationships and non-`update` [attribute projections](#read-only--per-attribute-projections) excluded |
| `Article.createInput` / `Article.updateInput` | flat ["command-style"](#flat-command-style-payloads) request schemas — attributes (and, for update, the `id`) without the JSON:API envelope |
| `Article.document()` | single-resource document with `Article` as primary `data` (non-null); `included` union derived from the non-paginated relationships |
| `Article.collection()` | collection document (strict array `data`) |
| `typeof Article.Type` | the decoded TypeScript type |

**Undeclared body members.** A write body's `attributes` or `relationships` member rejects every member it doesn't declare, whether it declares fields or none. That covers a member excluded from that write too (`create: false`, `update: false`, `paginated`), and a resource with no attributes or no relationships. It applies to `createPayload`, `updatePayload`, the flat `createInput` / `updateInput` and the atomic `add` / `update` operations. Within a member, each of the first 12 undeclared members is its own 400 error, with `detail` `Expected no excess property` and a `source.pointer` naming the member (`/data/attributes/isAdmin`, `/isAdmin` in a flat payload), and an own `__proto__` or `constructor` is rejected like any other name. If there are more, one further error at the member itself says how many (`detail` `9988 more undeclared members not listed`, `source.pointer` `/data/attributes`; a flat payload's has no `source`, since its member is the whole body). So however many keys a request sends, a member gets at most 13 error objects, 12 plus the summary; an atomic operation's 400 also carries one error for each other resource the operation could have matched. That bounds the number of error objects, not the bytes: each pointer echoes a key name the client sent, so a long name makes a longer error. An empty `{}` is accepted. A value that isn't an object (a string, a number, a boolean, an array, `null`) is a 400 `Expected object` at the member itself (`/data/attributes`). So a member the resource doesn't declare never reaches the handler. The members JSON:API allows around them are untouched: a document's `meta` / `jsonapi` / `links`, a resource object's `meta` / `links`, a relationship's `meta` / `links`, a resource identifier's `meta` and an operation's `meta`.

The check lives in the schemas, so it applies wherever they decode, not only over HTTP: a Standard Schema validator (`Schema.toStandardSchemaV1(Article.createInput)`), a remote function or RPC procedure that decodes the [flat inputs](#flat-command-style-payloads), and `Client.decodeInput` all fail on an undeclared member. Encoding through these schemas, which is what `Client` does with a write body, rejects an undeclared member the same way, before any request is sent. What a rejection reports:

- **One member per request.** `HttpApi` decodes a request body with `errors: "first"`, so it stops at the first member that fails: a body with undeclared members in both `attributes` and `relationships` gets errors for those in `attributes` only. Within that member, the undeclared members up to the cap are reported, and the summary for the rest, whatever `errors` says.
- **The cap is per resource.** `Resource.make(type, { …, maxUndeclaredMemberErrors: 50 })` sets how many undeclared members each of that resource's write body members reports at their own pointers: a positive integer, or `Infinity` to report every one with no summary (anything else throws). It defaults to `12`, `Resource.extend` inherits it (and takes the same option, validated under its own name), a `Resource.family` anchored on a base carries the base's, and `Article.maxUndeclaredMemberErrors` reads it back. It is fixed when the definition is made, so it applies to every write body member above, when decoding and when encoding (`Client`). There is no process-wide setting: to change it everywhere, pass it to each `Resource.make`.
- **A failing declared field first.** The undeclared members are checked once the member's declared fields have parsed. So when a declared field fails (a wrong type, a missing required attribute), only that field is reported, not the undeclared members beside it, even with `errors: "all"`.
- **`Schema.is` and `make` drop it.** For a member that declares fields, `Schema.is(Article.createInput)` answers `true` for a value with an undeclared member, and `Article.createInput.make(...)` strips one: both check the type side, where the struct drops the member before the check sees it. (A member that declares none keeps it there, so `Schema.is` answers `false` and `make` throws.) Validate untrusted input with a decode.

**Ignoring undeclared members instead.** JSON:API lets a server reject or ignore a member it doesn't recognise. `Resource.make(type, { …, undeclaredMembers: "ignore" })` drops undeclared attributes and relationships from every write body member above instead of answering 400, so the handler never sees them, including for a resource that declares no attributes or relationships. That suits rolling deploys and clients built against a newer schema. `"reject"` is the default; `Resource.extend` inherits the base's policy and takes the same option to change it, and a family anchored on a base carries it. A non-object member is still `Expected object`.

The schemas are still `Schema.Struct`s: `.fields` (`Object.keys(Article.createInput.fields)`) and the OpenAPI request bodies, which list each member's properties with `additionalProperties: false`, are unchanged. A struct you derive from one with `mapFields` (`Struct.pick`, `Struct.omit`, …) is a plain `Schema.Struct` again, which drops undeclared members.

Documents are not limited to one resource type — see [Heterogeneous endpoints](endpoints.md#heterogeneous-endpoints-search-feeds) for polymorphic collections.

## Mutually recursive resources

Relationship references are thunks, so the graph they describe may contain **cycles** — articles linking to their comments and each comment linking back to its article is ordinary JSON:API, and the runtime has always resolved it. What such a pair needs is an explicit **type annotation**: `Resource.make`'s return type is inferred, so without one each definition's type would depend on the other's and TypeScript refuses both (`TS7022`).

The annotation is the same escape Effect's recursive schemas use, and this is all of it — one `interface` per resource in the cycle, naming the relationship record. Hoist the attributes to a `const` so no attribute schema is restated, and give the value the interface of the same name:

```ts
import { Schema } from "effect";
import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi";

const articleAttributes = { title: Schema.NonEmptyString };
const commentAttributes = { body: Schema.NonEmptyString };

interface Article extends Resource.Resource<
  "articles",
  typeof articleAttributes,
  {
    readonly comments: Relationship.many<Comment>;
  }
> {}

interface Comment extends Resource.Resource<
  "comments",
  typeof commentAttributes,
  {
    readonly article: Relationship.one<Article>;
  }
> {}

const Article: Article = Resource.make("articles", {
  attributes: articleAttributes,
  relationships: { comments: Relationship.many(() => Comment) },
});

const Comment: Comment = Resource.make("comments", {
  attributes: commentAttributes,
  relationships: { article: Relationship.one(() => Article) },
});
```

The lowercase `Relationship.one` / `optional` / `many` / `paginated` **types** used in the annotation mirror the constructors of the same name, defaults included (`one` and `optional` default to not filterable, `paginated` to no declared `order`, exactly as the constructors do). A resource definition is invariant in its relationship record, so the annotation has to name the type the constructor produced; these are that type. A relationship that declares a `filter` or an `order` names it too, as the `const` tuple the constructor infers: `Relationship.one<Article, readonly ["eq", "in"]>`; a to-one storage `key` is the third parameter: `Relationship.one<Article, false, "articleId">`.

Self-references work the same way (`parent: Relationship.optional<Category>` on `Category`), and all four relationship kinds may take part in a cycle.

Everything derived from the definitions keeps working, and a cycle cannot make any of it infinite:

| Derived | Behaviour in a cycle |
| --- | --- |
| `Article.document()` | the `included` union is **one hop** wide — the targets of `Article`'s own linkable relationships, not the transitive closure |
| `?include=` paths | bounded by the derivation depth (2 by default, `includePaths(R, n)` at runtime), not by the graph |
| `createPayload` / `updatePayload` | unchanged on both sides — a required `one` across the cycle is still required |
| `Endpoint.get` / `list` / `Group.resource` | derive their paths and documents from the resource's own type tag |

## Custom id schemas

By default a resource's id is `Resource.Id(type)` — a `string` branded by resource type. Pass your own `id` schema (anything whose **encoded** side stays a `string`, so the wire is spec-compliant) to brand ids your way — e.g. an id shared across a hierarchy of types, or one decoded to a richer value:

```ts
const PersonId = Schema.String.pipe(Schema.brand("PersonId"));

const Person = Resource.make("people", {
  id: PersonId, // default = Resource.Id("people")
  attributes: { name: Schema.NonEmptyString },
});

Person.Id; // PersonId
// Person.identifier.Type      → { type: "people"; id: PersonId }
// Person.updatePayload.Type   → data.id is PersonId
// Document.DataDocument(Person).Type.data.id is PersonId
```

The injected id flows through `identifier`, `updatePayload`, `ref`, `createInput`/`updateInput` and the document schemas. Omit `id` and nothing changes — existing definitions keep the auto-branded id. `Resource.Identifier(type, id?)` accepts a custom id too, for standalone identifier schemas.

**Subtype ids via `extend`.** To make a subtype's id a _subtype_ of its base's id — a `PersonId` that _is an_ `AgentId` _is a_ `NodeId` — pass `inheritId: true` to [`extend`](#reusing--extending-resources). The child's id brands the base's id schema, so it accumulates the base's brand(s) and is assignable wherever the base id is expected (transitively through a chain); the reverse is rejected. Effect's brands are intersectional, so this is just brand accumulation:

```ts
const Account = Resource.make("accounts", { attributes: { email: Schema.NonEmptyString } });
const Manager = Resource.extend(Account, "managers", { inheritId: true });

const managerId = Manager.Id.make("1");
const asAccount: typeof Account.Id.Type = managerId; // ✓ a manager id IS an account id
// @ts-expect-error an account id is not a manager id
const asManager: typeof Manager.Id.Type = Account.Id.make("2");
```

`inheritId` defaults to `false` — by default an extended resource gets a fresh, independent brand.

## Member names on the wire

By default a member's name on the wire is its key. `memberNames` gives the wire a different spelling, so code keeps `createdAt` while clients see `created-at`:

```ts
const Article = Resource.make("articles", {
  attributes: { title: Schema.String, createdAt: Schema.String },
  relationships: { blogAuthor: Relationship.one(() => Person) },
  memberNames: "kebab", // or "snake", "camel", { createdAt: "created" }, (key) => …
});

// Wire: { "attributes": { "title": "…", "created-at": "…" },
//         "relationships": { "blog-author": { "data": … } } }
// Decoded: article.attributes.createdAt, article.relationships.blogAuthor
```

The wire names are used everywhere on the wire, and the keys everywhere decoded, so handlers never change:

| Surface | On the wire | Decoded |
| --- | --- | --- |
| Resource objects, create and update payloads, `createInput` / `updateInput`, atomic operations | `created-at` | `createdAt` |
| `fields[articles]=created-at`, `sort=-created-at`, `filter[created-at]=…`, `include=blog-author` | wire names | keys (`{ field: "createdAt" }`, `Filter.Ast` fields, include paths) |
| Relationship routes and `Handlers.links` | `/articles/1/relationships/blog-author` | — |
| Error `source.pointer` and vocabulary `meta` (`sortableFields`, …), OpenAPI | wire names | — |

The presets and a record are typed per key, so `typeof Article.Encoded` names `"created-at"`. A function's wire names are typed `string`. `Resource.make` refuses a wire name that is not a legal member name, `type` or `id`, two members sharing one, and a record naming a key the resource does not declare. `extend` keeps the base's names and takes its own `memberNames` for the members it declares, and `Resource.memberNames(Article)` reads back the renamed members. `Query.Sort(fields)` takes names rather than a resource, so it decodes them as given, and `Handlers.paginatedRelationship(type, id, name)` writes `name` into its links verbatim: give it the wire name.

## Update payloads: set / unset / leave unchanged

A PATCH must distinguish three intents per attribute. `updatePayload` models them with `Schema.optional` (`= optionalKey(UndefinedOr(...))`), so each attribute is genuinely tri-state:

| Wire / value   | Meaning           |
| -------------- | ----------------- |
| key **absent** | leave unchanged   |
| key = `null`†  | unset (clear)     |
| key = a value  | set to that value |

† `null` requires a nullable attribute (`Schema.NullOr(...)`). In-process — and over codec transports that preserve it, like RPC / remote functions — an explicit `undefined` is also accepted as "unset". Over a JSON HTTP body, JSON can't carry `undefined`, so `null` is the wire clear signal and an absent key means "leave unchanged".

```ts
const Person = Resource.make("people", {
  attributes: { name: Schema.NonEmptyString, bio: Schema.NullOr(Schema.String) },
});

// Person.updatePayload accepts, for `bio`: a string (set), null (clear), or omit (leave unchanged).
// Its type is `{ name?: string; bio?: string | null | undefined }` under `data.attributes`.
```

## Per-attribute annotations

Stamp metadata onto an attribute with Effect's `schema.annotate({ ... })`, and read it back per attribute with `Resource.attributeAnnotations` — handy for carrying, say, a database column name alongside the attribute schema:

```ts
const Person = Resource.make("people", {
  attributes: { bio: Schema.NullOr(Schema.String).annotate({ dbColumn: "biography" }) },
});

Resource.attributeAnnotations(Person).bio?.dbColumn; // "biography"
```

## Resource-level metadata & introspection

A resource definition is also the natural single source of truth for things _outside_ the HTTP layer — database columns, form descriptors, a sync engine's node definitions. Two accessors make deriving from one a supported thing to do.

**Metadata rides the resource.** A definition _is_ a `Schema.Struct` with its derived members assigned onto it, so Effect's own `resource.annotate({ ... })` rebuilds the schema and returns a plain struct with `type`, `document()`, `createPayload` and the rest gone — no longer a resource, and no longer a valid relationship target. `Resource.annotate` is the seam that keeps it one:

```ts
const TableName = "acme/table"; // namespace your keys

const Person = Resource.annotate(
  Resource.make("people", { attributes: { name: Schema.NonEmptyString } }),
  {
    [TableName]: "people",
  },
);

Person.type; // "people" — still a complete resource
Resource.annotations(Person)[TableName]; // "people"

// still a relationship target, resolved lazily and by identity:
const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString },
  relationships: { author: Relationship.one(() => Person) },
});
```

Annotations are inherited by `Resource.extend` (the child's own keys winning), and can be declared up front with `Resource.make`'s `annotations` option — the better spelling when other definitions already point at the resource, since like `Schema.annotate` this returns a _new_ definition rather than mutating the one given.

**Attribute shape is readable.** `Resource.attributeDescriptors` reports what the declaration already knows about each attribute, in declaration order, as plain data — no reaching into `resource.fields.attributes.ast`, no widening the definition through `unknown`, no running a decoder against sentinel values:

```ts
const Article = Resource.make("articles", {
  attributes: {
    title: Schema.NonEmptyString,
    summary: Resource.attribute(Schema.NullOr(Schema.String), { create: "optional" }),
    createdAt: Resource.readOnlyAttribute(Schema.DateFromString),
    draftBody: Resource.attribute(Schema.String, { resource: false, update: false }),
  },
});

Resource.attributeDescriptors(Article);
// [{ key: "title",     schema, resource: "required", create: "required", update: "optional",
//    clearable: false, nullable: false, readOnly: false, annotations },
//  { key: "summary",   …, create: "optional", nullable: true,  clearable: true },
//  { key: "createdAt", …, create: false, update: false, readOnly: true },
//  { key: "draftBody", …, resource: false }]  // input-only: declared, never on the resource object
```

**What belongs in an annotation, and what doesn't.** Annotations are for vocabulary JSON:API has no opinion about — a storage table or column name, a sync-engine node kind, an admin-UI label — so that foreign vocabulary stays out of this package. Metadata that _is_ JSON:API's business gets a declaration instead, because the package has to act on it: filterability is `Filter.able`, sortability is `Sort.able`, and a paginated relationship's [canonical order](#relationship-kinds) is `Relationship.paginated(ref, { order })` — without a stable order the pagination links that relationship advertises are unsound, which is a defect in the document itself. A storage column name, by contrast, has no wire representation at all: two servers that disagree about it serve byte-identical JSON:API documents. That is the test — if changing it changes nothing a client can observe, it is an annotation. The one exception is a to-one relationship's [storage `key`](#relationship-kinds): every derivation into storage needs it and would otherwise re-declare it beside the resource, where the two declarations could drift, so it is a first-class slot on `Relationship.one` / `optional` rather than an annotation.

## Read-only & per-attribute projections

By default every attribute is read-write: it appears in the resource object, the documents, and all four write projections (`createPayload` / `updatePayload` / `createInput` / `updateInput`). Some attributes need a different shape — server-set timestamps that are never client input, fields settable only at create time, optional or clearable values. `Resource.attribute(schema, options)` declares that shape per attribute, and `Resource.readOnlyAttribute(schema)` is the common shorthand for "server-set" (`{ create: false, update: false }`).

```ts
const Article = Resource.make("articles", {
  attributes: {
    title: Schema.NonEmptyString, // plain: read-write everywhere
    // server-set: on the resource + in documents, never a write input
    createdAt: Resource.readOnlyAttribute(Schema.Date),
    // settable only at create, never updatable
    slug: Resource.attribute(Schema.String, { update: false }),
    // optional at create, clearable (nullable) on update
    summary: Resource.attribute(Schema.NullOr(Schema.String), { create: "optional" }),
  },
});

// Article.Type.attributes                  → { title, createdAt, slug, summary }
// Article.createPayload … data.attributes  → { title, slug, summary? }   (no createdAt)
// Article.updatePayload … data.attributes  → { title?, summary? }        (no createdAt, no slug)
```

An optional create attribute (`create: "optional"`, or a bare `Schema.optionalKey(...)` attribute) projects as `Schema.optional`, exactly as every update attribute does: the key may be absent, or present with a value or an explicit `undefined`. So a caller that builds `{ summary: input.summary?.trim() || undefined }` type-checks against `createInput` and `updateInput` alike (also under `exactOptionalPropertyTypes`). On a JSON wire an explicit `undefined` and an absent key are the same thing — the attribute is not supplied.

The descriptor options (all optional; the defaults reproduce a plain `Schema` attribute):

| option | values | controls |
| --- | --- | --- |
| `resource` | `true` (default) · `"optional"` · `false` | presence in the resource object schema + documents |
| `create` | `"required"` (default) · `"optional"` · `false` | presence in `createPayload` / `createInput` |
| `update` | `"optional"` (default) · `false` | presence in `updatePayload` / `updateInput` (tri-state when present) |
| `clearable` | `boolean` (default: nullable?) | whether the update projection additionally accepts `null` to clear |

The descriptor rides on the attribute's schema value, so it flows through `attributeKeys`, `attributeAnnotations`, sparse `fields` and `include`, is carried through [`Resource.extend`](#reusing--extending-resources), and is respected by the [atomic operations](endpoints.md#atomic-operations) (`add` mirrors create, `update` mirrors update) — all consistently with the create/update payloads.

### Write-only (input-only) attributes

`resource: false` declares an attribute that is **accepted as input but never on the resource object** — an upload's binary, a password, a one-time token. It is absent from the resource `Struct`, the documents, `attributeKeys`, sparse `fields`, `filterable` and `sortable`, yet still projected into `createPayload` / `createInput` and `updatePayload` / `updateInput` per its `create` / `update` settings (and into the atomic `add` / `update` operations), so a write-only field stays declared in one place:

```ts
const FileSchema = Schema.Uint8Array; // or any `Schema.declare`d binary

const Upload = Resource.make("uploads", {
  attributes: {
    fileName: Schema.NonEmptyString,
    contentType: Schema.NonEmptyString,
    // create-only binary: in `createInput`, never on the resource object
    file: Resource.attribute(FileSchema, { resource: false, update: false }),
  },
});

// Upload.Type.attributes   → { fileName, contentType }              (no file)
// Upload.createInput.Type  → { fileName, contentType, file }
// Upload.updateInput.Type  → { id, fileName?, contentType? }        (no file — update: false)
Resource.attributeKeys(Upload); // ["fileName", "contentType"]
```

An input-only attribute must keep at least one write projection (`resource: false` with both `create: false` and `update: false` declares nothing) and cannot carry a `filter` / `sort` declaration (it is not on the resource object to filter or sort by); `Resource.make` throws on either, naming the attribute. `Resource.attributes(R)` returns the resource-object map, without input-only attributes; `Resource.declaredAttributes(R)` returns the map as declared, and that is what `Resource.extend` inherits — so a subtype of `Upload` accepts `file` at create too.

The common shapes are option presets for a single `attribute(...)` call, so you can name your own (`as const` keeps the literals `attribute` reads at the type level):

```ts
const computed = { create: false, update: false } as const;
const createOnly = { update: false } as const;
const defaulted = { create: "optional" } as const;
const optional = { resource: "optional", create: "optional" } as const;
const inputOnly = { resource: false, update: false } as const;

const Upload = Resource.make("uploads", {
  attributes: {
    checksum: Resource.attribute(Schema.String, computed),
    fileName: Resource.attribute(Schema.String, createOnly),
  },
});
```

## Flat (command-style) payloads

Alongside the JSON:API `{ data: { type, attributes } }` payloads, every resource exposes flat request schemas — the attributes alone, no envelope — for transports (RPC, remote functions) that carry a flat shape:

```ts
Person.createInput; // { name, bio }            — flat create attributes
Person.updateInput; // { id, name?, bio? }      — id plus the same tri-state attributes
```

They are closed like the enveloped payloads' members: decoding one, through any transport, fails on a key the resource doesn't declare for that write (see **Undeclared body members** under [Resources](#)).

These are also what the `payload` override on `Endpoint.create` / `Endpoint.update` takes, when the HTTP write contract itself is a flat command input rather than a JSON:API document — see [Overriding the write payload](endpoints.md#overriding-the-write-payload).

## Nullable primary `data`

`Document.DataDocument` is a **pure envelope**: its `data` member is exactly the schema you pass, so nullability is your compositional choice — not something the constructor decides for you. JSON:API only permits `data: null` for a single-resource request whose URL _might_ correspond to a resource but currently doesn't; fetch-existing / create / update always carry the resource (a missing one is a `404`, never `200 { data: null }`).

```ts
Document.DataDocument(Article); //                       data: Article
Document.DataDocument(Schema.NullOr(Article)); //        data: Article | null
Document.DataDocument(Article.nullable()); //            data: Option<Article>, ⇆ null on the wire
```

`Article.nullable()` is `Schema.OptionFromNullOr(Article)` — the spec-clean nullable codec (`None ⇆ null`). Avoid effect's _structural_ `Schema.Option` (`{ _tag, value }`): it serialises a non-conformant body, and `DataDocument` can't tell the two apart. `Article.document()` and `Endpoint.get` / `create` / `update` use the non-null form; `Endpoint.related` for a to-one relationship keeps the nullable form (`data: target | null`) for the empty-linkage case.

## Reusing & extending resources

When several resources share a set of attributes or relationships, define them once and reuse them. `Resource.attributes` / `Resource.relationships` extract a resource's field map and descriptor record so you can spread them into another definition:

```ts
const Profile = Resource.make("profiles", {
  attributes: { ...Resource.attributes(Person), bio: Schema.String },
});
```

`Resource.extend` does the same wholesale — a **subtype** that inherits the base's attributes _and_ relationships, adding (or overriding) its own. JSON:API has no native subtyping, so the result is a _distinct_ resource type: its own `type` tag and branded id, with payloads and documents derived afresh. `meta` is inherited unless overridden.

```ts
const Account = Resource.make("accounts", {
  attributes: { email: Schema.NonEmptyString, createdAt: Schema.DateFromString },
  relationships: { organisation: Relationship.one(() => Organisation) },
});

// `admins` inherits email, createdAt and organisation, adding `permissions`.
const Admin = Resource.extend(Account, "admins", {
  attributes: { permissions: Schema.Array(Schema.String) },
});

Resource.attributeKeys(Admin); // ["email", "createdAt", "permissions"]
```

`extend` accepts a custom `id` schema exactly as `Resource.make` does, for a consumer that keys its subtypes with its own brand catalogue (branding at the row-mapping seam via `AdminId.make(row.id)`). The subtype's id is then that schema and nothing else — no package brand is added — and it flows through `identifier`, `ref`, the payloads and the documents as usual. `id` and `inheritId: true` are contradictory, so passing both is a type error and throws at definition time.

```ts
const AdminId = Schema.String.pipe(Schema.brand("AdminId"));
const Admin = Resource.extend(Account, "admins", { id: AdminId });

Admin.Id.make("1"); // string & Brand<"AdminId">
Admin.ref("1"); // { type: "admins", id: string & Brand<"AdminId"> }
```

## Polymorphic families (heterogeneous supertypes)

`Resource.family` defines a **supertype** over a set of member resources — for a heterogeneous "any node" endpoint, a document whose `data` is the union of subtypes, or a relationship that targets "any member". A family **is** the discriminated union over its members (decoded by the `type` tag) _and_ a first-class resource-like value, so it can be used as primary `data`, as a compound `included` member, and as a **relationship target**.

```ts
const Node = Resource.make("nodes", { attributes: { name: Schema.NonEmptyString } });
const Person = Resource.extend(Node, "people", {
  inheritId: true,
  attributes: { firstName: Schema.String },
});
const Organisation = Resource.extend(Node, "organisations", {
  inheritId: true,
  attributes: { legalName: Schema.String },
});

// Base-anchored family: shared id brand / relationships / attributes come from Node.
const AnyNode = Resource.family(Node, [Person, Organisation]);

AnyNode.document(); // data: Person | Organisation, included spans members' targets
AnyNode.collection(); // data: Array<Person | Organisation>

// As a relationship target — linkage decodes for ANY member (keyed on the member
// `type`, never the family name):
const Edge = Resource.make("edges", {
  attributes: { weight: Schema.Finite },
  relationships: { to: Relationship.one(() => AnyNode) },
});
// Edge.to.data is { type: "people"; id } | { type: "organisations"; id }
```

Endpoints: `Endpoint.polymorphic(AnyNode, { include: true })` is the single-resource `GET /nodes/:id` (returning any member), `Endpoint.polymorphicCreate(AnyNode)` the `POST /nodes` that creates whichever member `data.type` names (a type outside the family is a 409), and `Endpoint.collection(AnyNode.members, …)` the `GET /nodes` collection; `Group.make(AnyNode, …)` hosts them.

An instance keeps one canonical URL, the one its `type` names. A `polymorphic` handler whose instance is of another member answers with `Handlers.redirect("/people/1")`, a `308 Permanent Redirect` with that `Location`, rather than the document; a client from `Client.make` follows it and decodes the member's document as the family endpoint's. List the base among the members (`Resource.family(Node, [Node, Person, Organisation])`) when it has instances of its own, which the family's address then serves directly.

Two forms:

- **Base-anchored** `Resource.family(Base, [A, B])` — **recommended**. The shared `Id` / `relationships` / attributes come from `Base`, so the shared id brand anchors "any member id" and dotted `?include=` paths _through_ the family are meaningful. Pair with members defined as `extend(Base, …, { inheritId: true })`.
- **Named** `Resource.family("media", [Article, Photo])` — no base; the shared id is a union of the members' ids and the shared relationships/attributes are the by-key intersection of the members'. Fully correct for data / `included` / linkage; include-_through_ and the shared id brand degrade to the intersection.

A family value has no `ref` / `createPayload` of its own: what is created through it is always one of its members, with that member's payload. `Resource.isFamily` distinguishes a family from a single resource or a plain union.

Sparse fieldsets key on the member types, never the family name: an endpoint declaring `fields` whose response can carry a family (`Edge`'s `to`, above) declares `fields[people]` and `fields[organisations]`, and its default document makes those members partial. `fields[nodes]`, the family name, is not declared, since no resource object the response carries has that type: like any undeclared type it is a 400 naming the parameter, and `query.fields` has no `nodes` key. A family nested in another stands for its own members in turn, and a real resource whose type is the family's name (`Node` here, when another relationship targets it directly) is still declared as itself.

## Metadata

`meta` is free-form by spec, so every `meta` member accepts arbitrary records by default. Tighten any of them by passing a schema:

```ts
// Resource-level meta (on every resource object)
const Article = Resource.make("articles", {
  attributes: { … },
  meta: Schema.Struct({ rank: Schema.Int })
})

// Document-level meta (per endpoint, e.g. pagination totals)
Endpoint.list(Article, { meta: Schema.Struct({ total: Schema.Int }) })

// Or on a document schema directly
Article.collection({ meta: Schema.Struct({ total: Schema.Int }) })
```

Relationship and resource-identifier `meta` currently accept free-form records (untyped).
