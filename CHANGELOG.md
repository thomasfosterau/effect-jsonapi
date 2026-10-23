# @thomasfosterau/effect-jsonapi

## 0.18.0

### Minor Changes

- 0138201: An atomic `add` operation carrying a client-generated id is refused with 403 Forbidden rather than having the id dropped (#464). `Atomic.AddOperation`'s resource object declares no `id`, so a `data.id` the client sent used to be dropped by the decode and the resource created under an id of the server's own. It is now rejected at `data/id`, when decoding and when encoding, as `Resource.createPayload` rejects one (#450), and `Middleware.SchemaErrorsLive` answers the whole request with a JSON:API 403 whose `source.pointer` is `/atomic:operations/N/data/id`, before the handler runs, so no operation is performed. `Endpoint.operations` takes a new `payload` option, as `Endpoint.create` does, so a request document whose `add` declares an `id` can accept client-generated ids.
- d16620a: Relationship endpoints can serve compound documents (#439), as JSON:API 1.1 allows: `GET /articles/1/relationships/comments?include=comments.author` answers the comment identifiers as `data` and the comments and their authors in `included`.
  
  - `Endpoint.getRelationship` takes an `include` option, shaped as the other read endpoints' is: `true`, `{ paths }`, `{ depth }` or a declared `Include.Surface`. The paths are the parent resource's, rooted at the relationship, so each one's first segment is the relationship's name. `include: true` legalises the parent's include paths that start with the relationship, to depth 2 from the parent. Any other path is a 400 naming the legal ones, and an allow-list or surface naming a path outside the relationship is a compile error (and throws at construction). A `paginated` relationship is never an include path of its parent, so its relationship endpoint has none to legalise. The success document gains an optional `included` admitting every resource the legal paths reach. Without `include` the endpoint is unchanged: still a 400 for `?include=`, and no `included` member.
  - `Document.LinkageDocument` takes an `included` option (and an `Included` type parameter, after `M`). With it, the document has an optional `included` member; without it, the document is unchanged.
  - `Handlers.linkage` takes `included` and `checkLinkage` options. The members are deduplicated among themselves but not against the identifiers, since an identifier is not a resource object, and full linkage is checked from the identifiers themselves (`Handlers.buildIncluded`'s seeding, #423). `onResource` shapes each member from its own value, not from the identifier that names it.
  - `Assemble.relationship`'s `included` now reaches the wire through such an endpoint instead of being dropped by its schema.
  - `Conformance`: the compound probe behind `spec/document/full-linkage`, `spec/document/no-duplicate-resources` and `spec/document/included-on-include` now asks a relationship endpoint declaring `include` for its own relationship (`?include=tags` on `/articles/1/relationships/tags`).
- 1f805d5: `Conformance` checks the client-generated id rules on an atomic `add` (#471). Where the api declares an operations endpoint, a type whose `writes` fixture opts in with `clientId` now also runs `spec/atomic/add-client-id` (with `supported: true`, an `add` under the id answers with its result carrying the resource under that id, a result with no `data`, or 204), `spec/atomic/add-conflict-id` (a second `add` under the same id answers 409) and `spec/atomic/add-client-id-unsupported` (with `supported: false`, an `add` under the id answers 403, and any `source.pointer` lies within the operation under `/atomic:operations`). Each request carries one `add`; whatever a wrong 2xx creates is recorded and handed to `cleanup`.
- 3c36a7a: Conformance: the rest of the write rules (#429). Three client-generated id rules, `spec/status/create-client-id` (201 or 204), `spec/status/create-conflict-id` (409 for a duplicate) and `spec/status/create-client-id-unsupported` (403), run for a type whose `writes[type]` fixture opts in with the new `clientId: { supported, id }` (`Conformance.ClientIdFixture`). The kit never makes up a client id. Three relationship mutation rules, `spec/relationships/update-replaces`, `add-appends` and `remove-deletes`, drive `PATCH` / `POST` / `DELETE` on `/relationships/…` against a created resource, link it to the related type's `ids` sample and read the linkage back through the relationship's `GET`. The `Conformance.gaps` entry is now "Relationship writes beyond the read-back" (#451).
- 9784342: `Conformance`'s `profile/filter/evaluation` rule now probes more of the filter profile's evaluation semantics (`docs/filter-grammar.md` §6). Each new group of trees is judged on the first field the server decides anything on, and a group with no field to probe is named in the outcome's note:
  
  - On an attribute that is NULL on some resources, `lt`, `lte` and `gt` join `ne` and `gte`. A server that sorts NULL below every value fails them (F-CMP-1, F-CMP-2, F-ORD-1).
  - On an attribute that is never NULL in the sample and has two or more values, the rule sends `lt`, `lte`, `gt` and `gte` at a pivot (the median of its values in F-ORD-1's order), so each one splits the sample. A server that orders numbers as text fails them. It also sends `isnull=true`, which F-ISNULL-4 says matches nothing.
  - On a to-one relationship whose linkage every resource shows, the value is the related id (F-EVAL-4, F-ORD-5). The rule sends `eq`, `ne` and `nin`, plus `isnull` both ways when the linkage is empty on some resources; relationships with empty linkage are tried first. It never sends an ordering operator to a relationship, and never filters on one that shows no linkage.
  - When the endpoint declares `fields[TYPE]`, the rule sends an `eq` filter with a sparse fieldset that leaves the filtered field out. The match set must not change (F-EVAL-6).
  
  A sample with no attribute that is sometimes NULL used to decide the empty groups alone; it now decides every group it has a field for. The `Conformance.gaps` entry is renamed "The filter profile's evaluation semantics, beyond what the sample shows". It now lists what the rule cannot or does not probe: exact string comparison and sub-millisecond precision beyond the values the sample holds, relationships without linkage, the corollaries F-CONS-2 to F-CONS-7, and the refusals F-ERR-4 and F-ERR-5.
- e0f51fe: `Conformance` gains `profile/filter/evaluation`, the first rule that executes the filter profile's evaluation semantics (`docs/filter-grammar.md` §6) against a server. On each collection endpoint that speaks the grammar (`filter: true`) and advertises `Filter.PROFILE_URI` on its media type, the kit fetches the collection unfiltered, following its `next` links so a paginated collection is compared whole. It builds filter trees over attributes the collection carries and evaluates each over every resource's JSON with its own internal §6.3 fold. It then compares that match set with the filtered collection's on `(type, id)`. A finding names the §6 rule, the tree, the URL that showed it, and every resource wrongly included or wrongly excluded, with the value the tree read on it.
  
  The trees are the ones that tell three-valued evaluation from two-valued, on an attribute that is NULL (or absent) on some resources of the sample and a JSON scalar of one type on others: `ne` and `gte` over NULL (F-CMP-1), `nin` (F-IN-2, F-IN-3), `isnull=false` and `isnull=true` (F-ISNULL-1, F-ISNULL-2), and `Or(eq, Not(eq))` (F-CONS-1). `And([])` and `Or([])` (F-AND-2) need no field. The comparison domain (F-ORD-1) is inferred from the JSON type the server answered, as §6.2 defines it. Nothing new is exported from `Filter`, and `Resource.filterable`'s shape is unchanged (§6.9 stands). A filter the server refuses with a 400 decides nothing, since the rejection rules judge refusals. A sample with no attribute that is sometimes NULL decides the empty groups only, and the rule's note says why. With nothing decided, the rule reports `Skipped`.
  
  The `Conformance.gaps` entry for the filter profile's evaluation semantics is narrowed to what the rule does not probe yet: `lt` / `lte` / `gt`, to-one relationship fields, a filter beside a sparse fieldset, and attributes the sample never shows NULL.
- fc58d73: `Conformance` gains two query-parameter rules, `spec/query/illegal-parameter-name` (`?foo!=1`, a base name that is not a legal member name) and `spec/query/unsupported-extension-parameter` (`?unsupported:param=1`, a parameter of an extension the server does not support). Each sends the first read endpoint the one parameter and expects `400 Bad Request` under JSON:API 1.1 §Implementation-Specific Query Parameters, guarding the 400 `Middleware.checkQueryParameters` gives both since #263 (#425).
- ee48f73: Conformance: three more relationship write rules (#451). `spec/relationships/write-response` judges what a `PATCH` / `POST` / `DELETE` on `/relationships/…` answers: 202, 204 with no body, or 200 whose linkage is the relationship as it now stands (read back through its `GET`, or, with none, as the write leaves it) or that carries top-level `meta` alone. `spec/relationships/update-to-one-null` clears a to-one relationship whose payload admits `null` with `{ "data": null }` and wants it to read back as `null`. `spec/relationships/absent-related-404` links `absentId` under the related type through each `PATCH` and `POST` and wants a 404. Discovery records whether a relationship write's payload admits `null`. The `Conformance.gaps` entry narrows to "A relationship removal naming a resource that does not exist".
- 2076640: `Conformance` adds `spec/relationships/remove-absent-succeeds` and `spec/atomic/remove-absent-succeeds`: a relationship `DELETE`, or an atomic `remove` on a to-many relationship, naming a resource that does not exist must succeed, because that resource is already missing from the relationship (JSON:API 1.1 §Updating To-Many Relationships). A `403` decides nothing; a `404` or any other error is a finding. `Conformance.gaps` no longer lists the relationship removal naming an absent resource.
- 6439ad6: `Conformance` checks the rest of the profile's sort order (`docs/filter-grammar.md` §10) with three new profile rules: `profile/sort/multi-field` (S-MULTI-1: `?sort=a,-b` and `?sort=-a,b` order lexicographically, each term in its own direction), `profile/sort/id-tiebreak` (S-TIE-1, a SHOULD: resources that tie on `f` are listed in the same relative order under `?sort=f` and `?sort=-f`) and `profile/sort/across-pages` (S-PAGE-1: walking `next` through `?sort=f`, every resource on a page follows every resource on the page before it). Each is read-only and fixture-free, like `profile/sort/ordering`.
- 143ad4c: `Endpoint.create` answers a client-generated id with 403 Forbidden rather than dropping it (#450). `Resource.createPayload`'s resource object declares no `id`, so a `data.id` the client sent used to be dropped by the decode and the resource created under an id of the server's own, answered 201. It is now rejected at `/data/id`, when decoding and when encoding, and `Middleware.SchemaErrorsLive` answers it with a JSON:API 403 whose `source.pointer` is `/data/id`, before the handler runs (JSON:API 1.1 §Client-Generated IDs). A `type` or member that fails beside the id keeps its 409 or 400. A create that should accept client ids passes a `payload` whose resource object declares an `id`.
- 6a3776d: Export a decoded-type alias next to each exported schema constant (`export type X = typeof X.Type`): `Document.AnyMeta`, `Url`, `LinkObject`, `ResourceLinks`, `RelationshipLinks`, `RelationshipLinksOpen`, `PaginatedRelationshipLinks`, `TopLevelLinks`, `JsonApiObject`, `ErrorSource` and `ErrorObject`; `Endpoint.FlatGetQuery`; `FlatQuery.PageOffset` and `Uuid`.
  
  `Conformance.ContractViolation` is now a `Schema.TaggedError` (it was a `Data.TaggedError`): same tag, fields and `message`, and its fields now have a schema. `Idempotency.fingerprint` still dies if WebCrypto rejects SHA-256, but now does so explicitly. The `Client` docs no longer recommend `Effect.catchTag("ErrorResponse", …)`, which does not type-check against the generated client's static error type. Use `Client.isErrorResponse` instead.
- ab1c576: `Conformance`: `profile/filter/spelling-equivalence` spells its filters on the first string attribute a resource carries rather than skipping when the first attribute is not a string, and escapes the literal per the grammar's §2.3. `profile/filter/evaluation` now also probes the §6.5 corollaries F-CONS-2 to F-CONS-7 — De Morgan both ways, `Not(In)`, double negation, one canonical form in a second spelling, `included` beside a filter, and a filtered response's shape (each answered resource as served unfiltered, an empty result a 200 collection document) — and the coverage gap no longer lists them as unprobed (#458).
- e14ccda: The two published functions that took an `unknown` parameter now have signatures that satisfy `effect/no-unknown-parameters` (#436), and the lint rule is back at `error`:
  
  - **`Client.decodeErrorDocument(body: unknown)` becomes `Client.decodeErrorDocument(body: string | Schema.Json | Client.ErrorDocument)`.** It takes the raw body text, an already-parsed JSON value, or the `ErrorDocument` a façade already holds (what `ApiError.toDocument` renders). Its behaviour is unchanged: anything that is not a conformant error document, including a value outside the declared type, is still `Option.none()` and never a throw.
  - **`ServerErrors.fromTaggedError: (error: unknown) => …` becomes `(cause: unknown) => …`.** Only the parameter's name changes, to the one the rule reserves for an error cause, which is what the function classifies. Its type and behaviour are unchanged, and no call site needs a change.
  
  **Migration.** Calls to `decodeErrorDocument` compile as before when they pass a string, a `JSON.parse` result (`any`), a value typed `Schema.Json` (which is what an `HttpClientResponse`'s `json` gives), or `ApiError.toDocument(…)`. A call that passes a value typed `unknown`, such as a body read back from storage, no longer compiles. Pass its text instead, or decode it first, for example with `Schema.decodeUnknownOption(Schema.Json)`. Nothing changes at runtime, so a value outside the declared type is still safe to pass from JavaScript.
- e9fed55: `Endpoint.getRelationship`'s `include` now works on a `paginated` relationship (#483). Its linkage is the endpoint's primary data, so the relationship's own name and the paths rooted at it (`comments`, `comments.author`) are legal there, derived as for a `many` under `include: true`, `{ depth }` and `{ paths }`, and the `included` union and the `fields[TYPE]` types follow. This makes the spec's example `GET /articles/1/relationships/comments?include=comments.author` work when `comments` is paginated. Before, the parameter accepted no path at all. The same applies to `relationshipInclude` on `Endpoint.resource` / `Group.resource`. Full linkage is checked from the identifiers, so `included` holds the resources on the page being answered, not the whole relationship. The new `Endpoint.RelationshipIncludeBase` type names the resource the paths are derived over. A paginated relationship is still never an include path of its parent's own read, and a declared `Include.Surface` still cannot name one.
- bc55ded: Sparse fieldsets treat relationships as fields, as JSON:API 1.1 does (#494). A resource's attributes and relationships are its "fields" together, so `?fields[articles]=title,author` is now legal: `Query.Fieldset`, the nested `fields` member and the flat `fields[TYPE]` parameters of `Query.schema` accept relationship names as well as attribute names, on every endpoint that declares `fields`, `relationshipFields` included. `Resource.RelationshipKeys` / `Resource.relationshipKeys` and `Resource.FieldKeys` / `Resource.fieldKeys` name that vocabulary.
  
  `Handlers.project` now drops every relationship the set does not name, whole (its `links` and `meta` with its `data`), and omits a `relationships` member left empty, so an empty `?fields[TYPE]=` drops them all. `Handlers.Projected` types the result. The default document of an endpoint declaring `fields` makes each relationship optional, as it already made each attribute optional, so a client reads `doc.data.relationships?.author?.data` where it read `doc.data.relationships?.author.data`.
  
  Dropping a relationship can unlink the `included` members it reached (`?include=author&fields[articles]=title`). The spec exempts that case from full linkage ("when relationship fields that would otherwise contain linkage data are excluded due to sparse fieldsets", §Compound Documents), and so do all four checks now:
  
  - the document builders (`Handlers.data`, `collection`, `linkage`, `buildIncluded`) follow the linkage of every relationship a `Handlers.project` transform excluded, as the resource carried it before the transform. The transform carries its fieldset, through `Handlers.compose` too. A relationship a transform drops for any other reason is not exempt;
  - `Middleware.SchemaErrorsLive` reads `fields[TYPE]` from the request and reports no member once its walk reaches a resource of a type the request names a fieldset for;
  - the conformance kit's `spec/document/full-linkage` does the same with the probe's `fields[TYPE]`;
  - `Assemble.relationship` now checks full linkage from its identifiers, as `Handlers.linkage` does, and throws on an `included` member they do not reach (#498). It used to deduplicate `included` without checking it.
  
  The kit's `spec/query/sparse-fieldsets-primary`, `-included` and `-empty` rules judge `relationships` as well as `attributes`.
- 8a10616: **`Assemble.relationship` no longer puts the parent resource in `included`.** A relationship document's primary data is the related resources' identifiers, so the parent was reachable only if an included child linked back to it, and the document failed full linkage (#444). Through `Endpoint.getRelationship` encoding already stripped `included`, so the parent never reached the client; a custom schema that declared `included` got a 500 from the post-encode linkage check. `included` now carries only the resources passed as `included` (deduplicated), and is `[]` when none are. `RelationshipDocument<R, I>['included']` is typed `ReadonlyArray<WireResource<I>>` accordingly. A client that needs the post-mutation parent fetches it.
- aefce9e: Sparse fieldsets for compound relationship documents (#485): `GET /articles/1/relationships/comments?include=comments.author&fields[people]=name` narrows the `included` authors.
  
  - `Endpoint.getRelationship` takes a `fields` option, as the other read endpoints do. Beside `include`, it declares `fields[TYPE]` for every type a legal include path reaches (`Endpoint.RelationshipFieldsetTypes`), in the query's flat (wire) and nested records alike, and makes the document's `included` members of those types admit any subset of their attributes. The primary data is resource identifiers, which have no fields, so `fields[<target type>]` narrows only the `included` members of that type, and the parent's own type is not declared unless a path reaches it (`fields[articles]` on `/articles/1/relationships/comments` is a 400). Without `include` no type is declared.
  - `Query.schema`'s `fields` option also takes an allow-list of wire types (`fields: ["comments", "people"]`), declaring `fields[TYPE]` for those of the derived set alone; a listed type outside it throws. `Query.FieldsetTypesOf` names the declared types.
  - `Assemble.relationship` takes `fields`, applied to the `included` members only. `Handlers.linkage` already applied `onResource: Handlers.project(query.fields)` to them, leaving the identifiers alone.
  - `Conformance`: `spec/query/sparse-fieldsets-included` now judges a relationship endpoint declaring `include` and `fields`, asking it for its own relationship (`?include=tags&fields[tags]=name`).
- b0113b4: `Endpoint.resource` and `Group.resource` take a `relationshipFields` option that turns on sparse fieldsets (`Endpoint.getRelationship`'s `fields`, #485) on the relationship endpoints they generate (#489). It sits beside `relationshipInclude` and follows its shape: a top-level `true` applies to every generated `getRelationship`, and a relationship's own `relationships: { name: { relationshipFields } }` overrides it. Each such endpoint declares `fields[TYPE]` for the types its include paths reach, and its success document's `included` members admit any subset of their attributes, so its handler can answer with `onResource: Handlers.project(query.fields)`. Off by default, independent of the top-level `fields`, and a no-op where `relationshipInclude` is off.
- db46cc8: `Endpoint.resource` and `Group.resource` take a `relationshipInclude` option that turns on compound relationship documents (`Endpoint.getRelationship`'s `include`, #439) on the relationship endpoints they generate (#484). The top-level option (`true` or `{ depth }`) applies to every generated `getRelationship`; a relationship's own `relationships: { name: { relationshipInclude } }` overrides it and also takes a `{ paths }` allow-list or a declared `Include.Surface`. The generated endpoint's success document then admits `included`, so its handler can return `Handlers.linkage(ids, { included })`. Off by default: without the option nothing changes. A `paginated` relationship has no include paths, so a resource-wide setting legalises none there.

### Patch Changes

- 2d5bfc8: `ApiError.make` now leaves an optional field that an error instance doesn't carry out of the wire document's `meta` (#474). It used to write it as `undefined`, which is not JSON, so encoding the error failed and a client got a schema error instead of the declared error. For example, `fields: { id: Schema.String, pointer: Schema.optionalKey(Schema.String) }` constructed without `pointer`. Decoding already treated a missing `meta` member as absent, so such an error now round-trips.
- f8bdb34: The empty-object defaults of the published generics are spelled `Record<never, never>` instead of `{}` (#436), so the `effect/avoid-object-type` lint rule is back at `error`. `Record<never, never>` is the same type as `{}`: it has no keys, `keyof` it is `never` and it is the identity of an intersection, so every resolved type stays as it was. What changes is the text of the published declarations, and so what a consumer's hover and declaration emit print:
  
  - `Resource.Resource<Type, Attributes, Rels extends Relationships = Record<never, never>, …>`
  - `Resource.Parameter<Type, Attributes, Rels extends Relationships = Record<never, never>, …>`
  - `Resource.make<Type, Attributes, const Rels extends Relationships = Record<never, never>, …>`
  - `Resource.extend<…, const ExtraAttributes extends Schema.Struct.Fields = Record<never, never>, const ExtraRels extends Relationships = Record<never, never>, …>`
  - `ApiError.make()<Tag, const Fields extends Schema.Struct.Fields = Record<never, never>>`, so an error declared without `fields` is an `ApiErrorClass<Self, Tag, Record<never, never>>` (and `ApiError.Wire<Self, Tag, Record<never, never>>`), among them `ApiError.Forbidden`, `NotAcceptable`, `UnsupportedMediaType`, `Idempotency.KeyMismatch` and `KeyInProgress`
  - `FlatQuery.listInput<const Fields extends Schema.Struct.Fields = Record<never, never>>`
  - `Endpoint.resource<…, const Endpoints extends EndpointsOption<…> = Record<never, never>, …>` and `Group.resource<…>` likewise
  - the empty branches of `Query.NestedFields`, `Query.FlatFields` and `Query.FlatList`, and of `Handlers.DocumentValue` (`meta` / `jsonapi` absent), are `Record<never, never>` instead of `{}`
  
  No code needs to change: nothing resolves differently, and code that writes `{}` for one of these type arguments keeps compiling, since the two spellings are assignable both ways. Only the printed types change — `.d.ts` emit and hover text show `Record<never, never>` where they showed `{}` — so a snapshot or string comparison of printed types sees the new spelling. To match it (and pass `effect/avoid-object-type` in your own lint), write `Record<never, never>`.
- 8e2c755: `Conformance`: `spec/atomic/add-client-id-unsupported` now requires the 403 to an atomic `add` under an unsupported client-generated id to carry an error whose `source.pointer` is the operation's id, `/atomic:operations/N/data/id`. A 403 with no pointer fails the rule, as does one that names only the operation or `/data/id`.
- 50e6119: `Conformance`: `spec/status/create-client-id-unsupported` now requires the 403 to a create under an unsupported client-generated id to carry an error whose `source.pointer` is the resource object's id, `/data/id`, as `spec/atomic/add-client-id-unsupported` requires the operation's. A 403 with no pointer fails the rule, as does one that names only some other member.
- f13bdd1: `Conformance`'s three query-parameter-name rules — `spec/query/unknown-query-parameter`, `spec/query/illegal-parameter-name` and `spec/query/unsupported-extension-parameter` — are now decided the way the other refusal rules are. Each sends a baseline request first and probes the first read endpoint that answers it with 2xx, so an endpoint that is down no longer decides the rule. A 400 whose `source.parameter` names only other parameters fails, because it refused something else; a 400 naming no `source.parameter` still passes, now with a note. A probe answered 429 or 408, or not at all, leaves the rule skipped as not decided instead of failing it. Each rule now sends two requests, not one.
- 9eed8e2: The conformance kit's `spec/status/update-read-back`, `spec/atomic/lid-resolution` and `spec/atomic/all-or-nothing` rules now compare a write fixture's members as the JSON its request carried, so a fixture attribute whose JSON differs from its runtime value (a `Date`, sent as its ISO string) no longer reads back as a difference.
- 504e7e7: The conformance kit's `spec/document/no-duplicate-resources` rule no longer counts a relationship document's primary identifiers as resource objects, so a relationship document whose `included` carries the full resource for one of its identifiers is no longer reported as a duplicate. Two `included` members with the same `(type, id)` are still reported.
- 60f3657: `Handlers.project` reads an empty `?fields[TYPE]=` as "no fields", as JSON:API 1.1 §Sparse Fieldsets requires ("An empty value indicates that no fields should be returned"), and projects that type's `attributes` to `{}`. It used to read it as the absent parameter and return every attribute. `Handlers.Projected` types an empty literal set (`{ articles: [] }`) as no attributes. `relationships` is still kept under every set, so the full-linkage checks keep passing (#488). The conformance kit gains `spec/query/sparse-fieldsets-empty`, which checks that an empty `fields[TYPE]=` returns no attributes.
- 34b0cbf: The full-linkage walk now starts from the primary identifiers when a document's primary data is resource linkage (a relationship document), as JSON:API 1.1 §Compound Documents requires. `Handlers.buildIncluded` given a relationship document's identifiers as `primary`, the conformance kit's `spec/document/full-linkage` rule and the endpoint middleware's post-encode check no longer report an `included` member reachable only through a primary identifier, and `Handlers.buildIncluded` no longer drops an identified resource's `included` object as a duplicate of its identifier. `Handlers.data` and `Handlers.collection` are unchanged.

## 0.17.0

### Minor Changes

- ea337d9: **The errors a 400 reports for undeclared `attributes` / `relationships` members are capped, and the cap is a new `Resource.make` option, `maxUndeclaredMemberErrors`.** A write body member reports its first 12 undeclared members, each as its own error at its own `source.pointer` (`detail` `Expected no excess property`). If it has more, one further error at the member itself says how many (`detail` `9988 more undeclared members not listed`, or `1 more undeclared member not listed`; `source.pointer` `/data/attributes`). A flat `createInput` / `updateInput` body's summary has no `source`, since that member is the whole body. So a request with 10,000 undeclared keys in one member gets 13 error objects at the member; an atomic operation's 400 also carries one error for each other resource the operation could have matched. The cap bounds the number of error objects, not the bytes: each pointer echoes a key name the client sent.
  
  `Resource.make(type, { …, maxUndeclaredMemberErrors: 50 })` sets the cap for every write body member that resource derives: `createPayload`, `updatePayload`, `createInput`, `updateInput` and the atomic `add` / `update` operations. It applies when decoding a request and when encoding one (`Client`), and in a direct decode the summary is an issue with that message at the member's path. Pass a positive integer, or `Infinity` to report every undeclared member with no summary; anything else throws when the resource is defined. `Resource.extend` inherits the base's cap and takes the same option (a bad value throws naming `Resource.extend`), `Resource.annotate` keeps it, a `Resource.family` anchored on a base carries the base's, and `Article.maxUndeclaredMemberErrors` reads it back. A hand-rolled `Resource.Any` passed to `Atomic.AddOperation` / `Atomic.UpdateOperation` uses 12 when it carries no cap, and throws when it carries an invalid one. The cap is per resource; there is no process-wide setting.
- 4e5167b: **`Endpoint.CollectionIncluded` and the `included` type of an `Endpoint.collection` success document no longer admit a member's `paginated` relationship targets (#337).** The runtime schema never accepted them (a `paginated` relationship's target never appears in `included`), so a handler that returned one type-checked and then failed to encode with a 500. The type is now the members' non-`paginated` targets, as `Resource.DefaultIncluded` and `Resource.FamilyDefaultIncluded` already are, with or without `include` and `fields`. With `Article.history = Relationship.paginated(() => Revision)`, `Endpoint.collection([Article, Person], …)`'s `included` element type no longer includes `typeof Revision.Type`.
  
  The change is type-level only and removes only members no compliant response carries. It is a minor release because code that compiled against the released types can stop compiling: a handler returning such a target in `included` is now a compile error (it was a runtime 500), and a `switch` on an `included[].type` with a `case` for a dropped type is now TS2678. Delete that `case`.
- c7110e0: **The conformance kit now checks how a server processes atomic operations, judged by what it stored rather than by its answer alone (#164).** With `mutating: true` and a `writes` fixture, three rules that were declared and skipped now run against an `Endpoint.operations` endpoint, and the `Atomic operations processing` entry is gone from `Conformance.gaps`:
  
  - `spec/atomic/lid-resolution` `add`s a resource under a `lid` and names it by that `lid` in a later operation of the same request — as linkage in another fixture's `add`, when that fixture's payload links to the first one's type, and as the target of an `update` carrying the fixture's patch, when there is one — then reads back what the later operation should have changed, by the id the server gave it.
  - `spec/atomic/all-or-nothing` lists the type's collection, sends an `add` followed by a `remove` naming a `lid` no operation assigned, and lists it again. The request must be refused with an error document, and a resource that appeared in between with the fixture's attributes fails the rule — and is recorded in `Report.writes` and handed to `cleanup`. The failure mode is the absent `lid`, so the fixture supplies no invalid operation.
  - `spec/atomic/results-order` is new: an `add` then a `remove` of the same resource by `lid` must be answered with two result objects in that order, the created resource first and no data second. That resource is recorded as `deleted` when a read confirms the request's own `remove` removed it.
  
  `lid-resolution` needs a single-resource GET to read back through and `all-or-nothing` a collection GET to list; without one, each skips naming what is missing. The blog example passes all three.
- 74803b7: `Conformance` gains `profile/idempotency/advertises-profile-uri`, the first rule for the Idempotency-Key profile, a SHOULD citing `docs/idempotency.md` §1. Given a `writes` fixture and `mutating: true`, the kit sends one create to each create endpoint whose headers declare the header (`idempotency: true` or `"required"`), and one create plus one update (the `update` fixture) of what it made to each such update endpoint. A create endpoint is not probed on its own for a type an update endpoint covers; a type with several update endpoints (a `PATCH` and a `PUT`) gets a create and an update through each. A create and an update count as two requests whether or not the create is judged. Each 2xx must name `Idempotency.PROFILE_URI` in the top-level `jsonapi.profile` member or in the media type's `profile` parameter. Either place passes, and a media type naming it passes even with no body. A package-built endpoint passes when its handler answers with `jsonapi: Idempotency.jsonapi`. Without `mutating: true`, without a fixture, or with no endpoint declaring the header, the rule skips and says which. A write the server does not accept, or a 2xx with no document whose media type does not name the profile, decides nothing. Delete endpoints and the atomic operations endpoint are not checked.
  
  Every write rule now sends a fresh `Idempotency-Key` to an endpoint declared `idempotency: "required"`, which would otherwise refuse the write with a 400: the creates, updates and deletes through resource endpoints, and both atomic operations requests (`spec/atomic/response-ext-parameter`'s `add`, and the malformed document `spec/atomic/malformed-operations-rejected` sends, so that rule can no longer pass on the refusal of a write without a key). An endpoint where the key is optional gets none. The kit reads the header as required only from a headers struct whose own property for it is not optional, so an endpoint that requires it some other way (through a union, #393) is sent no key and may refuse the write for that alone. A request sent without a key, to an endpoint that declares the header, may be refused with an error document naming `source.header: idempotency-key`. `spec/status/delete-response` judges the answer itself, so it reports `Skipped` only for a `400` naming the header (the package's own missing-key `400`) and fails any other refusal, a `409` or `422` naming the header (the package's `KeyInProgress` and `KeyMismatch`) included. `spec/atomic/malformed-operations-rejected` judges only whether the server examined the document, which a refusal over the key does not show, so it reports `Skipped` for any 4xx naming the header rather than passing on it.
  
  The `The Idempotency-Key profile` coverage gap no longer calls this rule non-mutating and unwritten. It is narrowed to delete and atomic writes and to what a retried write does (replay, fingerprint mismatch, in-flight, key scope), which still needs byte-for-byte replay (#162, #165). The `Tier` and module descriptions now name the Idempotency-Key profile as part of the `profile` tier.
- a3de719: The conformance kit checks that a response to a request carrying `include` has a top-level `included` array, even an empty one (JSON:API 1.1 §Fetching Includes). The new rule, `spec/document/included-on-include`, reads the kit's compound-document probes and sends a bare `?include=` to every read endpoint that declares `include`, since a supplied but empty `include` must get `included: []`. It reports `Skipped` when no such request drew a 2xx.
- 8ecf6a7: `Conformance` gains two spec-tier MUST rules that follow a server's own links rather than only reading them (#168):
  
  - `spec/links/resource-self-dereferences` follows every resource object's `links.self` and requires the answer's primary data to be that resource, the same `type` and `id` (JSON:API 1.1 §Resource Links: "A server **MUST** respond to a `GET` request to the specified URL with a response that includes the resource as the primary data").
  - `spec/links/related-dereferences` follows every relationship's `links.related` and requires the answer to be the resources its linkage names: the same resource for to-one linkage, `null` for `null` linkage, the same set for to-many linkage — a subset either way when the related collection or the linkage carries `next` — and resource objects of any identity for a links-only relationship (§Fetching Resources: "A server **MUST** support fetching resource data for every URL provided as: … a `related` link as part of a relationship-level links object"; §Related Resource Links: "When fetched, the related resource object(s) are returned as the response's primary data").
  
  The links are collected from one `GET` of each read endpoint whose URL resolves. A link may be a string or a link object's `href`, and is resolved against the document that carries it. A link to another origin is never requested and is reported as not followed. A server error, a `429`, a lost response, a `401` or a `403` leaves a link not decided; any other non-2xx, a `404` included, is a finding. Each rule makes at most 200 requests per run and is `Skipped`, naming that budget, when it cannot follow every link — never a partial pass — unless a link it did follow broke the rule. The pagination walk and the link rules now share one link-following module.
  
  `Conformance.verify`'s in-process transport now answers a request the router itself fails — a path no route serves — as a deployed server does (the router's 404), instead of making the rule that sent it `Errored`.
  
  `Conformance.gaps` no longer lists "Link dereferenceability"; it lists the narrower "Relationship and top-level `self` links" (#309) instead.
- 8630812: `Conformance` gains `spec/pagination/links-enumerate-collection`, a spec-tier MUST that walks a collection's pagination links (JSON:API 1.1 §Pagination: "The following keys **MUST** be used for pagination links: `first`: the first page of data, `last`: the last page of data, `prev`: the previous page of data, `next`: the next page of data", and "Keys **MUST** either be omitted or have a `null` value to indicate that a particular link is unavailable"). For every list or related endpoint that declares `page[limit]` or `page[size]` and whose URL resolves, the kit fetches the collection with no page parameters (walking the server's own pages when it pages by default), then follows `next` from the first page at a page size that forces a different partition. It fails on a resource listed on two pages, one never reached or not in the collection, `prev` on the first page, a `next` that leads back to a page already visited, to a page listing no resources, to something that is not a page or is not a link, and on `first` or `last` answering different resources from the first or last page. It works off the links alone, so offset, page-number and cursor pagination are checked alike.
  
  The walk is bounded — 20 pages per walk, 200 requests per run of the rule, and a cyclic or non-advancing `next` ends it — and a walk that runs out of budget, or whose `next` leads to another origin (never followed), is reported `Skipped`, never as a pass. Without `sort`, JSON:API requires no stable order (§Sorting: the server "MAY apply default sorting rules"), so when a repeat or gap could come from the order shifting, the kit asks for the first pages again and, if their order changed, reports the collection not decided rather than failing it. The rule skips, saying why, when no endpoint declares a page size, a collection holds fewer than two resources, or the server answers everything on one page. A run now makes about six to ten more requests per paginated collection.
  
  `Conformance.gaps` no longer lists "Pagination link correctness".
- f5c44e3: `Conformance.Report.samples` records every `/:type/:id` read the `ids` samples resolve, as `{ type, id, url, status }`, and `Conformance.format` names the ones that answered non-2xx under `SAMPLES`. A sample the server does not hold still fails no rule and is not a gap; a fixture test can now assert on `report.samples` instead of matching a note's wording (#319). The kit sends no request of its own for this: a sample no selected rule read is left out.
- 5fcf179: A `Conformance` rule that dies no longer loses the whole report. In 0.16.3 a defect in any one rule (a transport that throws, or a bug in the kit) failed `Conformance.verify` / `verifyWith` outright, so every other rule's outcome — and, with this release's write fixture, the `Report.writes` ledger of what the kit created and whether it was removed — went unreported. The rule now gets a new `Errored` outcome (`Conformance.Outcome` gains a fourth member, `{ _tag: "Errored", rule, message, defect }`), every other rule still runs and is reported in the suite's order, and `Report.writes` is still filled. That holds whether the rule dies inside its Effect or throws before returning one. Interruption is not turned into an outcome: it still stops the run. A write fixture member that throws is not a defect, whatever it throws — even a value the kit cannot read at all, such as a revoked `Proxy`: a `create` or `update` that throws skips the rules it would have driven, and a `cleanup` that fails or throws is recorded in `Report.writes` as `cleanup-failed`. The skip reason and the `cleanup-failed` detail render the value as an `Errored` message does (below).
  
  **Behaviour change:** before, a dying rule failed the whole run; now the run succeeds with an `Errored` outcome, so a caller who gates on `summarise(report).failed`, `findings(report)` or `_tag === "Failed"` passes silently. If you gate on `failed`/`findings` rather than `Conformance.assert`, also check `summarise(report).errored === 0`.
  
  `format` prints such a rule first in its tier, marked `DIED` with the defect's message (an `Error` as `Name: message`, any other thrown value as itself; capped at 500 UTF-16 code units, a longer one ending in `…`; and `[unrenderable defect]` for a value the kit cannot read at all — a revoked `Proxy`, or one whose `getPrototypeOf` trap throws, or an `Error` whose `name` or `message` throws when read or cannot become a string (a Symbol, or an object whose `toString` throws) — which still leaves the run complete; any other value that throws when part of it is read renders with `Formatter.format`'s own marker for that part, such as `[toString threw]` for an object whose `toString` throws), and adds `· N died` to the tier and summary lines when one did (a run in which nothing died prints as before); `summarise` gains an `errored` count. `assert` dies on the first `Errored` outcome — with a defect tagged `RuleDied` (match it with `Predicate.isTagged(defect, "RuleDied")`) carrying the rule's id, a message naming the rule and the defect, and the original defect as its `cause` — before looking at failures, so the gate stays as strict as when the defect killed the run.
  
  A `switch` over `Outcome._tag` that relies on exhaustiveness needs an `Errored` case.
- 6579bd3: **`Conformance.Options.only` and `skip` match rule-id prefixes by path segment (#367).** An entry now matches the rule whose id it is and every rule whose id continues it with `/`, never one that merely continues the string: `skip: ["spec/status/create-location"]` leaves out that rule alone and keeps `spec/status/create-location-matches-self`, and `only: ["spec/status/create-location"]` runs it alone. A section matches with or without its trailing `/` (`"spec/links"` and `"spec/links/"` alike). **This narrows what some prefixes select:** a partial segment such as `"spec/content-neg"` or `"spec/content-negotiation/accept-weight"`, which used to match by plain string prefix, now matches nothing; name the section (`"spec/content-negotiation"`) or each rule id instead.
- 8f08eb2: `Conformance` gains four spec-tier rules on the link crawl (#309): two MUSTs and, as `related-dereferences` and `related-matches-linkage` split the `related` link, a SHOULD beside each. All four use the crawl the other link rules use: same-origin only, `GET` only, 200 requests per rule, and a server error, a `429`, a `408` or a lost response leaves the link not decided. Each SHOULD leaves a link its MUST fails (one that does not parse, answers a non-2xx or answers something the MUST rejects) not decided, naming that rule, so one broken link is never failed twice. `skip: ["spec/links/"]` leaves all four out with the rest.
  
  - `spec/links/relationship-self-dereferences` (MUST) follows every relationship's own `links.self` (JSON:API 1.1 §Fetching Relationships: "A server **MUST** support fetching relationship data for every relationship URL provided as a `self` link …", and "The primary data in the response document **MUST** match the appropriate value for resource linkage"). The answer must be resource linkage: `null`, a resource identifier object or an array of them. An identifier object carries a string `type` and a string `id`, and nothing but those, `lid` and `meta`, so full resource objects fail, and so does an identifier naming its resource by `lid` alone. An @-member and an extension member (`ns:member`: an alphanumeric namespace, one colon and a name) are not counted against an identifier; a name with a colon anywhere else (`:x`, `a:`, `a:b:c`) is. The cardinality must match the relationship's linkage: `null` or one identifier for to-one, an array for to-many. A links-only relationship shows no cardinality, so it is held only to answering linkage (#390). A non-2xx answer is a finding expecting "resource linkage" either way.
  - `spec/links/relationship-self-matches-linkage` (SHOULD, §Relationships: the relationship link "returns the linkage for the related resources as its primary data", with no keyword) follows the `self` of every relationship that carries linkage. The answer must name the same identifiers. As in `spec/links/related-matches-linkage`, the check relaxes to a subset when either side carries `next`, and nothing is decided when both do.
  - `spec/links/top-level-self-dereferences` (MUST) follows every document's top-level `links.self` (§Fetching Resources), relationship endpoints' documents included. The answer must be resource data: a resource object, an array of them or `null`.
  - `spec/links/top-level-self-matches-document` (SHOULD, §Document Top Level: `self` is "the link that generated the current response document", with no keyword) follows the same links. The answer must be a document of the same kind. A single resource must answer the same `type` and `id`, and `null` must answer `null`. A collection must answer a collection. It must hold the same resources, in any order, only when neither document carries `next` or `prev`, because a page can differ from the document it is compared with.
  
  `Conformance.gaps` no longer lists "Relationship and top-level `self` links".
- eb83353: **`Conformance.Options` gains `skip` and `requestTimeout`, two ways to bound a run against a live server (#302).** `skip` is a list of rule-id prefixes to leave out, the complement of `only` and matched the same way (a plain string prefix of the id): `skip: ["spec/pagination/links-enumerate-collection", "spec/links/"]` leaves out the pagination walk and the link crawl. It removes rules from what `tiers` and `only` select, so a rule both `only` and `skip` name is left out, and a rule it leaves out is absent from the report, as one `only` does not select is. `requestTimeout` takes any positive `Duration.Input` and bounds each request the kit sends — the client's whole `execute`, a `retry` it wraps itself in included, and the reading of the body — with each redirect hop a request of its own. A request still unanswered then is interrupted (over `fetch`, aborted) and reads as a lost response: status `0`, with a transport error naming the timeout, which every rule treats as any other transport error and never as a redirect the kit did not follow. **This changes the default for every run:** `requestTimeout` defaults to thirty seconds, for `verify` and `verifyWith` alike, so a run that sets nothing now reads a request unanswered after thirty seconds as a lost response where it used to wait for as long as the transport did. `requestTimeout: "Infinity"` (or `Duration.infinity`) turns it off and restores the old behaviour; a duration that is not positive (zero, negative, `NaN`), or one `Duration` cannot read (e.g. `"1e3 seconds"`), is a defect. `skip` is unset by default, leaving out nothing.
- fae1dc2: `Conformance` gains seven spec-tier rules that send an endpoint a parameter of a family JSON:API defines that the endpoint does not declare, so the kit now guards the 400 `Middleware.SchemaErrors` answers there. Each rests on JSON:API 1.1 §Implementation-Specific Query Parameters: "If a server encounters a query parameter that does not follow the naming conventions above, or the server does not know how to process it as a query parameter from this specification, it **MUST** return `400 Bad Request`."
  
  - `spec/query/fields-unsupported-endpoint` sends `fields[TYPE]` for a type the endpoint's response shows but its query does not declare (ignoring it would also break §Sparse Fieldsets' **MUST NOT**).
  - `spec/query/page-unsupported-endpoint` and `spec/query/filter-unsupported-endpoint` send `page[limit]` / `filter[…]` to an endpoint that declares neither family.
  - `spec/query/page-undeclared-member` and `spec/query/filter-undeclared-member` send a member derived from a declared one (`page[offset_x]`, `filter[status_x]`) to an endpoint that declares its members by name; an open `filter[…]` grammar is not probed.
  - `spec/query/include-bracketed` and `spec/query/sort-bracketed` send `include[]` / `sort[]` to an endpoint that supports the bare parameter.
  
  Each probes only an endpoint whose baseline request answered 2xx, never a name the endpoint declares, and sends at most 20 requests. A status other than 400, a server error included (a server that answers 5xx to a parameter it does not support mishandled it), or a 400 whose `source.parameter` names only other parameters, fails the rule; a probe answered by a rate limit (`429`), a request timeout (`408`) or nothing at all says nothing of whether the server refuses the parameter, and leaves it not decided. A server that silently ignored any of these parameters, and passed every rule before, now fails one.
  
  The two existing refusal rules, `spec/query/include-unsupported-endpoint` and `spec/query/sort-unsupported-endpoint`, now share that driver and its cap: each sends at most 20 requests, redirects included, and skips, naming the endpoints it left untried, where it used to try a baseline on every candidate endpoint until one answered 2xx. They settle a probe's answer as the seven do.
- 2a0128a: `Conformance` gains two spec-tier rules that probe `include` and `sort` on an endpoint that does not declare them, so the kit now guards the 400 the middleware answers there. `spec/query/include-unsupported-endpoint` sends `?include=` to a read endpoint whose query does not declare `include` (JSON:API 1.1 §Inclusion of Related Resources: "If an endpoint does not support the `include` parameter, it **MUST** respond with `400 Bad Request` to any requests that include it"). `spec/query/sort-unsupported-endpoint` sends `?sort=` to a list or related endpoint whose query does not declare `sort` and whose response is a resource collection (§Sorting: "If the server does not support sorting as specified in the query parameter `sort`, it **MUST** return `400 Bad Request`", a section that "applies to any endpoint that responds with a resource collection as primary data"). Each fails on any status other than 400, a server error included (a server that answers 5xx to a parameter it does not support mishandled it), and on a 400 whose `source.parameter` names only other parameters; a 400 with no `source.parameter` passes with a note. A probe answered by a rate limit (`429`), a request timeout (`408`) or nothing at all says nothing of whether the server refuses the parameter, and leaves the rule not decided. Each skips, saying why, when the api has no endpoint of that shape. A server that silently ignored either parameter, and passed every rule before, now fails one.
- 4acbf2c: `Conformance` gains a write-fixture contract, so the create / update / delete rules can actually run. `Conformance.Options.writes` takes a `Conformance.WriteFixture` per resource type — `create` (a payload the server accepts), `update` (a PATCH that must succeed) and `cleanup` (removes what the kit created; optional) — and, with `mutating: true`, the kit creates its own disposable targets from it, disposes of each however its rule ended (passed, failed or died), and lists every one in the new `Report.writes` (`Conformance.Write`), printed by `format` under `WRITES`. A type with no fixture skips its write rules naming the missing key.
  
  Rules that now run: `spec/status/create-location`, `spec/status/delete-response` and `spec/atomic/response-ext-parameter`, plus three new ones — `spec/status/create-response-document`, `spec/status/create-location-matches-self` and `spec/status/update-response`. `spec/status/create-location` is now a `SHOULD`, the level JSON:API v1.1 gives `Location` on a 201. `spec/status/delete-response` now deletes a resource the kit created rather than the `ids` sample it used to delete under `mutating: true`.
  
  Fixed: a probe's request body is now sent under the probe's own `Content-Type` (the JSON:API media type by default). It was sent as `application/json`, so `spec/content-negotiation/request-content-type-parameters` and `spec/atomic/malformed-operations-rejected` never sent the media type their report said they did.
  
  The `Write semantics` coverage gap is narrowed to what the fixture does not yet cover (#237).
- 1541ebe: Conformance: three more write rules, run with `mutating: true` and a `writes` fixture (#237). `spec/status/create-conflict-type` sends the fixture's payload under a `type` the endpoint does not serve and requires 409 Conflict; `spec/status/create-read-back` and `spec/status/update-read-back` read a created or updated resource back through its `GET /<type>/:id` and require the `attributes` and relationship linkage the write answered (or, for a 204 update, the request's own). `Endpoint.create` answers a foreign `type` with 400, so the first fails against apis built on it until #428 is fixed. The kit's id vetting is narrowed: a read only exempts an id from the "a read returned it" refusal while the kit held that id live, so a sighting of another holder's resource after the kit removed its own now counts. `Conformance.Write.type` is now the type the kit created (the `type` of its `create` payload), not the `writes` key — the same for any api on the conventional paths. The `Write semantics beyond the success responses` gap now tracks #429 (client-generated ids, the duplicate-id 409, relationship mutation).
- 8a29331: A `201` from `Endpoint.create` (and so from `Endpoint.resource` / `Group.resource`) now carries a `Location` header, as JSON:API v1.1 §Creating Resources → 201 Created recommends. The new `Middleware.CreatedLocation` middleware, which `Endpoint.create` attaches, copies it verbatim from the encoded document: the created resource's `data.links.self`, or, when that is missing, the document's top-level `links.self` (a link object contributes its `href`). So when the resource carries `links.self`, the two match by construction, as the spec requires. With neither link the header is omitted, and so is a link that is not a URI-reference (a space, a control character or a non-ASCII character in it). Only a `201` is touched. A create answering another `status` is left alone, and so is a response that already carries `Location`. A body that is not a JSON document, or is not settled bytes, passes through unchanged and never fails the request. The middleware sits inside `Idempotency.Middleware`, so a recorded `201` keeps its `Location` and a replay returns it. Handlers need no change. Give the created resource its own `links.self` (`Handlers.data({ ...resource, links: { self } }, { self })`) for the header to name it.
  
  `Middleware.layer`, `Middleware.layerWith` and `Middleware.layerHostNegotiated` provide the new `Middleware.CreatedLocationLive`, so an api built on them needs no change. Nor does one served through `Registry.layer` / `Registry.webHandler`, whatever `middleware` it passes: the router provides `Middleware.CreatedLocationLive` beneath that set (a `CreatedLocation` in the set wins), so a set of `Middleware.ContentNegotiationPassthrough` and `Middleware.schemaErrorsLayer(…)` still type-checks and still serves a create. The header is not declared on the endpoint, so the typed client does not surface it.
  
  **Breaking:** an api that wires its own middleware set without `Registry` (for example `Layer.mergeAll(Middleware.ContentNegotiationPassthrough, Middleware.schemaErrorsLayer(…))` provided to `HttpApiBuilder.layer`) and has a create endpoint (`Endpoint.create`, or the create that `Endpoint.resource`, `Group.resource` and `Group.flat` generate) no longer type-checks: the router's requirement gains `Middleware.CreatedLocation`, so assigning the layer to `Layer.Layer<never, never, HttpRouter.HttpRouter>` is a TS2322 (TS2375 under `exactOptionalPropertyTypes`) naming `CreatedLocation`, and serving it fails likewise. Add `Middleware.CreatedLocationLive` to that set: `Layer.mergeAll(Middleware.ContentNegotiationPassthrough, Middleware.schemaErrorsLayer(…), Middleware.CreatedLocationLive)`. An api with no create endpoint is unaffected.
- 56bf1b0: `Endpoint.create` and `Endpoint.update` now answer a resource object whose `data.type` names a type the endpoint does not serve with JSON:API's required **409 Conflict** (`code: "conflict"`, `source.pointer: "/data/type"`) instead of a 400 (§Creating Resources / §Updating Resources → 409 Conflict). `Middleware.SchemaErrorsLive` decides it from the request body when the payload's decode failure is at `/data/type`; a `type` that is missing or not a string, every other malformed member, flat command-input payloads and relationship endpoints keep their 400.
- 61b6635: **A project that compiles with `declaration: true` can export an endpoint, group or client value without annotating it (#348).** Before, `export const plain = Endpoint.get(Article)` stopped declaration emit with TS4023 on `QuerySchema`, `Wire` and `effect`'s `NodeInspectSymbol` (plus `ReachableIncluded` with `include`, and `SparseResource` / `SparseUnion` with `fields`), under both TypeScript 7 and 6. The bundled `dist/index.d.ts` declares each namespace's members at module level and exports them only through a namespace alias, which declaration emit does not follow, so a type in a namespace the consumer's file did not import could not be named. Error classes were then inlined structurally, down to `effect`'s internal `NodeInspectSymbol` key.
  
  - The package root now also exports, as types only, every type those inferred types mention that a consumer's file may not otherwise reach: `ApiErrorWire`, `BadRequest`, `Conflict`, `NotAcceptable`, `UnsupportedMediaType`, `AtomicOperations`, `AtomicResult`, `CollectionDocument`, `DataDocument`, `WireSchema`, `IncludedResources`, `ReachableIncluded`, `SparseResource`, `SparseUnion`, `IdempotencyHeaders`, `IdempotencyKeyInProgress`, `IdempotencyKeyMismatch`, `IdempotencyMiddleware`, `ContentNegotiation`, `CreatedLocation`, `SchemaErrors`, `BracketedKeys` and `QuerySchema`. Each is the same type as its namespaced name (`ApiError.Wire`, `Atomic.Operations`, `Middleware.ContentNegotiation`, …), which stays canonical. A name that would be ambiguous at the root carries its namespace as a prefix. These aliases are **type-only**: for runtime code, use the namespaced value (`ApiError.BadRequest`, `Middleware.ContentNegotiation`, `Document.CollectionDocument`, …). The root `CollectionDocument` and `DataDocument` are `Document.CollectionDocument` and `Document.DataDocument`, not the `Assemble` or `Client` document types. They exist for declaration emit only and are deprecated in this same release in favour of the module subpath exports (#385; see the module subpath exports entry).
  - `Endpoint` now exports `ReachableIncluded` and `MembersReachableIncluded`, which were module-local, and re-exports `IncludedResources`, `SparseResource` and `SparseUnion`.
  - Emitted declarations now name the middlewares (`import("@thomasfosterau/effect-jsonapi").ContentNegotiation`) where they used to inline them, so they are much smaller.
- e3fd1ee: **Breaking:** `Middleware.RequestPart` no longer includes `"Body"`; it is now `"Params" | "Headers" | "Query" | "Payload"`, the request-side kinds of HttpApi's `HttpApiSchemaError`. Inside HttpApi `"Body"` names a failure to encode the handler's _response_, not a part of the request, so it never belonged in a type named `RequestPart`. Migration: replace `"Body"` with `"Payload"` in calls to `Middleware.schemaError` and `Middleware.schemaErrorDocument` — the 400 document is the same (a body issue still gets a `source.pointer`), except that `schemaError`'s `detail` reads `Request payload failed validation` rather than `Request body failed validation`.
- 31078da: **`fields: true` declares `fields[TYPE]` for each member of a `Resource.family` the response can carry, in place of the family's name, and the default document makes those members partial (#350).** A family's `type` is its name, never a wire type: what a response carries for a relationship targeting the family are its members, each under its own type. Before, `fields: true` declared only `fields[<family name>]` (say `fields[nodes]`), which matches no resource object, so a client could not trim the members, and `fields[editors]` was a 400 as an undeclared type.
  
  Now `Query.FieldsetResources` replaces every family it reaches (the resource itself, a non-`paginated` direct target, or a resource a legal include path reaches) by its members, and a member that is itself a family by that family's members in turn. So:
  
  - `Query.schema(R, { fields: true })` and every read endpoint that declares `fields` (`get`, `list`, `related`, `collection`, `polymorphic`, and those `Endpoint.resource` / `Group.resource` generate) declare `fields[TYPE]` for each member type: the flat wire keys gain `fields[editors]` / `fields[reviewers]`, and the decoded `query.fields` gains `editors?` / `reviewers?`, each closed over that member's own attributes. A request naming one is accepted and handed to the handler, where `Handlers.project(query.fields)` applies it to the members in `included` (or in `data`, for a `related` endpoint whose target is a family). A family reached only through a `paginated` relationship declares nothing, as before.
  - **Breaking: `fields[<family name>]` is no longer declared.** It trimmed nothing, since no resource object has that type. The wire key and the `query.fields.<family name>` property are gone, so a client that sends `?fields[nodes]=…` now gets a 400 naming `fields[nodes]` in `source.parameter` (the #261 rule for an undeclared type), and code that reads `query.fields.nodes`, or passes `fields: { nodes: … }` through `HttpApiClient`, no longer compiles. A real resource whose type is the family's name, such as the base of a base-anchored family reached in its own right, is still declared as itself.
  - The default document of an endpoint declaring `fields` replaces a family in `data` or `included` with the union of its members (recursively), each with every attribute optional. A handler can answer with projected members with no cast, and a client reads the members' attributes as optional, where they were required before. Code that read a required member attribute out of such an endpoint's response now gets an optional one; pass `fields: false` (or a strict `success`) to keep the strict document.
  
  Endpoints without `fields` are unchanged.
- 712cda7: **Breaking (types): a read endpoint that declares `fields` binds a document whose resource attributes are optional by default, so `Handlers.project(query.fields)` fits it and `?fields[TYPE]=` can be answered as §Sparse Fieldsets requires.** Before, the default document required every attribute. A handler that projected a fieldset did not compile, and when forced it answered 500 (`ResponseEncodeError`) as soon as a client excluded a required attribute.
  
  The change applies to the primary data and to every `included` member of a type a `fields[TYPE]` can name, which is the set `Query.FieldsetResources` computes. Each attribute becomes an optional key, and one already optional stays as declared. `type`, `id`, `relationships`, `links` and `meta` are unchanged. It holds for `Endpoint.get`, `list`, `related`, `collection` and `polymorphic`, and for the `get`, `list` and related endpoints `Endpoint.resource` / `Group.resource` generate, which declare `fields` by default. `Endpoint.RelatedSuccess` takes a matching `Fields` parameter, which defaults to `false`.
  
  Clients see the change: an `HttpApiClient` for such an endpoint decodes those attributes as optional (`doc.data.attributes.title: string | undefined`). A handler that leaves out a required attribute now compiles and encodes, where it used to answer 500. To keep strict attributes, leave `fields` off (`fields: false`). A strict `success` override also works, but it replaces the whole default document. `Article.document()` (`Article.collection()` for `list`) equals the strict default only while `include` is off and the endpoint's `meta` is not overridden. With `include` on, which is the `Group.resource` default, its `included` admits only the resource's direct targets, and an endpoint `meta` option no longer applies. The override must then pass both itself: `Article.document({ included: Schema.Union([...]), meta })`, listing every type an include path reaches. #342 tracks a helper that builds the union. An endpoint without `fields` is unchanged, on the wire and in its types.
- fde4dca: **`fields: true` now declares a sparse fieldset for exactly the types the response can carry (#311).** In 0.16.x it declared the resource and every direct relationship target, `paginated` ones included, whatever `include` said. A `fields[TYPE]` for any other type was silently dropped and the request answered 200 with that type untrimmed. So on an endpoint with `include: true`, `GET /articles/1?include=comments.author&fields[people]=name` answered 200 but ignored `fields[people]`, because `people` is a target of `comments`, not of `articles`. JSON:API 1.1 §Sparse Fieldsets: "A client **MAY** request that an endpoint return only specific [fields] in the response on a per-type basis by including a `fields[TYPE]` query parameter." That request now decodes to `{ include: ["comments.author"], fields: { people: ["name"] } }`, and the handler can trim `people`.
  
  What each configuration declares:
  
  - `include` off (absent or `false`): the resource and its non-`paginated` direct relationship targets, the default `included` union, which a server MAY include by default.
  - `include: true`, `{ depth }` or `{ paths }`: the same, plus every resource on the way down each legal include path, its leaf included. That is two hops under `include: true`, the `depth` a `Query.IncludeOptions` names, or exactly the listed `paths`; `comments.author.employer` declares `comments`, `people` and `companies`.
  - A declared `Include.Surface`: exactly the resource and the types the surface's paths reach, which is its `included` union. A direct target the surface leaves out is not declared.
  
  On a heterogeneous endpoint, every member is declared, and each member walks every path, stopping at any of its own `paginated` relationships.
  
  **This narrows what 0.16.x accepted.** Two kinds of type that 0.16.x declared are now undeclared:
  
  - a target reachable only through a `paginated` relationship, which is never an include path and never in `included`;
  - under a declared `Include.Surface`, a direct target the surface leaves out.
  
  With this release's 400 for an undeclared `fields[TYPE]`, a request naming either is now a 400 naming the parameter in `source.parameter`, where 0.16.x decoded it and answered 200. Such a request was trimming a type the response cannot contain, so a client should stop sending it. A type no legal path reaches, such as one a hop past the deepest path, was never declared and is now that 400 too. A declared type with no attribute gets the empty-vocabulary 400.
  
  The decoded `fields` struct, the flat `fields[TYPE]` keys and `Query.FieldsetResources` all follow the same set. The decoded `fields` loses its keys for the dropped types. `Query.FieldsetResources` takes the endpoint's `include` option as a new, optional second type parameter (`Query.FieldsetResources<typeof Article, true>`). Without it, the type means `include` off, so it no longer lists `paginated`-only targets.
- 58b58c9: **`ResourceHandlers.make` evicts the cached entry when a write's re-read fails, and can answer a write hidden from its writer with the committed identifier instead of the failure.**
  
  A `create` / `update` commits, then re-reads the row as the writer before writing it through the cache. When that re-read failed (a write that hides the row from its own writer, such as a public row made private by a writer who can't read private rows), `cache.set` never ran and nothing evicted, so the cache kept serving the old public resource until it expired. Now any re-read failure evicts the entry, and the failure's cause propagates unchanged. The commit and the cache step are no longer separable by an interrupt: each write runs under `Effect.uninterruptibleMask`, with the operation and the re-read still interruptible, and once the operation has succeeded a later failure of `transact` (an interruption included) evicts too, since the write may have committed. `delete` gets the same treatment. A write the operation itself refuses never touches the cache.
  
  New, opt-in: `ResourceHandlers.make({ …, hiddenWrite: { type, when } })` names which re-read failures mean "hidden" (typically the operation's not-found error), and the handler answers those with an `Endpoint.CommittedDocument`, `{ data: { type, id, meta?: { version } }, jsonapi }`, at the endpoint's own status (`201` / `200`), instead of a 404 for a committed write that invites a duplicating retry. `Ops.create` / `Ops.update` may now answer `{ id, version? }` (`ResourceHandlers.WriteResult`), and `version` becomes `data.meta.version`. A defect or an interruption is never "hidden". The group declares the document with `Group.flat({ …, hiddenWrites: true })`, whose `create` / `update` success becomes `Endpoint.WriteDocument` (the full resource document or the identifier document); `get` is unchanged. Without either option nothing changes on the wire or in any type: the writes declare and answer the full document alone, and a typed client's success type is the same.
  
  Details of the hidden-write document and rule:
  
  - `Endpoint.CommittedDocument`'s resource object is **closed**: a member the identifier doesn't declare (`attributes`, `relationships`, `links`, …) is rejected, decoding and encoding alike, instead of being stripped. So under `Endpoint.WriteDocument` a full document that fails the resource's schema (an attribute it rejects) is still the 500 a response that fails to encode is, never a `201 { data: { type, id } }` with its attributes dropped, and a client decoding one gets a failure, not an identifier. `CommittedDocument` now takes any resource whose `identifier` is a struct (as `Resource.make`'s is), and the `WriteDocument` schema's second member is typed over that struct's fields.
  - `WriteResult.version` is `unknown`, so an operation that already answered a `version` of another type keeps compiling. A string or a finite number becomes `data.meta.version` as is, a `bigint` its decimal string; anything else is left out of `meta`.
  - A re-read cause is "hidden" only when it holds plain failures alone and `hiddenWrite.when` accepts every one of them.
  - Without a `transact`, each operation is its own autocommitted write: an interrupt landing after it commits but before it returns is seen as a write that never succeeded, and evicts nothing. Supply a `transact` where that window matters.
  - `Endpoint.CommittedDocument` is the schema and `ResourceHandlers.CommittedDocument` the value type it encodes, the same split as `Endpoint.ResourceDocument` and `Assemble.ResourceDocument`.
- ef312af: `Include.included` also takes a resource and an endpoint's `include` option, and returns the `included` union that endpoint's default document binds when it does not declare `fields` (#342): `Include.included(Article, { include: true })` is the `Schema.Union` over `Article`'s non-`paginated` direct targets and every resource a legal include path reaches, exactly what `Endpoint.get` / `list` over `Article` with `include: true` admit. A `Query.IncludeOptions` (`depth`, `paths`) bounds the walk as it bounds the endpoint's paths, `include: false` gives the direct targets, a declared `Include.Surface` gives the surface's own `included`, and a widened `include: boolean` gives what either value admits, as the endpoints do. Pass a `related` endpoint's target (a family target as the family itself) for its union. With `fields: true` the default document's `included` members admit any subset of their attributes, while the helper's stay strict: it is the union a strict `success` override declares.
  
  It also takes the members of a heterogeneous endpoint: the array of a `collection` endpoint's resources, or `family.members` for `polymorphic`, gives their default document's union. Under a widened `include: boolean` it gives what either value admits, as those endpoints do. Under a declared surface it returns the surface's own `included`, which is what `collection` and `polymorphic` bind under that surface, and an `include` that may or may not be a surface is typed as either union.
  
  An endpoint that overrides `success` with a wire variant can now declare `Document.DataDocument(WireArticle, { included: Include.included(Article, { include: true }) })` instead of listing every reachable type by hand, a list that drifted from the paths the endpoint advertises and failed to encode (500) on the path that reached a missing type. The result is typed as the new `Include.Reachable<R, I>` (`Include.MembersReachable<Members, I>` for the members form). Like the rest of `Include`, the helper is also exported from the schema-only entry point (`@thomasfosterau/effect-jsonapi/schema`), which still resolves `effect` alone.
  
  `Include.included(spec)` is unchanged.
- 7ef0bdc: **`Resource.ResolveIncludePath` now distributes over a union of resource definitions and walks each member's includable relationships only, so it no longer crosses one member's `paginated` relationship on a path that is legal for another member (#347).** `Resource.IncludedFor`, `Resource.FamilyIncluded` and `Client.narrowIncluded` follow. With `Post.author = Relationship.one(() => Person)` and `Draft.author = Relationship.paginated(() => Revision)`, `Resource.FamilyIncluded<typeof Entries, ["author"]>` is `typeof Person` where it was `typeof Person | typeof Revision`, and the same holds at any later hop. A `paginated` relationship's target never appears in `included`, so the dropped types are ones no compliant response carries. These are now the same types the endpoint documents and `fields: true` derive.
  
  The change is type-level only. It is a minor release because code that compiled against the released types can stop compiling, in these ways:
  
  - **Over a member union, every path segment now reaches each member's own includable targets, not only those of the keys every member shares.** Before, a segment resolved against the keys common to all members, so a literal key only some members declare reached nothing for the whole union: `Resource.FamilyIncluded<typeof Entries, ["author", "editor"]>` left out `editor`'s target, which the server does send. A wide or pattern segment changes the same way. With `Post` also declaring `editor` (to-one `editors`), over `typeof Post | typeof Draft` the types `Resource.ResolveIncludePath<…, string>`, `Resource.IncludedFor<…, ReadonlyArray<string>>` and ``Resource.ResolveIncludePath<…, `${string}.${string}`>`` were `people | revisions` and are now `editors | people`, and ``Resource.ResolveIncludePath<…, `edit${string}`>`` was `never` and is now `editors`. The narrowed union grows: an exhaustive `switch` on a narrowed `included[].type` (a `default` that assigns to `never`) no longer compiles until it handles the added type. This and the wide dotted path below are the breaks in code that was sound before.
  - **A path naming another member's `paginated` relationship no longer reaches its target**, as above. A `switch` on a narrowed `included[].type` with a `case` for a type that can no longer occur, such as `"revisions"`, is now a compile error (TS2678). Delete that `case`.
  - **On a single resource, a path naming a `paginated` relationship now resolves to `never`**, for every direct user of `Resource.ResolveIncludePath`, `Resource.IncludedFor` and `Resource.FamilyIncluded`, not only through `Client.narrowIncluded` (whose `include` argument already rejected such a path). `Resource.IncludedFor<typeof Draft, ["author"]>` was `typeof Revision` and is now `never`. Such a path is never a legal `include`, so no compliant response carries what it named.
  - **A wide dotted path now reaches the includable targets at every hop.** ``Resource.ResolveIncludePath<R, `${string}.${string}`>`` was `R`'s direct targets (a `paginated` one's included) and is now `R`'s includable direct targets and their includable direct targets: on a resource with `author` (to-one `people`), `remarks` (to-many `remarks`, which has a to-one `tags`) and a `paginated` `history` (`revisions`), it was `people | remarks | revisions` and is `people | remarks | tags`. An `any` path resolves the same way. The second-hop targets are reachable, so the union is now correct, but an exhaustive `switch` over it needs a `case` for each added type, and a `case` for a dropped `paginated` target is a compile error (TS2678).
  
  On a single resource, a `string` path keeps its meaning, minus `paginated` targets: `Resource.ResolveIncludePath<R, string>` and `Resource.IncludedFor<R, ReadonlyArray<string>>` are `R`'s includable direct targets. On a single resource, a pattern segment such as `` `auth${string}` `` reaches the includable targets of the keys it matches, as it did before for a non-`paginated` key. Over a member union both change, as the first bullet says.
  
  A note relative to the unreleased changes since 0.16.x: the `include` walk an endpoint uses for its `included` union (#320) and for `Query.FieldsetResources`' optional second type parameter (#311) now resolves its paths with `Resource.ResolveIncludePath`, so it follows the same rules. In particular, a `paths` allow-list with a wide segment past the first hop, such as ``ReadonlyArray<`${string}.${string}`>`` or ``ReadonlyArray<`remarks.${string}`>``, now admits the targets that segment reaches (`tags` above), where the walk as first merged admitted none. Both walks ship in this same release, so for a 0.16.x caller this is part of what those changes describe, not a further change.
- 8dec0b6: A malformed `Accept` weight no longer causes a 406 under `Middleware.layer` / `Middleware.negotiate` (#245). `Middleware.acceptIsAcceptable` now reads a `q` outside the RFC 9110 `qvalue` grammar (`q=`, `q=abc`, `q=2`, `q=-1`, `q=.5`, …) as the default weight `1`, as `Negotiation` already did, so the same `Accept` header gets the same verdict under either deployment shape. A JSON:API range whose only weight is malformed is now acceptable (200 rather than 406); a well-formed `q=0` is still a refusal.
- 8d2cc64: `Conformance`: `spec/links/relationship-self-dereferences` now holds a links-only relationship's `self` link (every `Relationship.paginated`) to the cardinality the relationship endpoint it resolves to declares. Discovery reads it off each `Endpoint.getRelationship` success schema — to-one when `data` encodes as an identifier or `null`, to-many when it encodes as an array — so a paginated to-many relationship whose relationship endpoint answers a single identifier now fails the rule, with the finding naming the declaring endpoint. A link to no declared relationship endpoint, or to one whose success schema shows no cardinality, still takes linkage of either kind.
- 6d22e51: **Every module is now published as a subpath export of its own (#385)**, as `effect` publishes `effect/Schema`: `@thomasfosterau/effect-jsonapi/Resource`, `…/Endpoint`, `…/Group`, `…/Client` and so on, one for each of the 24 namespaces the package root exports. A subpath is the same module as the root's namespace, not a copy, so its values (`Resource.make`, the `ApiError` classes, …) are identical whichever way they are imported, and the schema-tier subpaths (`Document`, `Filter`, `FlatQuery`, `Include`, `Relationship`, `Resource`, `Sort`) depend on `effect` alone, as `./schema` does. The root and `./schema` imports are unchanged.
  
  Each subpath ships its module's own declaration file, so declaration emit can always name a type through it. A project compiling with `declaration: true` can now export an endpoint, a group or a client built over resources **defined in another file** without an annotation, where before it failed with TS2883 (`cannot be named without a reference to 'Resource' from '…/dist/media-<hash>'`); the `satisfies Resource.Any` workaround is no longer needed.
  
  The 23 type-only aliases added at the package root for declaration emit in 0.17.0 (`QuerySchema`, `ContentNegotiation`, `ApiErrorWire`, `BadRequest`, `CollectionDocument`, …) are deprecated in favour of the subpaths: write `Query.QuerySchema`, or import it from `@thomasfosterau/effect-jsonapi/Query`. They are still exported. TypeScript's checker still prefers a direct root export when it names a type, so a consumer's own emitted `.d.ts` may reference them (`import("@thomasfosterau/effect-jsonapi").ContentNegotiation`); removing them later is therefore a breaking change for downstream published declarations.
  
  The layout of `dist/` changes with this: one JavaScript entry per export with shared code in hashed chunks, and one `.d.ts` per source module (the declarations are no longer bundled). Only the `exports` map is public; a deep import of a `dist/` file was never supported.
- a7b9759: `Negotiation.make` takes an opt-in `onExplicitRefusal: "notAcceptable"`: a read on an api path whose `Accept` refuses JSON:API with `q=0` and names no other media type with `q > 0` answers `406` with the new `Negotiation.NOT_ACCEPTABLE_REFUSED`, whose `detail` names the RFC 9110 §12.4.2 rule so it can be told apart from the §6.3.2 media-type-parameter 406. The default, `"fallthrough"`, keeps today's behaviour: the request falls through to the host's own representation.
- db880d3: `Handlers.paginatedRelationship` takes an optional fourth argument, `{ self }`, which controls the relationship's `self` link. Omitted (or `undefined`), `self` is `/<type>/<id>/relationships/<name>` as before, so existing callers see no change. A string is used verbatim as the `self` link. `false` omits `self`, for an API that declares no relationship endpoint for that relationship, so it no longer has to advertise a link that answers 404. The return type follows the option: with `self: false` the value's `links` has no `self` member, and with a `string | false` known only at runtime it is the union of both shapes. `related` is always written. Because of that, `ReturnType<typeof Handlers.paginatedRelationship>` is now a union of the two shapes, so code that reads `x.links.self` off a value typed by that `ReturnType` has to narrow it first (for example with `"self" in x.links`).
- 8e3efea: **Behaviour change:** a query parameter whose family base name is not a legal JSON:API member name (`?foo!=1`, `?page.limit=1`, `?[x]=1`, `?__proto__=1`), or that names an extension's parameter (`?ext:param=1` — a namespace, a colon and a-z), is now answered with **400 Bad Request** naming it in `source.parameter` instead of being ignored, unless the endpoint's `query` schema declares it or `allowedQueryParameters` lists it (#263). JSON:API 1.1 §Query Parameters requires the 400 for a parameter that "does not follow the naming conventions"; none of this package's extensions defines a query parameter. Bracketed families (`filter[x]`, `page[limit]`, `fields[articles]`) are judged by their base name and are unaffected, as are implementation-specific names — legal member names carrying a character outside a-z, such as `?fooBar=1`, `?x-trace=1` or `?utm_source=`.
  
  `allowedQueryParameters` now defaults to `["_"]`, so jQuery's cache-buster (`?_=<timestamp>`, from `$.ajax({ cache: false })`) keeps working. A list you pass replaces the default: a host that passes `["lang"]` must list `"_"` too to keep admitting it (`["_", "lang"]`), and `[]` answers `?_=` 400 as well. An entry may now also be an extension's parameter (`"ext:param"`) or another name that is not a legal member name (`"foo!"`); `Middleware.InvalidAllowedQueryParameter` is still thrown for an entry the check would never reject — now including a legal member name with a character outside a-z (`x-trace`), a percent-encoded spelling (`page%5Bsize%5D`) and an entry with an empty base name (`[x]`) — while an entry with surrounding whitespace (` lang`), which used to be refused, is now an illegal name the entry admits.
- f7178ab: **Behaviour change:** a query parameter whose family base name is made only of the letters a-z, and that neither the JSON:API specification defines (`include`, `fields`, `sort`, `page` and `filter`, each a 400 on an endpoint that does not declare it, as the separate entries on unsupported `include` / `sort` and `fields` / `page` / `filter` describe) nor the endpoint's `query` schema declares, is now answered with **400 Bad Request** instead of being ignored. JSON:API 1.1 §Query Parameters reserves those names for the specification and requires the 400. A request such as `GET /articles/1?unknown=1` or `?foo[bar]=1` that used to succeed now fails, with one error object per offending parameter naming it in `source.parameter` (`code: "bad_request"`, the shape every other query 400 has). Implementation-specific names — any carrying a character outside a-z, such as `?fooBar=1`, `?x-trace=1` or `?utm_source=…` — are still ignored.
  
  Lowercase parameters a client or host is likely to send that now answer 400 unless the endpoint's `query` schema declares them or the host allows them: search and locale parameters (`?q=`, `?search=`, `?lang=`, `?locale=`), non-JSON:API paging (`?limit=`, `?offset=`), formats and callbacks (`?format=`, `?callback=`), tokens and referrers (`?token=`, `?ref=`), cache-busters (`?t=`, `?v=`) and click identifiers appended by ad and analytics tools (`?fbclid=`, `?gclid=`). Anything carrying a capital, digit, `-`, `_` or `:` (`?utm_source=`, `?_=`, `?x-trace=`) is unaffected.
  
  The check runs in the `SchemaErrors` middleware every `Endpoint` constructor attaches, so it covers every endpoint, including those that declare no query schema, under `Middleware.layer`, `Middleware.layerWith`, `Middleware.layerHostNegotiated` and `Middleware.SchemaErrorsLive` alike. A host whose URL space carries its own lowercase parameters through to the api can list them by family base name — `Middleware.layerWith({ allowedQueryParameters: ["lang"] })`, or the new `Middleware.schemaErrorsLayer({ allowedQueryParameters })` beside `Middleware.ContentNegotiationPassthrough` — or rename them. Each entry must be such a base name: one that is not (`lang[region]`, `Lang`, ` lang`, `""`) throws the new `Middleware.InvalidAllowedQueryParameter` when the layer is built, and from `checkQueryParameters`, instead of admitting nothing. So does an entry naming one of the specification's families (`include`, `fields`, `sort`, `page`, `filter`), or a bracketed name of one (`page[size]`, `filter[status]`, `include[]`, `page[`), which the allow-list cannot admit, so a family the specification defines can never be silently ignored: its message says to remove the entry, and why. An endpoint supports a family, or a `fields`, `page` or `filter` member, by declaring it in its `query` schema; JSON:API defines only the bare `include` and `sort`, so a bracketed `include[…]` / `sort[…]` is a 400 unless a hand-built `query` schema declares that very name; and a name that only starts like a family's (`page[`, `page[size`, `filter[_]`) is no member of it. `Middleware.checkQueryParameters(names, { declared, allowedQueryParameters })` is the same rule standalone, for a framework hook that decodes requests itself.
- 63948d2: **Behaviour change: a client that sends extra fields, meaning `attributes` or `relationships` members a resource doesn't declare, now gets a 400 where it used to get a 2xx, on every resource. This is in the schemas, not only over HTTP: any direct decode of `createInput` or `updateInput` with an extra key now fails where it used to drop the key. That covers a Standard Schema validator (`Schema.toStandardSchemaV1(Article.createInput)`), a remote function or RPC procedure that decodes the flat inputs, and `Client.decodeInput`.** Before, a member that declares at least one field silently dropped the extras. A member that declares none rejects them already, as the Patch Changes entry on members that declare no fields describes (#281). Both now answer the same way.
  
  Within a member, each undeclared member up to a cap (`maxUndeclaredMemberErrors`, 12 by default, then one summary error at the member; see the Minor Changes entry on capping these errors, #308) is its own error: over HTTP a 400 error object with `detail` `Expected no excess property` and a `source.pointer` at that member (`/data/attributes/<name>`, `/atomic:operations/<n>/data/relationships/<name>`), and in a direct decode an issue with that message at that member's path. `HttpApi` decodes a request body with `errors: "first"`, so a 400 reports one member's extras, and a declared field that fails in the same member is reported in their place, even with `errors: "all"`. An own `__proto__` or `constructor` member is rejected like any other name. This applies to `createPayload`, `updatePayload`, the atomic `add` / `update` operations, and the flat `createInput` and `updateInput`, where the pointer is `/<name>`. `updateInput` was not covered before. It also covers a member excluded from that write (`create: false`, `update: false`, `paginated`). A client that sends a stale or read-only attribute, such as a server-set timestamp, now gets this 400 too. The members JSON:API allows around them are still accepted: a document's `meta`, `jsonapi` and `links`, a resource object's `meta` and `links`, a relationship's `meta` and `links`, a resource identifier's `meta`, and an operation's `meta`.
  
  Encoding through these schemas, which is what `Client` does with a write body, now fails the same way for a value with an undeclared member, before any request is sent.
  
  For a member that declares fields, `Schema.is(Article.createInput)` still answers `true` for a value with an extra key, and `Article.createInput.make(...)` still strips one: validate untrusted input with a decode. The schemas are still `Schema.Struct`s. `.fields`, including `createInput.fields`, and the inferred types are unchanged. The generated OpenAPI document is byte-identical: it already described each member with its properties and `additionalProperties: false`. A struct derived from one with `mapFields` is a plain `Schema.Struct` again, which drops undeclared members.
- 9c0f926: `?sort=` now has specified semantics (#167): `docs/filter-grammar.md` §10, a new section of the filter-grammar profile with stable rule ids (`S-SCOPE-*`, `S-KEY-*`, `S-ORD-*`, `S-MULTI-*`, `S-TIE-*`, `S-PAGE-*`). It reuses §6.2's comparison domain (F-ORD-1: a field's JSON value, code-point order for strings, no locale collation), puts NULLs (an absent attribute or `null`) last ascending and first descending, orders several fields lexicographically, and recommends (SHOULD) breaking remaining ties by `id`. It applies to every list and to-many related endpoint that supports `sort`. The profile URI stays `…/filter-grammar/v1`.
  
  `Conformance` gains a profile-tier rule, `profile/sort/ordering` (MUST), that checks it from the wire with no fixture. For each list or related endpoint declaring `sort`, it fetches the collection, picks the attributes whose values there can show an order (NULL-holding ones first), and holds `?sort=f` and `?sort=-f` to ascending and descending order, NULL placement included. An attribute the server refuses with a 400 is passed over. A collection that cannot show an order (fewer than two distinct values, or values of more than one JSON type) is `Skipped`, never passed. A pass notes when NULL placement went unobserved. At most 60 requests per run. `Conformance.gaps` no longer lists "Sort ordering correctness".
- 7941ec6: `Endpoint.collection` and `Endpoint.polymorphic` under a declared `Include.Surface` now derive their default success document's `included` union from the surface's own `included`, exactly as `Endpoint.get` / `list` / `related` do (#336), in its type and in the runtime schema. The paths the endpoint advertises and the resources its document admits now come from one declaration, so a surface with a depth-2 path such as `comments.author` can be answered: the `people` it brings in type-check and encode, where before they were rejected (a 500 on encode).
  
  This narrows the union: it admits exactly what the surface names, so a member's non-`paginated` direct target the surface leaves out (say `companies` behind `Person.employer` on a search over `[Article, Person]` whose surface only declares `comments.author`) is no longer admitted in `included`. A handler that returned such a resource must add it to the surface, or override `success`. With `fields: true`, each of the surface's members a fieldset names admits any subset of its attributes. `Include.included(members, { include: surface })` already returned the surface's union, and now matches what these endpoints bind; an `include` that may be a surface or not (`which ? surface : true`) is typed as either union.
- 3599870: `Assemble.unpaginatedCollection` takes an optional `meta`, the document's top-level metadata (a generation timestamp, a cache hint, an application-specific summary), and emits it as given. Without `meta` the document has no `meta` member. `Assemble.UnpaginatedCollectionOptions` and `Assemble.UnpaginatedCollectionDocument` gain a third type parameter, the type of the `meta` passed: no `meta` member when none was passed (the default), `meta` of that type when it was, and `meta` optional when the type admits `undefined`, so a caller can forward its own optional `meta` as is. The type is inferred `const`, as on `Handlers.collection`, so an object literal keeps its literal type; as there, a value typed by an `interface` with no index signature is rejected, so spread it (`{ ...stamp }`) or use a `type` alias. `meta.totalCount` is not special-cased: it is emitted verbatim, and with a `self` the document is then structurally assignable to `Assemble.CollectionDocument`. A collection whose total matters goes through `Assemble.collection`.
- 1277891: `Assemble.unpaginatedCollection` takes an optional `self` — the collection's absolute URL — and `query`, the request's canonical pairs (`Query.canonicalPairs(listQuery)(query)`). With `self`, the document carries `links: { self }`, with `query` appended and serialised the way `Assemble.collection`'s pagination links carry it; without `self` the document has no `links` member. The options are the new `Assemble.UnpaginatedCollectionOptions`, and `Assemble.UnpaginatedCollectionDocument` gains a second type parameter, the type of the `self` passed: no `links` member when none was passed (the default), `links.self` required for a `string`, and `links` optional for a `string | undefined`. `query` without `self` is a type error, and a `self` that is `undefined` at runtime drops the `query` along with the link. A `self` link is not page math: it adds no `meta`.
- 042a264: Add `Assemble.unpaginatedCollection(resources, options?)` and its `Assemble.UnpaginatedCollectionDocument` type, for a collection served whole — a small fixed list, or a to-many related collection that is never paged. It shares `Assemble.collection`'s capability stamping, sparse-fieldset projection, link coercion, batched `include` walk, pre-resolved `included` handling and `jsonapi` member, but emits no pagination `links` (and no `links` member at all unless a `self` is given) and no `meta` (unless the caller passes its own), so the document no longer advertises `meta.totalCount` or `first` / `last` / `prev` / `next` links the endpoint doesn't honour; the return type has no page math and no pagination links. `Assemble.collection`'s call shape, output and type are unchanged.
- fe78d53: **Behaviour change: a response that was served now answers 500.** `Middleware.SchemaErrorsLive` (and so `Middleware.layer`, `layerWith`, `layerHostNegotiated`, `Registry.layer` / `webHandler`) now checks full linkage on every 2xx document the endpoint _encoded_, with the same reachability walk the document builders and the conformance kit's `spec/document/full-linkage` rule make (#250). The builders check the value they build, but encoding through the endpoint's schema drops every relationship the resource does not declare, so an `included` member reached only through one — added by a cast, an `onResource` transform or an untyped data source — used to pass the builders and reach the client unreachable from the primary data. Such a response is now answered like one that fails to encode: a defect reported at `Error` severity (an `effect-jsonapi/ResponseEncodeError` whose message names the unreachable members) and the opaque JSON:API 500 of `ServerErrors.SERVER_ERROR`.
  
  A builder's per-call `checkLinkage: false` cannot reach this check, since the encoded document carries no trace of it. To serve unlinked members deliberately, turn the wire check off for the layer: `Middleware.schemaErrorsLayer({ checkLinkage: false })` or `Middleware.layerWith({ checkLinkage: false })` (new `Middleware.SchemaErrorsOptions`).

### Patch Changes

- 732ab13: `Accept` weights are now read with the RFC 9110 §12.4.2 `qvalue` grammar (`0` to `1`, at most three decimals) instead of `Number()`. A `q` outside it — `q=`, `q=0x0`, `q=-1`, `q=1e-9`, `q=2`, `q=1.0001`, a quoted `q="0.5"` — is now malformed, handled the way `q=abc` already was in `Negotiation`: it reads as the default weight `1` (so `q=` is no longer an explicit `q=0` refusal, and `q=2` no longer outranks every other range). `Middleware` reads a malformed weight the same way (see the `Accept` malformed-weight entry, #245). Well-formed weights, including `q=0`, `q=0.000` and `Q=0`, are unchanged.
- 7ff21e4: A 400 for a value rejected in a request body, header or path parameter now names, in `source`, the key the request sent when the schema renames it on the wire with `Schema.encodeKeys`. A body member `count` that `Schema.encodeKeys({ count: "itemCount" })` sends as `itemCount` is now reported as `source.pointer: "/itemCount"`, at any depth (`/data/itemCount` for a renamed struct under `data`); a header `trace` sent as `x-trace` as `source.header: "x-trace"`; and a path parameter `id` sent as `itemId` as `source.parameter: "itemId"`. Before, `source` named the decoded key, which the request does not carry (#316). The same holds when a check on the whole renamed struct (`Schema.makeFilter` returning `{ path: ["count"], issue }`) rejects the member. This is the counterpart of #305's fix for query parameters, uses the same mapping and has the same limits, and covers the `SchemaErrors` middleware and `Middleware.schemaErrorDocument` called with `"Payload"`, `"Body"`, `"Headers"` or `"Params"`. A schema that renames nothing answers exactly as before. To read a renamed struct's wire names, its transformation's decode runs on probe values once per schema, as #305 does for queries, so a decode with side effects has them run then.
- c5255d6: The link dereferencing rules (#168) are refined after review:
  
  - `spec/links/related-dereferences` (MUST) now holds a relationship's `related` link only to answering a 2xx with resource data — a resource object, an array of them or `null` — as JSON:API 1.1 §Fetching Resources requires: "A server **MUST** support fetching resource data for every URL provided as: … a `related` link as part of a relationship-level links object". Its `section` and `reference` are now §Fetching Resources.
  - The comparison with the linkage moves to a new rule, `spec/links/related-matches-linkage`, graded **SHOULD** because §Related Resource Links states it without a keyword: "When fetched, the related resource object(s) are returned as the response's primary data." It follows the `related` link of every relationship that carries linkage and leaves a link the MUST already fails (not a link, a non-2xx, no resource data) not decided rather than reporting it twice.
  - A resource or linkage item without a string `type` and `id` now leaves its link not decided, as an answer holding one already did. A `self` link on such a resource used to be skipped silently, and such an item in to-many linkage was left out of the comparison, which could report a resource the linkage did name as one it did not.
  - A rule lists its first ten findings and one more counting the rest, and quotes every resource label it names, cut to 200 UTF-16 code units.
  - A read endpoint the request budget left unsearched now makes the rule `Skipped`, naming the budget, as a link left unfollowed already did; it could pass.
  - A link whose scheme has no origin (`javascript:`) is named by its scheme, not as "another origin, null".
  
  Every `Conformance` probe, over either transport, now keeps a redirect off the transport: `verifyWith` provides `FetchHttpClient.RequestInit` with `redirect: "manual"` (keeping the rest of the run's `RequestInit`), so the transport cannot be led to another origin; which redirects the kit follows itself is described in this release's entry on following redirects within the base URL's origin ("`Conformance` now follows a redirect when, and only when, its `Location` stays on the base URL's origin"). An answer a transport fetched from another origin all the same is not read; it is recorded as a lost response. `Conformance.verify`'s in-process transport now answers only the router's `RouteNotFound` as a 404; any other router failure dies again, as before #168.
- 8e30db1: `spec/pagination/links-enumerate-collection` and the link dereferencing rules decide less on evidence they did not get:
  
  - A walk that would start on a page of items none of which has a string `type` and `id` (or `lid`) — the reference request or the second walk's first page — is not begun, and the collection is reported not decided. It used to go ahead and report MUST failures (a `first` link that "answers different resources", resources "never reached") against resources the kit never saw.
  - A `408 Request Timeout` mid-walk, from a `first` / `last` link, or from a link `spec/links/resource-self-dereferences` or `spec/links/related-dereferences` follows, now leaves the collection or link not decided, as a server error, a `429` or a lost response already did. It used to be a MUST failure.
- 864a2c4: `spec/pagination/links-enumerate-collection` no longer decides a collection on evidence it did not get:
  
  - When the rule's 200-request budget runs out before a `first` or `last` link is checked, the collection is reported not decided, naming the budget. It used to pass silently.
  - When the budget runs out before the order recheck, or the recheck gets no page back, the order-dependent findings (a repeat, a gap, a `first` / `last` page that disagrees) are withheld. They used to stand as if the order had been confirmed stable.
  - Order-dependent findings are now rechecked on every path out of the rule, including a walk cut short by an off-origin `next` or the budget.
  - A server error, a `429` or a lost response, whether mid-walk or from a `first` / `last` link, leaves the collection not decided, as it already did for the reference request. It is no longer a MUST failure that "`next` … leads to a response that is not a page". A `next` that leads to any other 4xx, or to a 2xx that is not a page, is still a finding.
  - A page whose `data` holds items, none of which has a string `type` and `id` (or `lid`), leaves the collection not decided. It used to be reported as a page that lists no resources.
- b573371: The filter-profile conformance rules' `reference` URLs now point at `docs/filter-grammar.md` on the `trunk` branch instead of the removed `main` branch.
- 1195e10: `Conformance`'s `spec/document/full-linkage` rule reports an orphaned `included` resource whose `type` or `id` is not a string as a finding. It rendered the pair with `String`, which throws on valid JSON such as `{"type":{"toString":1},"id":"2"}`, so the rule came out `Errored` instead of `Failed`. A string `type` or `id` still reads as itself; any other value now reads through `Formatter.format` (`{"toString":1}:2`). `spec/document/no-duplicate-resources` had the same fault: two copies of `{"type":"people","id":{"toString":1},"lid":"9"}` in `included` made it `Errored`; it now reports them as a finding. Both rules name a resource by the member the kit compares it on — its `id` when that is a string, else its `lid` — so a duplicate identified by `lid` reads `people:9` (it read `people:undefined`), and `{"type":"people","id":7,"lid":"8"}` reads `people:8`, not by the `id` the comparison ignored.
  
  `Conformance.format` keeps a value that spans lines inside its entry: a `WRITES` entry whose `cleanup-failed` detail has more than one line — an `Error("a\nb")` from `cleanup` — hangs the later lines under the entry instead of starting them at the margin; a finding whose detail has more than one line marks only the first with `·`; and an `expected:` or `observed:` value that spans lines — a server `type` of `"a\nb"`, say — hangs its later lines under the label instead of starting them at the label's column.
- 7944eaf: `Conformance` now follows a redirect when, and only when, its `Location` stays on the base URL's origin (scheme, host and port), in both transports. Previously every `3xx` answered a probe as itself. The kit checks each hop before requesting it, so, unless the client it is given follows redirects itself, it never sends a request to another origin on a server's say-so. It follows at most five hops for one request, each counting against a rule's request budget, and grades the final answer. A `301`, `302` or `303` is followed only for a `GET`; a `307` or `308` re-sends the same method and body. A `3xx` with no `Location`, or an empty one, answers as itself.
  
  A redirect the kit does not follow leaves the request with no answer to read: one to another origin, past the hop cap or the budget, one that would turn a write into a `GET`, or one whose `Location` does not parse. So does one a transport followed on its own (one wrapped in `HttpClient.followRedirects`, say) to another origin, or turning the method into a `GET`: the kit reads neither the answer nor the transport error it ended in, and names the URL the transport ended at. "Another origin" is judged against the request as the client sent it, after its own `HttpClient.mapRequest`: the kit runs each request through the client as its `execute` does, so a client that rewrites every request onto another origin (a `baseUrl` mapped onto a local port, say) is read as the server it sends to, follows a `Location` on that origin, absolute or not, through the client again, and still re-prepares each attempt of its own `HttpClient.retry`. It builds the client's preprocessing once per request, as `execute` does, so the function given to `HttpClient.mapRequestInput` runs once, not once per attempt of a `retry`. A client that rewrites the path too (adding a prefix) adds it again to a followed hop's path, as it does to a relative `Location`'s. A client that rewrites onto a URL with no origin (a custom scheme) never has a `Location` with no origin (`data:`, `mailto:`) read as a path on the base URL's origin, and a hop the kit refuses on a rewritten origin is named by the `Location` the server sent. Only that final URL and method are checked, so a chain the transport followed off the origin and back, keeping the method, goes undetected. An `http` → `https` redirect on the same host counts as another origin. A rule that sent such a request — a probe, or a read endpoint, link or page the link rules and the pagination walk fetch — drops a finding the request produced, so it never reports a probe that went unanswered as "not rejected"; a finding on an answer it did read still fails the rule. Otherwise the rule is `Skipped`, naming the redirects (the first three by their request and `Location`, the rest counted) and keeping its own note; a rule that skipped on its own names them after its reason. No rule is passed on the answers it did read alone. `spec/target/reachable` reports such a redirect once instead, as one finding telling the caller what to change: point `baseUrl` at the URL that serves, shorten a chain on the base URL's origin longer than the hop cap, fix a `Location` that does not parse, or pass a client that does not follow redirects itself. A rule probing a query parameter an endpoint does not declare names such a redirect without calling it a lost response.
  
  `spec/links/related-dereferences` now requires each resource object in the answer to carry a string `type`, so `{"data":"x"}`, `{"data":["x"]}` and `{"data":[{"id":"1"}]}` are findings. The link rules' budget skip no longer counts a read endpoint whose URL does not resolve as searched. A write rule that could not read the create's answer now names it, rather than a bare `0`.
  
  `Conformance.verifyWith` keeps the transport from following redirects by providing `FetchHttpClient.RequestInit` with `redirect: "manual"` over the run's own `RequestInit`, so a run's `redirect: "follow"` cannot undo it. A `RequestInit` given only to the client's layer (`FetchHttpClient.layer.pipe(Layer.provide(…))`) is replaced for the kit's requests; give it to the run instead.
- 1611e1c: `Conformance`'s `spec/query/include-unsupported-endpoint` and `spec/query/sort-unsupported-endpoint` rules no longer report a false failure against a hand-built endpoint whose query is not a plain struct. Discovery read only a struct's own keys, so a query declared as a `Schema.Union`, a `Schema.suspend` or a `Schema.Record` looked as though it declared nothing, and the rules probed an endpoint that does accept the parameter. Discovery now reads a query by the walk `Middleware.SchemaErrors` checks requests against: a union declares what any member declares, a suspended schema what its target declares, and an endpoint whose query names cannot be enumerated (a record keyed by any string, which the middleware stands aside for) is never probed; when that leaves nothing to probe, the skip reason names it.
  
  The include rule now probes only an endpoint whose baseline request answered 2xx, moving on to the next candidate otherwise; when no baseline succeeds, either rule skips naming each endpoint's observed status. A 400 carrying no JSON:API error objects passes with a note that says so rather than one about `source.parameter`.
- 2db254a: `Conformance`'s write rules act only on the id a create response names after checking it. The response must name a resource of the type the fixture's `create` returned (`data.type`, or `atomic:results[0].data.type` for an atomic `add`), under an id that is a URL path segment of its own — not `""`, `.` or `..`, which `encodeURIComponent` leaves alone and URL normalisation turns into the collection URL or `/`, nor a lone surrogate such as `"\ud800"`, which no URL can carry — and that is neither an `ids` sample, nor one a successful `GET` earlier in the run returned (unless the kit had already taken that id from a create of its own: a read-back of what it made does not disown it, so a server that hands out the next free id keeps working), nor one the run already holds a resource for that has not been removed. Any other id is recorded in `Report.writes` as `left`, with `id: undefined` and a `detail` naming what the response named, and is never PATCHed, DELETEd or passed to `cleanup`; the update and delete rules skip on it. The check refuses only ids that are evidently not the kit's own: any other id is trusted, so run `writes` only against a server and data you can afford to have modified.
  
  A run no longer sends its requests in the order of its report: every rule that creates nothing (the profile tier's included) runs before the first rule that creates, so a create is checked against everything the run reads. `Report.outcomes` and `format` keep the suite's order, but against a live server the requests now go out in a different order from the report's — the profile rules' requests, for one, come before the write rules'.
  
  `spec/status/update-response` passes a 200 whose document has no primary data, which JSON:API 1.1 allows when the server changed nothing beyond the request; such a document must carry a top-level `meta` that is an object and no `errors`, so a 200 answering `{}`, `{ "meta": null }` or an `errors` document (with or without `meta`) fails, and the finding says which of the three is wrong — as does one with no document, or with `data` that is not the updated resource.
  
  `spec/content-negotiation/request-content-type-parameters` now sends `{}` — a body nothing can apply — and to the create endpoint first (then an update, then a relationship write), since it runs without `mutating: true`; it sent a resource object, which a server that ignores the media type could have applied. With the write-fixture change's fix that sends a probe's body under the probe's own `Content-Type` (it was `application/json`), this rule and `spec/atomic/malformed-operations-rejected` may reach a different verdict against a third-party server than in 0.16: each now sends the media type its report always said it did.
  
  `spec/atomic/response-ext-parameter` now cites the JSON:API 1.1 §Content Negotiation universal responsibility its MUST comes from, and `format`'s `WRITES` section lists the resources still in place before those that are gone.
- 8445034: `Handlers.data`, `Handlers.collection`, `Handlers.buildIncluded` and the `Assemble` builders that route through them no longer emit a resource in `included` when it is already present as primary data. A compound document now carries one resource object per `(type, id)` pair, as JSON:API requires — previously a heterogeneous collection whose include target was also one of the hits (e.g. `/search?include=author`) repeated that resource in `included`. When every `included` candidate is already primary data, `Handlers.data` and `Handlers.collection` emit `included: []`, as they do any `included` array they are given, and the `Assemble` builders do the same when the request carried `include` (without `include` they omit the key) — so a call that passes a primary resource in `included` with nothing referencing it (e.g. `Handlers.data(article, { included: [article] })`), which used to fail the full-linkage check, now succeeds with `included: []`.
- 5434e45: A response to a request carrying `include` now keeps its `included` key when nothing is left to include, as JSON:API 1.1 §Fetching Includes requires ("even if that `included` key holds an empty array"). `Handlers.data` / `Handlers.collection` emit any `included` array they are given — empty, or emptied by the dedupe against the primary data (so `GET /search?include=author` where every author is also a hit answers `included: []`) — and omit the member only for `undefined`; before, an empty result was omitted too. A handler that passes `[]` for a request with no `include` (`query.include?.includes("author") ? [author] : []`) now emits `included: []` there as well: pass `undefined` instead when `query.include` is `undefined`. `Assemble.resource` / `Assemble.collection` / `Assemble.unpaginatedCollection` emit `included: []` whenever the request carried `include` — including when no `targets` registry is wired — and still omit it without `include` unless the caller's own members survive the dedupe.
- 4d94a70: **Behaviour change: an `include` or `sort` family declared with an empty vocabulary now counts as unsupported, so a request that used to succeed can now answer 400.** This covers `include: { paths: [] }`, `include: true` on a resource with no relationships, and `sort: true` on a resource with no attributes. The `SchemaErrors` middleware now answers any `?include=` or `?sort=` on such an endpoint exactly as it answers one on an endpoint that never declared the family: a 400 naming the parameter in `source.parameter`, with the detail saying the endpoint does not support it. That includes an empty value (`?include=`, `?sort=`), which used to answer 200, and a bracketed member such as `include[x]`, which used to be ignored. A non-empty value used to answer 400 with the detail `Expected never` and `meta.includablePaths: []` / `meta.sortableFields: []`. It now gets that same unsupported-parameter 400, without the `meta` (#282). Because the middleware answers it before content negotiation, such a request that also carries an unacceptable `Accept` or an unsupported `Content-Type` now answers this 400 where it used to answer 406 or 415, as on an endpoint that never declared the family.
  
  Only the codec the `include` / `sort` query parameter itself decodes through counts, read through a union and through `Schema.suspend`: the property the query's encoding sends under that wire name, whatever its decoded name. With `Schema.encodeKeys({ paths: "include", order: "sort" })`, `paths` decides `include` and `order` decides `sort`; a decoded `include` sent as `inc` decides nothing about `include`; a transformation between two structs that renames nothing pairs each name with itself, whatever order either struct lists them in. The property is found by running the query's encoding on probe values, once per endpoint schema rather than per request: on every wire parameter at once and on each alone. A wire parameter is paired with a decoded property only when its value lands there, and only there, both alone and among the rest, and no other wire parameter alone puts a value there; a decoded property that either of two wire parameters fills on its own (`include ?? inc`) is paired with neither. This holds on the probe values only: a decode that chooses a parameter by its value, or fills a property only from a combination of parameters, can still be misread (as the decoded-name fallback misreads it today). Where the probes cannot show which property it is (a chain of more than one transformation, one that fails or goes asynchronous on a probe, a `Middleware`), the property of that name decides, or failing one, every property whose name the wire does not declare. A hand-built query whose `include` parameter decodes through `Query.IncludeList`, or whose `sort` parameter decodes through a custom codec, publishes no vocabulary and keeps the family supported, and so does a union in which any member's vocabulary is non-empty. A vocabulary under another parameter, such as a second `Query.Include` the query declares as `other`, never decides it.
  
  Where such a value still reaches the codec, its rejection now says why: a direct decode with `Query.Include`, `Query.Sort` or `Query.schema`, without the middleware. The detail is `This endpoint supports no include paths.` or `This endpoint supports no sortable fields.` in place of `Expected never`.
- 9c73d07: Clearer messages when a filter literal does not encode. A non-finite number is now named as written (`Expected a finite number to encode as a filter literal, got NaN`, `… got Infinity`, `… got -Infinity`) instead of as `got null`. A `null` literal in a filter tree (`Filter.eq("age", null)`) now fails with `NULL is not a filter literal for field "age" (use the isnull operator)`, for every filterable field, instead of the literal codec's bare type error (`Expected number`).
  
  One behaviour change: the NULL check runs on every literal, on decode as well as encode, so it also covers an explicit literal codec (`filterLiteral`, or `Filter.able(…, { literal })`) that decodes a wire string to `null`. Such a codec — say one mapping `"none"` to `null` — used to yield `Compare(eq, field, null)` or an `In` list holding `null`; that filter is now a 400 with the message above, and a tree holding the `null` no longer encodes or passes `Filter.normalise`. NULL is never a filter literal (`docs/filter-grammar.md` F-NULL-1): use `isnull`. Derived literal codecs never produce `null`, so nothing else that decoded or encoded before is affected.
- 4630ff1: `Conformance.verify` reads an endpoint's `Idempotency-Key` as required when its headers schema is a union every member of which (read through a suspended schema) requires the header, and sends such an endpoint a fresh key on each write, so its write rules run instead of being left not decided by the missing-key 400 (#393).
- 96ed121: Presence of `include` now decides the `included` key everywhere. A bare `?include=` decodes to `[]`; `Assemble.resource` / `Assemble.collection` / `Assemble.unpaginatedCollection` used to treat that as no `include` and omit the key, and now answer it with `included: []`, as does `Handlers.resolveIncluded`, which returns `[]` for an empty path list instead of `undefined`. `ResourceHandlers.related` answers a to-one with empty linkage `{ data: null, included: [] }` when the request carried `include`, and validates those paths first, so an unsupported path is a `400` there as it is for a resolved to-one (it used to answer `200` with no `included`). `Handlers.DocumentValue` now always declares an optional `included`, so `Handlers.data(r, { included: [] }).included` type-checks.
- cd3e866: The default success document of a read endpoint whose `include` option is `true` or a `Query.IncludeOptions` now admits in `included` every resource its legal include paths reach, beside the non-`paginated` direct targets it admitted before (#320). Under `include: true`, `Endpoint.get(Article, { include: true })` advertises `comments.author`, and its document now carries the `people` that path brings in: a handler returning them type-checks, and `GET /articles/1?include=comments.author` answers 200 where it failed to encode and answered 500. The walk is bounded as the paths are: two hops under `include: true`, the `depth` an option names, or the exact `paths` of an allow-list. The same holds for `Endpoint.list`, `related` (over the target's graph), `collection` and `polymorphic` (over every member's graph), and the `get` / `list` / related endpoints `Endpoint.resource` and `Group.resource` derive.
  
  An endpoint with `include` off, or with a declared `Include.Surface`, keeps exactly the document it had, on the wire and in its type.
  
  A widened `include: boolean` (say `include: flag` with `flag: boolean`) is typed as admitting what either value admits, since the endpoint built from it may have turned `include` on and then binds the full walk at runtime. This holds on every read endpoint, `collection` and `polymorphic` included (#382), so their client-side `included` type is no narrower than what the server sends. Under `fields: true` the sparse fieldset types (`Query.FieldsetResources`) distribute likewise (#397): a reached resource trimmed by `?fields[TYPE]=` is admitted in partial form, as under `include: true`, and the query schema's `fields[TYPE]` keys cover what either value declares. An `include` that may be a declared surface or `true` (`which ? surface : true`) widens likewise on `collection` and `polymorphic`: it is typed as either the surface's own union or the full walk the endpoint binds when it is `true`, so a handler returning the `people` that `comments.author` brings in type-checks.
  
  The widened union is visible to clients too, since it is what `HttpApiClient` decodes `included` into and what the OpenAPI output describes: a client regenerated from the OpenAPI document sees the new member types, and an exhaustive `switch` on `included[].type` needs an arm for each of them, under a widened `include: boolean` as well as `include: true`. `Group.resource` turns this on for its derived `get`, `list` and related endpoints by default, since it defaults to `include: true`.
- c14846c: Docs: `Handlers.buildIncluded` now says that `onResource` shapes only `included` and that the full-linkage check reads `primary` as passed, so a direct caller should pass `primary` as the document will emit it. No runtime change.
- 302eabe: A name-only `Resource.family`'s synthesised `relationships` are now typed as the by-key intersection the runtime computes (the new `Resource.FamilyRelationships`), instead of the open `Relationships` record. So `Query.schema(Media, { fields: true })` over a name-only family, and `Endpoint.related(G, "items", { fields: true })` to one, declare exactly the member types' `fields[TYPE]` keys in their types, matching the runtime, rather than any `string` key: a misspelt `fields.phtos` no longer compiles (#363). A shared to-one relationship is typed `filter: false`, as nothing is filterable through a name-only family.
- cd8b1c6: A `null` write-body `attributes` or `relationships` member that declares no fields now answers its 400 with the detail `Expected object`, as a member that declares fields does, instead of `Expected object | array` (#286). The status and `source.pointer` are unchanged, and so is the generated OpenAPI document.
- 2153f4f: The query-parameter errors now set JSON:API `source.parameter` on their error object: `ApiError.UnsupportedIncludePath` and `ApiError.UnsupportedIncludeDepth` name `include`, `ApiError.UnsupportedSortField` names `sort`, and `ApiError.UnsupportedFieldsetMember` names `fields[TYPE]` for the rejected type — matching the 400 the schema-error middleware renders for the same rejection at decode time.
- 1764be6: A 400 for a rejected query value now names, in `source.parameter`, the parameter the request sent when the query schema renames it on the wire. A property `paths` that `Schema.encodeKeys({ paths: "include" })` sends as `include` is now reported as `include`, and the `limit` of `Query.bracketPageKeys`, `Query.bracketKeys` or `Query.flatList` as `page[limit]`. Before, `source.parameter` named the decoded property (`paths`, `limit`), which is not a parameter the request carries (#305). The same holds when a check on the whole renamed struct (`Schema.makeFilter` returning `{ path: ["limit"], issue }`) rejects the property. This covers the `SchemaErrors` middleware and `Middleware.schemaErrorDocument` called with `"Query"` on a host's own decode. A value rejected before the rename was already reported under its wire name and is unchanged, and so is every query that renames nothing. A property the query's own transformation does not show to come from one parameter alone, such as one that either of two parameters fills on its own (`include ?? inc`), keeps its decoded name, as before. The transformation is read on probe values, so a decode that chooses a parameter by its value, or fills a property only from a combination of parameters, can still be misread (as the decoded-name fallback misreads it today).
- dbbb453: **Behaviour change: a client that sends undeclared `attributes` or `relationships` members to a resource that declares none now gets a 400, where it used to get a 2xx.** This hardens request bodies against mass assignment.
  
  Before this release, a write body's `attributes` or `relationships` member that declares no fields passed every member the client sent through to the handler, although the handler's type said `{}`. That covers a resource with no attributes or no relationships, and one whose attributes or relationships are all excluded from that write (`create: false` / `update: false`, `paginated`). A handler that spread the decoded member into a write could store fields the resource never declared. Such a member now rejects the members a client sends, with a 400 JSON:API error for each whose `source.pointer` names it (`/data/attributes/<name>`, `/atomic:operations/<n>/data/relationships/<name>`), up to the cap the Minor Changes entry on capping these errors describes (#308). That applies to `createPayload`, `updatePayload`, `createInput` and the atomic `add` / `update` operations. An empty `{}` is still accepted. A non-object value for such a member (a string, a number, a boolean, an array) is a 400 `Expected object` at the member, as it already was for a member that declares fields. Client-side encoding through the same schemas (`Client`) now fails for a value with extra keys in such a member. The Minor Changes entry on undeclared members on every resource (#292) extends both the 400 and the encoding failure to a member that declares fields. `Lid.make().resolveLinkage` now writes each relationship as an own property, so any member name stays a key of its result.
- 3c2ecca: The `SchemaErrors` middleware (`Middleware.layer`, `Middleware.layerWith`, `Middleware.schemaErrorsLayer`, `Middleware.SchemaErrorsLive`) now answers a `page` or `filter` member the endpoint does not declare with a 400, under the spec's general rule (JSON:API 1.1 §Query Parameters), where the query schema used to drop it silently. On an endpoint with an explicit filter map (`filter: { status: … }`) or declared page keys (`Query.Page.Offset`, `Query.Page.Number`, `Query.Page.Cursor`, custom keys, a `Query.bracketPageKeys` struct), `?filter[stauts]=open`, `?page[sise]=10`, a deeper `filter[status][eq]` and a bare `filter` or `page` are each rejected with `source.parameter` naming the parameter as the request spelt it and a `detail` listing the members the endpoint does declare, instead of returning an unfiltered or unpaginated collection. A member counts by its wire name (`Schema.encodeKeys({ state: "filter[status]" })` declares `filter[status]`). `filter: true` is unchanged, since its grammar declares every `filter[…]` and rejects malformed members itself, and so is a hand-built open record of a family (`Schema.TemplateLiteral(["filter[", …])`). `Middleware.checkQueryParameters` applies the same rule: a declared `page[limit]` no longer admits the whole `page` family, so a host that listed one member to admit the family must now list each member, or a `page[` prefix.
- 06e36b5: **Behaviour change — a request that used to succeed can now answer 400:** a `fields[TYPE]`, `page[…]` or `filter[…]` query parameter on an endpoint that does not support that family is now rejected with **400 Bad Request** instead of being ignored, exactly as an unsupported `include` or `sort` already is (#261). For example `GET /articles/1?page[limit]=10` or `GET /articles/1?filter[status]=open` on any `Endpoint.get`, `GET /articles?fields[articles]=title` on an `Endpoint.list` declared without `fields`, or any of them on a `DELETE`. Any value is rejected, an empty one included, as is the bare name (`?page=2`, `?filter=x`, `?fields=title`). JSON:API 1.1 §Implementation-Specific Query Parameters requires it: "If a server encounters a query parameter that does not follow the naming conventions above, or the server does not know how to process it as a query parameter from this specification, it **MUST** return `400 Bad Request`." For `fields`, ignoring the parameter also broke §Sparse Fieldsets: "If a client requests a restricted set of [fields] for a given resource type, an endpoint **MUST NOT** include additional [fields] in resource objects of that type in its response." A client that sends one of these and relied on it being ignored must stop sending it.
  
  `fields` is per resource type: a `fields[TYPE]` is supported only for a type the endpoint declares a sparse fieldset for (`fields: true` declares the resource and every type its response can carry, as the `fields: true` entry in these notes sets out) and whose resource has at least one attribute. Any other `fields[TYPE]` — a type outside that set, or a type with no attribute to select — is a 400 naming that parameter, and so are a bare `fields` and a `fields[TYPE][…]`; the endpoint's other `fields[TYPE]` keep decoding. A family declared with an empty vocabulary counts as unsupported, as for `include` / `sort`: `filter: true` on a resource with no filterable field, an empty `filter: {}` map and an empty `page: {}` strategy. An undeclared member of a `page` or `filter` family the endpoint does declare, such as `page[size]` beside `Query.Page.Offset`, is rejected too (#321).
  
  The 400 carries one error object per offending parameter, naming it in `source.parameter` (`code: "bad_request"`), with a detail saying the endpoint does not support it. The `SchemaErrors` middleware answers it before the endpoint decodes anything and before content negotiation, under `Middleware.layer`, `Middleware.layerWith`, `Middleware.layerHostNegotiated` and `Middleware.SchemaErrorsLive` alike, so such a request that also carries an unacceptable `Accept` or an unsupported `Content-Type` answers this 400 rather than 406 or 415, and one for a resource that does not exist answers it rather than 404. `Middleware.checkQueryParameters` applies the same rule: it rejects a `fields`, `page` or `filter` parameter unless `declared` lists its family, and a `fields[TYPE]` unless `declared` lists that very name or a `fields[` prefix, which admits every `fields[TYPE]`. The middleware reads the same prefix from a hand-built query schema whose open record is keyed by it (`Schema.Record(Schema.TemplateLiteral(["fields[", Schema.String]), …)`), so such an endpoint supports every `fields[TYPE]`; a bare `fields` is still rejected there.
  
  A `Query.Fieldset` (and so `Query.schema`'s `fields`) for a resource with no attributes now rejects a field with the detail `This endpoint supports no sparse fieldset for type "tags".` in place of `Expected never`, where a direct decode still reaches it.
- a971aea: **Behaviour change — a request that used to succeed can now answer 400:** an `include` or `sort` query parameter on an endpoint whose `query` schema does not declare it is now rejected with **400 Bad Request** instead of being ignored, as JSON:API 1.1 requires. For `include`, §Inclusion of Related Resources: "If an endpoint does not support the `include` parameter, it **MUST** respond with `400 Bad Request` to any requests that include it." For `sort` on an endpoint that responds with a resource collection, §Sorting: "If the server does not support sorting as specified in the query parameter `sort`, it **MUST** return `400 Bad Request`" (that section "applies to any endpoint that responds with a resource collection as primary data"). For `sort` on any other endpoint, such as a single-resource `GET`, the general rule of §Implementation-Specific Query Parameters: "If a server encounters a query parameter that does not follow the naming conventions above, or the server does not know how to process it as a query parameter from this specification, it **MUST** return `400 Bad Request`." For example `GET /articles/1?include=author` on `Endpoint.get(Article)` declared without `include`, `GET /articles/1?sort=title` on any `Endpoint.get`, `GET /articles?sort=title` on an `Endpoint.list` without `sort`, or either parameter on a `DELETE`. Any value is rejected, an empty `?include=` included, as is a bracketed member such as `include[x]`. JSON:API defines only the bare `include` and `sort`, so a bracketed one — `?include[]=author`, `?include[x]=author`, `?sort[title]=1`, `?sort[x][y]=1` — is rejected under the general rule on an endpoint that does declare the bare parameter too, where the query schema used to drop it (#329); a hand-built `query` schema that declares such a name itself (a `"sort[x]"` property) supports that very name. A client that sends one of these and relied on it being ignored must stop sending it.
  
  The 400 carries one error object per offending parameter, naming it in `source.parameter` (`code: "bad_request"`), with a detail saying the endpoint does not support the parameter. The `SchemaErrors` middleware every `Endpoint` constructor attaches answers it before the endpoint decodes anything, under `Middleware.layer`, `Middleware.layerWith`, `Middleware.layerHostNegotiated` and `Middleware.SchemaErrorsLive` alike, and `Middleware.checkQueryParameters` applies the same rule: it rejects `include` and `sort` unless `declared` lists them, and a bracketed `include[…]` / `sort[…]` unless `declared` lists that very name. An endpoint that declares the family with at least one legal value keeps answering as before; one whose vocabulary is empty is covered by a separate entry (#282). `allowedQueryParameters` cannot admit `include`, `sort` or a bracketed name of either: listing one throws `Middleware.InvalidAllowedQueryParameter`, as the entry on reserved query parameters describes. A separate entry extends this 400 to `fields`, `page` and `filter`.
- 7d3cc8b: Docs: `Handlers.resolveIncluded` no longer claims the builders' full-linkage check is merely a guard on any document it feeds. The guarantee is scoped to the array the resolver returns, and the doc names what voids it — an `onResource` transform that removes or rewrites `relationships`, an edited array, or different primary data. The `checkLinkage` option on `Handlers.data`, `Handlers.collection` and `Handlers.buildIncluded` now says that a resolver-built document is not on its own a reason to turn the check off. No runtime change.
- 8464dad: `Middleware.SchemaErrorsLive` no longer answers a failure to encode the handler's _response_ as a client 400. HttpApi reports a success value its endpoint's schema rejects as an `HttpApiSchemaError` of kind `"Body"` (the request body is `"Payload"`), and the middleware used to render it as a `bad_request` document whose `detail` and `source.pointer` described the server's own output. Response-side failures (`"Body"` and `"ResponseHeaders"`) now stay a defect: error reporting sees it at `Error` severity and the client receives the opaque JSON:API 500 of `ServerErrors.SERVER_ERROR`. `"ResponseHeaders"` was already passed through, but HttpApi answered that pass-through with an empty 400; it now gets the same 500. Request-validation failures are unchanged.
- 20cb72a: `Query.schema(…, { fields: true })`: when two resource definitions sharing a wire type are reachable from one endpoint, `fields[TYPE]` now accepts the union of their attributes, as the decoded type already did. Previously only the attributes of the definition reached last were accepted, so a fieldset that type-checked could be rejected with a 400 depending on relationship declaration order (#362).
- 52290b8: **Behaviour change: documents that were accepted now throw.** The document builders' full-linkage check (`Handlers.data`, `Handlers.collection`, `Handlers.buildIncluded`, and the `Assemble` builders that route through them) now walks reachability from the primary data — the same walk the conformance kit's `spec/document/full-linkage` rule makes — instead of passing any `included` member that some resource in the document references. A document the builders accept with `checkLinkage` on therefore passes that rule on the document value they build (encoding drops relationship keys the resource does not declare, so a member reached only through an undeclared relationship is caught on the wire by `Middleware.SchemaErrorsLive` instead: #250). The walk is iterative, so a chain of `included` members tens of thousands deep is checked without exhausting the stack.
  
  Two shapes that used to pass now throw the full-linkage error (whose message now reads "is not reachable from the primary data through resource linkage"): a cycle of `included` members the primary data does not reach — for example after an `onResource` transform strips the primary data's `relationships` — and a member whose only reference is from its own relationships. A member reachable only through a member that is itself unreachable is rejected too, however many hops on. If a handler starts throwing, the `included` it builds was never linked to its primary data: drop the unreachable members, or keep the relationships that reach them.
- 6311818: **Security:** fixes three defects reachable through query parameters; upgrade. A prototype-pollution vulnerability (CWE-1321) and a request-triggerable 500 on endpoints whose query declares no family (e.g. `Endpoint.get` of a resource without relationships) affect versions 0.1.0–0.16.3; a second request-triggerable 500, in the `filter: true` grammar for field names that collide with `Object.prototype` members, affects versions 0.13.0–0.16.3, the releases that ship that grammar.
  
  An endpoint whose query declares no family — `Endpoint.get(R)` for a resource with no relationships, or any `Query.schema(R, {})` — no longer passes undeclared query parameters through to the handler's `query` (typed `{}`). `Query.schema` now keeps only the keys it declares, whether or not it declares any, so such a query decodes (and encodes) to `{}` exactly as undeclared keys are already dropped by a query that declares something. That includes a name admitted by `Middleware.layerWith({ allowedQueryParameters })`, which now never reaches the decoded `query`, as documented. The bracket reshaper behind it writes every key as an own property and no longer throws on a bracket key whose name a bare key also holds. The `filter: true` grammar (and `Filter.normalise`) reads only a resource's own filterable fields, so any field name it does not declare is a 400 `Unknown filter field` on decode and an `InvalidFilter` on encode. Declared parameters decode and encode as before.
- a298057: A member keyed `__proto__` now survives the response path as data. A value from `JSON.parse` or a database driver can carry `__proto__` as an ordinary own key; `Assemble.toWireSafeResource` used to drop it from the copy (and make its value the copy's prototype), and so did a sparse fieldset that requested it (`Handlers.project`, which the `Assemble` builders' `fields` option applies). Both now write every member as an own property, so the wire form matches `JSON.stringify` of the input.

## 0.16.3

### Patch Changes

- 24b078b: Tested against `effect` 4.0.0; the peer floor (`>=4.0.0-rc.118`) is unchanged. `Resource.Id` and `Resource.extend`'s `inheritId` now pass an explicit type argument to `Schema.brand`, which 4.0.0 requires of a generic brand identifier. The public types are identical.
  
  On effect 4.0.0, `Schema.brand` is type-only, so `Id` schemas no longer carry an `ast.annotations.brands` entry and `SchemaRepresentation` code output omits the brand; OpenAPI and JSON Schema output are unchanged.

## 0.16.2

### Patch Changes

- 5c5952c: Doc comments: the package-root module doc no longer cites `@effect/platform` or carries a sample that does not compile, and the off-vocabulary `@category` tags (`catalogue`, `readers`, `utilities`, `predicates`, `mapping`, `encoding`) now use the documented vocabulary (`errors`, `accessors`, `utils`, `guards`), so the generated API docs group them with their peers.

## 0.16.1

### Patch Changes

- e698ed0: Correct the 0.16.0 notes on two rc.118 consequences, and tighten the `/schema` entry-point guards. No runtime change.
  
  - `FlatQuery.slug`'s length check is now `Schema.isBetweenLength`, so its runtime annotation `ast.checks[0].annotations.representation.id` reads `effect/schema/isBetweenLength` where it read `effect/schema/isLengthBetween`. This reaches beyond stored `SchemaRepresentation` documents (regenerate those): any consumer keying on `annotations.representation.id`, such as effect-forms' `constraintsFromSchema`, which maps the old id to HTML `minlength` / `maxlength`, must update, or slug fields silently lose those attributes. Accepted values and messages are unchanged.
  - Effect rc.118 builds a fresh `HttpRouter` per entrypoint, so routes added to a router you provided yourself are not served. Serve `Registry.layer` / `HttpApiBuilder.layer` through `HttpRouter.serve` or `HttpRouter.toWebHandler`, not through a self-provided `HttpRouter.layer`. The README server snippet now shows this.

## 0.16.0

### Minor Changes

- b163104: **Breaking:** require `effect@>=4.0.0-rc.118` (was `>=4.0.0-rc.113`) and build against `4.0.0-rc.118`.
  
  Effect rc.118 removed every `effect/unstable/*` import path with no compatibility export: `effect/unstable/http` is now `effect/http`, `effect/unstable/httpapi` is now `effect/http-api`, and the published declarations import the new paths. No earlier `effect` release resolves them, so the peer floor moves with the paths. A consumer on rc.117 or below must upgrade `effect` and every `@effect/*` companion to rc.118 together, and must resolve a single `effect` copy.
  
  The public API of this package is unchanged: every export, signature and wire behaviour is the same, and `Middleware`, `ServerErrors`, `Registry`, `Negotiation`, `Query`, `Assemble` and `Group` keep their shapes. What rc.118 forced:
  
  - Import paths in the emitted `.d.ts` and `.js` (`effect/http`, `effect/http-api`), as above.
  - `Schema.isLengthBetween` was renamed `Schema.isBetweenLength` in rc.118. `FlatQuery.slug` uses the new name; its accepted values and messages are unchanged, but the internal check identifier a `SchemaRepresentation` or JSON Schema document records for the length check is now the rc.118 one, so regenerate any stored representation of a `slug` schema.
  - Effect's own `HttpApi` type identifiers and service keys now read `http-api` rather than `httpapi`. Code that matches those strings, such as a snapshot or an SSE client keyed on the reserved failure event name, needs the new spelling. This package matches none of them.
  - `/schema` still resolves `effect` alone. Its entry-point tests now assert that it reaches none of Effect's HTTP surface (`effect/http`, `effect/http-api`) rather than the removed `effect/unstable/*` namespace.

## 0.15.2

### Patch Changes

- 07f9c1a: `ServerErrors.schemaIssueToErrors` now uses a struct-level check's `message` annotation as the `detail` for each field the check points its failure at. Before, those fields' `detail` read `Expected a valid value`. For example, a `makeFilter(..., { message: "Passwords must match" })` on a struct that returns `{ path: ["confirm"], issue: new SchemaIssue.InvalidValue(undefined) }`, or an array of such issues, now gives `Passwords must match` at `/data/attributes/confirm`, which matches what Effect's own formatter renders. A pointed issue that carries its own `message` keeps it. `status`, `code`, `source.pointer` and the error count are unchanged.

## 0.15.1

### Patch Changes

- ccf9b8c: Render a schema issue's `detail` with Effect's own formatter. Until now `ServerErrors.schemaIssueToErrors` built it with `String(issue)`, which prints `[object Object]` because Effect Schema issue nodes have no `toString`.
  
  Each error object's `detail` is now Effect's default formatter output (`SchemaIssue.makeFormatterDefault()`), for example `Missing key`, `Expected number` or `Expected "a" | "b"`. A failed check takes its message from the check itself, either its `expected` text (for example `Expected a value with a length of at least 3`) or its `message` annotation. The same formatting applies when a schema issue is passed as one of `ValidationFailure`'s issues. Every other part of each error object is unchanged: `status`, `code`, `source.pointer` and the error count.

## 0.15.0

### Minor Changes

- 78657c9: Raise the Effect peer dependency floor from `>=4.0.0-beta.104` to `>=4.0.0-rc.113`. This is a breaking change for consumers resolving Effect below the new floor, which was necessary because semver sorts `rc` versions above `beta` versions. The previous range allowed applications to land on a version that sibling libraries (effect-auth, legation) cannot co-install with.
- cbb1636: Add `Include` — declare a resource's `?include=` surface once
  
  Serving compound documents needs three things to agree: the whitelist of accepted dotted paths, the `included` union the success schema declares (`HttpApiBuilder` strips a resolved `included` the schema doesn't admit), and the advertised `include` parameter. Until now those were separate declarations over separate inputs, so they could drift.
  
  `Include.make(resource, spec)` is one nested declaration all three project from:
  
  ```ts
  const surface = Include.make(Article, {
    author: Person,
    comments: Include.nested(Comment, { author: Person }),
  });
  
  surface.paths; // ["author", "comments", "comments.author"] — typed literals
  surface.included; // Schema.Union([Person, Comment])
  surface.has("comments.editor"); // false — the whole dotted path is matched
  
  Endpoint.get(Article, { include: surface }); // all three, from the one declaration
  ```
  
  - The whitelist spells depth: `comments` being includable does not admit `comments.editor`.
  - Nesting only ever _adds_ paths — `?include=comments` keeps meaning what it did.
  - The union carries every depth, deduplicated by schema identity, so a walk that hoists a Comment and the Person behind it has both arms.
  - Every key is checked against the resource's relationship graph (unknown key, `paginated` relationship, or wrong target) at compile time and again when the surface is built.
  
  A surface is accepted wherever `include` is — `Endpoint.get` / `list` / `related`, `Query.schema`, `Query.Include` and `Group.resource` (top-level and per endpoint) — and on `get` / `list` / `related` it also derives the success document's `included` union.
  
  Because the derivation recurses over the declaration rather than the relationship graph, a declared surface is not bound by the depth-2 ceiling `include: true` inherits; it is capped explicitly at `Include.MAX_DEPTH` (6) hops, where the type-level derivation truncates and `Include.make` throws.
  
  `Include.paths(spec)` and `Include.included(spec)` are the same two projections standalone. `include: true` and `Query.IncludeOptions` are unchanged for consumers who don't opt in.
  
  The module is schema-tier, so it is exported from `@thomasfosterau/effect-jsonapi/schema` as well as the package root: it derives the whitelist and the union from resource definitions alone, without resolving `effect/unstable/httpapi`.
  
  Mutually-recursive resources are fully supported. The derivation recurses over the declaration you wrote, never over the resource graph, so an `Article` ⇄ `Comment` cycle costs it nothing and the `included` union terminates by construction.
  
  The declared surface feeds the runtime half with no glue: `surface.paths` is the `includable` whitelist `Query.validateIncludePaths` checks a request against, and the same array is the `paths` argument to `Handlers.resolveIncluded`.
- d1ad58f: **An Effect-native compound-document `include` resolver: `Handlers.resolveIncluded`.** Walking the requested `?include=` paths — reading refs off relationship linkage, loading them, doing it again for the next hop, deduplicating across paths and rows, dropping refs that don't resolve — was left entirely to the consumer, and it is the same algorithm for every JSON:API server. It is now one call (#106):
  
  ```ts
  // One loader per resource type, called once per level with every id that level
  // collected — so each is a single `WHERE id IN (…)`, never a lookup per row.
  const targets = {
    people: (ids: ReadonlyArray<string>) => db.people.byIds(ids),
    comments: (ids: ReadonlyArray<string>) => db.comments.byIds(ids),
  };
  
  handlers.handle("list", ({ query }) =>
    listArticles(query).pipe(
      Effect.flatMap(({ items, total }) =>
        Handlers.resolveIncluded(items, query.include, targets).pipe(
          Effect.map((included) => Handlers.collection(items, { included, meta: { total } })),
        ),
      ),
    ),
  );
  ```
  
  It is a plain `Effect` a handler composes — no service to provide, no runtime to set up — and the same call serves one primary resource, a page of them, or `null`.
  
  - **Batched per level, across the whole primary set.** Every parent's references for the current segment are collected and deduplicated before anything is loaded, then handed to the loaders as one batch per distinct type. `?include=author.employer` over a 50-article page is two loader calls, not a hundred.
  - **One bucket keyed `(type, id)`.** Two paths or two rows reaching the same resource contribute it once; a shared path prefix costs no second query; a resource already in the primary `data` is never duplicated into `included`. Emission follows walk order, so a `get`'s `included` and a `list`'s agree.
  - **Depth-capped and cycle-safe.** A cyclic graph (`articles → comments → articles`) revisits resources the document already holds, which are never re-loaded; `depth` (default `3`, the deepest path `Query.Include` legalises) bounds the hops, since §7.1 leaves the bound implementation-defined and an unbounded walk is a denial-of-service surface. `concurrency` bounds a level's fan-out.
  - **An unresolvable ref is dropped, not a failure** — an unknown target type, an id the batch didn't return, a row the viewer may not see — while a genuine loader fault propagates and fails the document. `undefined` (not `[]`) when nothing was requested, so the caller omits the member.
  
  Because every resource is reached _through_ a document resource's linkage, full linkage holds by construction and `Handlers.buildIncluded`'s check becomes a guard rather than a live constraint.
  
  New exports: `Handlers.resolveIncluded`, `Handlers.IncludeTarget`, `Handlers.IncludeTargets`, `Handlers.ResolveIncludedOptions`, and the type-level `Handlers.IncludeTargetResource` / `IncludeTargetError` / `IncludeTargetServices` for naming a registry's projections. Nothing existing changes.
- 0bb9962: The client-side helpers three consuming applications each re-implemented in their web app's api layer, as an extension of `Client`:
  
  - **Decoded error responses** — `Client.make(api, { decodeErrors: true })` fails every call the server answered with an error response as a `Client.ErrorResponse` (its status, a readable message, the JSON:API error document when the body carried one) instead of the raw `HttpClientError`; transport faults pass through unchanged. `Client.failWithErrorResponse` is the same seam standalone, `Client.toErrorResponse` the reader behind it, `Client.isErrorResponse` the guard.
  - **Document readers** — `Client.ResourceDocument<R>` / `Client.CollectionDocument<R>` (the wire form, `Document.Wire`), `Client.readTotalCount` and `Client.hasNextPage` (correct at an exact multiple of the page size).
  - **Call-site inputs** — `Client.LooseInput<T>`, `Client.stripUndefined` and `Client.decodeInput(schema)`, which strips explicitly-`undefined` members before decoding a flat list or command input with its defaults and bounds.
  - **`included` hydration, typed by the resource definition** — `Client.indexIncluded` (once per document), `Client.related(resource, data, key, index)` (an `Option` of the target for a to-one relationship, an array in linkage order for a to-many; an unresolved ref is skipped, never a failure), `Client.walk(resource, data, "authors.contributor", index)` (a dotted path hop by hop to the last hop's resources, deduplicated) and `Client.hydrate(resource, document)` binding both to one document.
  - **Page cursors** — `Client.readPageCursor` (`page[offset]` / `page[limit]` off a URL, search params or query string, per-field fallbacks, the limit clamped, a custom key for a page with two lists), `Client.pageHref` (replace the cursor, keep everything else), `Client.filteredPageHref` / `Client.windowedPageHref` (the two `href(offset)` builders index pages use), `Client.canonicalPageHref` (the cursor spliced into `Query.canonicalPairs` output, the spelling a server's collection links use) and `Client.pageWindow` (the page-link window arithmetic behind a pagination control).
- d066d53: Declare `sideEffects: false` in package.json for better bundler tree-shaking. Remove `src/` from published files — the package now only ships `dist/`, `README.md`, and `LICENSE`, matching the structure of sibling libraries. Disable declaration maps and source maps in `tsconfig.json` to avoid references to unpublished source files.
- 00007c2: Build against Effect `4.0.0-rc.113` and later, and raise the published `effect` peer floor to `>=4.0.0-rc.113`.
  
  Effect `4.0.0-rc.113` renamed `SchemaTransformation.transformOrFail` to `SchemaTransformation.transformEffect`. The options are unchanged. The filter grammar (`Query.Filter`), the combined query schema's `filter[...]` routing (`Query.schema`) and the filter-literal codecs now call `transformEffect`. Decoding, encoding and error output do not change. Before this, every `effect` release from `rc.113` up was inside the declared range but failed to compile.
  
  No Effect release has both names, so one range cannot cover `rc.112` and `rc.113+`. This release therefore publishes `>=4.0.0-rc.113`, still open at the top as the shared Effect-floor policy requires. **This is breaking for consumers on `effect@4.0.0-rc.112`**: move Effect to `rc.113` or later, or stay on `effect-jsonapi@0.14.x`.
- 4b443ef: **`Handlers.data` / `Handlers.collection` / `Handlers.linkage` accept a `jsonapi` option.**
  
  `Handlers.DocumentValue` declared an optional top-level `jsonapi?: JsonApiObjectValue` member, but no builder accepted or emitted it — the type promised a member the implementation could never produce, so the only way to attach the top-level `jsonapi` object to a built document was a cast (#103).
  
  ```ts
  Handlers.data(article, { jsonapi: Document.v1_1, self: `/articles/${article.id}` });
  Handlers.collection(items, { jsonapi: Document.v1_1, links, meta });
  ```
  
  `data` / `collection` / `linkage` now each take a `jsonapi` option and stamp it onto the built document, with the return type narrowing on whether the option was passed: `jsonapi` is present (and required, not merely optional) when you pass one, and absent from the type entirely when you don't — reading `.jsonapi` back off the result needs no cast in either direction. This follows the same conditional-generic pattern the builders already use for `included` and `meta`, adding a fourth type parameter (`J extends JsonApiObjectValue = never`) to `DocumentValue` — an additive change to a type most callers only accept from a builder's return value, not one they parameterize by hand.
  
  **Not emitted by default.** A JSON:API 1.1 server arguably should advertise the version it implements on every document, but defaulting it here would silently add a `jsonapi` member to every response body every existing caller of `Handlers.data` / `Handlers.collection` / `Handlers.linkage` already produces — a behavioural change riding along on a bug fix, not something a type/implementation mismatch fix should decide on a consumer's behalf. Advertising the version stays opt-in: pass `jsonapi: Document.v1_1` (or `Atomic.jsonapi` under the atomic-operations extension) on the responses where you want it.
- 78634c7: Publish the legal vocabulary on the 400 for a rejected `?include=` path or `?sort=` field, and ship the adoption guide for the 0.14 surfaces.
  
  A request naming an include path outside the endpoint's declared surface (or a sort field outside its sortable set) was already answered with a spec-compliant 400 whose `source.parameter` named the offending key — but not with what the endpoint _does_ accept, so a caller that guessed wrong had to guess again. The include and sort literal schemas now carry that set as error `meta`, and `Middleware.schemaErrorDocument` copies it onto the error object: `meta.includablePaths` (the same set `ApiError.UnsupportedIncludePath` publishes) and `meta.sortableFields`. Error objects for schemas that publish nothing are unchanged — no `meta` member appears.
  
  `docs/guides/adopting-0.14.md` walks an existing consumer from its own include spec, include walk, fieldset projection, error-document decoder and Accept parser to `Include.make`, `Handlers.resolveIncluded`, `Handlers.compose(project, withMeta)`, `Client.errorDocument` and `Middleware.negotiate`, with before/after code taken from a consuming application; every "after" snippet is executed by `test/guides/adopting-0.14.test.ts`.
- 24550e8: `ApiError.make` can declare a `source` (constant, or a function of the fields for a per-instance `pointer`/`parameter`/`header`), so field-scoped validation errors like "this slug is taken" can carry `source.pointer` without hand-building a document. Added `Document.pointer` (RFC 6901 constructors for attribute/relationship pointers, with a collection-payload `index` and an `escape` helper) and `Document.parsePointer` (the inverse: parses a pointer back to the member it names, `None` for non-member and empty-segment pointers). `Middleware`'s internal JSON Pointer builder now reuses `Document.pointer.escape` instead of its own copy of the RFC 6901 escaping.
- c66f143: Add `Document.href`, an accessor that narrows a `Link` (`string | URL | LinkObject`, undefined-safe) to its wire string. Every link on a resource derived from `Resource.make` decodes to this union so that relative URI-references (which `URL` cannot represent) still parse absolute ones to a real `URL`; reading a link as a plain string previously meant re-deriving this narrowing per project. `Document.href` does it once: `Document.href(resource.links?.self)` — no resource redeclaration needed to get the string a wire response actually carries.
  
  The permissive `Document.Url` / `Document.Link` union is unchanged and stays the default — this is purely additive, so nothing that decodes or encodes links today changes behavior.
- 131e894: **Tracing: `Effect.withSpan` on content negotiation and request-validation failures (#122).** A traced request used to go dark exactly where this package does its work. The two places `src/` actually runs an `Effect` per request — JSON:API §5 content negotiation and the translation of a request-validation failure into a JSON:API 400 document — now wrap that work in a span, under stable names collected in `Middleware.Span`:
  
  ```ts
  import { Middleware } from "@thomasfosterau/effect-jsonapi";
  
  Middleware.Span.negotiate; // "effect-jsonapi.negotiate"
  Middleware.Span.schemaError; // "effect-jsonapi.schema_error"
  ```
  
  - `Span.negotiate` — one span per request, tagged `jsonapi.negotiation.outcome` (`"accepted"` / `"rejected"`) and, only when rejected, `jsonapi.negotiation.rule` (`"content_type"` / `"accept"`).
  - `Span.schemaError` — one span per request-validation failure, tagged `jsonapi.request_part` with the `Middleware.RequestPart` that failed (`"Params"`, `"Headers"`, `"Query"`, `"Body"`, `"Payload"`).
  
  Both are attached automatically by `ContentNegotiationLive` and `SchemaErrorsLive` — no new layer or configuration is needed, and `Effect.withSpan` is a no-op when no `Tracer` is in context, so a host with no tracing set up sees no behavior or performance change. Every attribute value is one of a small fixed set of strings; none of them is a header value, a filter literal, a query string, or anything else that varies per request or could identify a user.
  
  The rest of the package — query/filter/sort decoding, document assembly, atomic-operation processing — has no `Effect` of its own to attach a span to today (decoding and encoding run inside `HttpApi`'s own schema machinery; the document builders in `Handlers.ts` are synchronous helpers). Instrumenting those meaningfully needs an API change beyond this issue's scope; see the discussion on #122 for the proposed follow-up.
- 9b45e17: Add a client-side surface to `Client`: content negotiation and best-effort error-document decoding.
  
  A client derived by `HttpApiClient.make` sends no `Accept` header, and no `Content-Type` on a bodyless mutation such as `DELETE` — so it does not meet JSON:API's client responsibilities, and a host serving HTML and JSON:API on one origin has nothing to select on. Turning a failed call into the error document it carries was left to the consumer too. Both are now the package's.
  
  **Negotiation**
  
  - `Client.make(api, options)` — `HttpApiClient.make` with the JSON:API request transform pre-applied. The common case needs no `transformClient`, and an api using extensions takes the same `extensions` value as the server's `Middleware.layerWith`.
  - `Client.transform` / `Client.transformWith(options)` — the same transform over an existing `HttpClient`, for a custom transport or `HttpApiClient.makeWith`.
  - `Client.jsonApiHeaders` / `Client.jsonApiHeadersWith(options)` — the transform over one request: `Accept` on every request, `Content-Type` on every mutating one. Only the label changes: the body bytes are untouched, and a request that already declares a genuinely different representation (`multipart/form-data`) keeps its `Content-Type`.
  - `Client.isMutatingMethod(method)` — the `POST` / `PATCH` / `PUT` / `DELETE` predicate, exported because it is a correctness detail rather than sugar: a bodyless `DELETE` still carries the label, and a façade and a server that both call this cannot disagree about which requests do.
  - `Client.mediaType(options)` — the media type with its `ext` parameter, built from the same definition the server's response annotations and §5 parser use, so client and server cannot drift.
  
  **Error documents**
  
  - `Client.decodeErrorDocument(body)` — a supported entry point, not an implementation detail: it takes a body rather than a response, so a façade that synthesises responses locally and never holds an `HttpClientError` decodes through the same seam as the network transport. Genuinely best-effort — HTML from a proxy, a truncated payload, an opaque 502, an empty body all yield `Option.none()` rather than throwing a second error inside the error path.
  - `Client.errorDocument(cause)` — the same decode reached from a failed call's `HttpClientError`. Never fails, never throws.
  - `Client.errorMessage(document)` / `Client.DEFAULT_ERROR_MESSAGE` — the first `detail`, else `title`, else a constant.
  - `Client.ErrorDocument` — the decoded document type.
  
  **`Client` moves to the HTTP tier**
  
  `Client.make` and the negotiation transform reach `HttpApiClient` and `HttpClient`, so `Client` now resolves `effect/unstable/httpapi` and is no longer re-exported from the schema-only `@thomasfosterau/effect-jsonapi/schema` entry point. It is unchanged on the package root. The two members that would still fit that tier — `narrowIncluded`, a type-level operation with no runtime, and `decodeErrorDocument`, which decodes through `Document`'s error schemas alone — go with it, because a namespace exported from both entry points has to be the same module object.
  
  A worked client is included as `examples/blog/client.ts`, round-tripping documents and errors against the blog example server.
- c27ad13: Resource metadata and introspection, so a third party can derive from a resource definition without reverse-engineering it.
  
  **`Resource.annotate` / `Resource.annotations`.** A resource definition is a `Schema.Struct` with its derived members assigned onto it, so Effect's own `resource.annotate({ ... })` rebuilt the schema and returned a plain struct with `type`, `identifier`, `relationships`, `declaredAttributes`, `createPayload`, `document()` and the rest gone — it was no longer a resource, and no longer a valid relationship target. `Resource.annotate(resource, annotations)` is the supported seam: it returns a complete resource of the same type, valid as a `Relationship.one(() => …)` target, with the annotations readable through `Resource.annotations(resource)`. Annotations are inherited by `Resource.extend` (the child's own keys winning) and can be declared up front with the new `annotations` option of `Resource.make` and `Resource.extend`.
  
  **`Resource.attributeDescriptors`.** The per-attribute shape a resource declares, in declaration order, as plain data: `key`, `schema`, presence in the resource object and both write projections, `clearable`, `nullable`, `readOnly` and the attribute's annotation bag. Consumers no longer need `resource.fields.attributes.ast`, a cast through `unknown`, or a decoder run against sentinel values to learn what the declaration already said.
  
  **`Relationship.paginated(ref, { order })`.** A paginated relationship can now declare its canonical order — a list of `Sort.Term`s over the related resource's attributes or its `id`. Paging is only well defined over a stable total order (`first` / `prev` / `next` / `last` denote a sequence of pages, and a cursor is a position in an order), so this is part of the relationship's wire contract rather than a storage detail, and it gets a first-class slot instead of an annotation. Storage vocabulary — a foreign-key column, a table name — has no wire representation and stays an annotation.
  
  Also: `Sort.Term` is now public (the `{ field, direction }` shape `Query.Sort` decodes into), and `Resource.Any` declares `declaredAttributes`, so `Resource.declaredAttributes` no longer reads it through a cast.
- d13d8fa: Make `asJsonApi` and `asMediaType` public via new `MediaType` namespace module
  
  Expose media type annotation combinators as a public `MediaType` module for developers writing hand-rolled endpoints with `HttpApiEndpoint`. Previously only available as `@internal` functions, `asJsonApi` marks schemas as JSON:API bodies and `asMediaType` marks them with arbitrary media types — the same annotations the package's own `Endpoint` constructors use internally.
  
  The `asJsonApiAtomic` combinator remains internal as it is specialized to the atomic operations extension.
- 13390ca: **Every comma-separated query family now accepts the repeated-key spelling, not just `include`.** (#102)
  
  `Query.schema`'s `sort` and `fields[TYPE]` options applied `Repeatable` (the codec that accepts `UrlParams.toRecord`'s array shape for a repeated key) at `include` only — `?sort=-createdAt,title` decoded, but the equivalent `?sort=-createdAt&sort=title` was a 400, with no principle distinguishing the two spellings of the same grammar. Both now decode identically, in any mix:
  
  ```ts
  // all three decode to the same sort list
  "?sort=-createdAt,title";
  "?sort=-createdAt&sort=title";
  "?sort=-createdAt&sort=title,body"; // the mixed form
  ```
  
  The same fix reaches `fields[TYPE]` and, at its list-valued positions (the shorthand `filter[f]`, `filter[f][op]`, and a group form condition's `[value]` member), the `filter` grammar (`docs/filter-grammar.md` §2) — `filter[status]=open&filter[status]=done` now decodes the same as `filter[status]=open,done`. A repeated key everywhere else in the filter grammar (a group's `[conjunction]`, any `[memberOf]`, a condition's `[path]` / `[operator]`) is still a 400: those positions take exactly one scalar. Encoding is unchanged — always the single canonical comma form.
  
  The standalone constructors — `Query.Include`, `Query.Fieldset`, `Query.Sort` — compose the same `Repeatable` widening under their item codec, so a consumer building a query from those pieces directly (rather than through `Query.schema`) gets the same repeated-key acceptance.
  
  **Behaviour change: an empty comma segment is now dropped, not rejected.** `?include=a,,b` and `?include=a,b,` (a double comma, or a leading/trailing one) previously reached the item schema as an empty-string element and failed with an unhelpful "not a valid item name" — the grammar has no way to spell an intentional empty item, so a gap is a stray separator, not a member of the set. Both now decode as `["a", "b"]`; this applies to `include`, `fields[TYPE]` and `sort` alike.
- e0e0618: Add a schema-only entry point: `@thomasfosterau/effect-jsonapi/schema`
  
  The package had a single `"."` export, so every consumer reached every module through one barrel that imports `effect/unstable/httpapi`. A client decoding documents, or a consumer mapping them into something else, resolved the whole server surface to get at schemas that never needed it.
  
  `@thomasfosterau/effect-jsonapi/schema` re-exports the modules whose import graph is `effect` alone — `Client`, `Document`, `Filter`, `Relationship`, `Resource`, `Sort` and `MEDIA_TYPE`:
  
  ```ts
  import { Document, Resource } from "@thomasfosterau/effect-jsonapi/schema";
  ```
  
  Error _documents_ are still reachable, since `Document.ErrorDocument` and `Document.ErrorObject` are document schemas; it is `ApiError`'s error _classes_ that carry HTTP status and content-type annotations.
  
  This is about the dependency, not the bytes. `effect/unstable/*` is pre-stable, so every unnecessary dependency on it is a version-compatibility surface — tree-shaking may drop the code, but it cannot drop the dependency.
  
  The root export is unchanged: it still exports every namespace, every symbol is the same object under both entry points, and no existing import is affected. The subpath is a packaging seam, not a second API — the generated docs are unchanged.
  
  Internally, `internal/media.ts` was reduced to the media type constants, with no imports at all; the annotation helpers it re-exported from the public `MediaType` module moved to `internal/httpMedia.ts` alongside `asJsonApiAtomic`. `MediaType` now takes `MEDIA_TYPE` from `internal/media.ts` instead of redefining it. No public behaviour changes.
  
  `Query`, `Handlers`, `Lid` and `Atomic` read as schema-only but are outside the tier: constraining include paths fails with `ApiError.UnsupportedIncludePath` / `UnsupportedIncludeDepth`, which are `HttpApi`-bound error classes, and the other three reach `Query`. Including them would mean separating `ApiError`'s error classes from their wire annotations — a change to a public module rather than a packaging one.
  
  The property is enforced mechanically by `test/entry-points.test.ts`, which walks the real import graph from the entry point (AST-based, counting type-only imports), pins the tier membership, repeats the check on the built artifact, and loads the published subpath in a child process where `effect/unstable/*` is unresolvable. Each check is paired with a control asserting it still detects a violation via the root barrel, so it cannot rot into a tautology.
- 5e308c7: The server skeleton: the ~2,000 lines of app-agnostic scaffolding three consuming applications each carried on top of this package, as idiomatic `HttpApi` modules.
  
  - **`ServerErrors`** — the domain error catalogue an operation raises (`NotFound`, `Unauthorized`, `Forbidden`, `Redirect`, `HttpError`, `ValidationFailure`), the `JsonapiError` carrier, `schemaIssueToErrors` (an Effect Schema issue tree to RFC 6901-pointed error objects), `fromTaggedError` (the catalogue, every `ApiError.make` class and a `JsonapiError` to its document; anything else stays a defect) and `respond`, the boundary every handler is wrapped in, with a `materialise` hook for the arms only an application can recognise (a database driver's unique violation as a 409).
  - **`Negotiation`** — the representation verdict for a host serving JSON:API on its page URLs: `make({ api })` derives `isApiPath` from every endpoint path and `negotiate(request)` decides dispatch from the request line and headers alone (a clean JSON:API instance winning `Accept` on a read, the JSON:API `Content-Type` on a write, §5's 406 / 415 at the seam, alternates such as a Markdown rendering negotiated first on their own paths), plus `requestForRouter`, `errorResponse`, `isMutatingMethod` and the host guards.
  - **`Document.wire`** and **`Document.Wire<T>`** — the wire variant of a resource schema (string links), which the flat documents declare.
  - **`Query.IncludeList`**, **`Query.includeListField`** and **`Query.flatList`** — the open `?include=` list in both spellings, and a flat list input put on the wire (`page[…]` / `filter[…]` bracketed, `include` added) in one call whose result `Query.canonicalPairs` applies to directly.
  - **`FlatQuery`** (also on the schema-only entry point) — the flat list-input grammar: `pagination` / `pageLimit` / `PageOffset`, `SortParam` / `sortField` (bounded at `MAX_SORT_FIELDS`, both wire spellings), `idList` / `IdList` / `idListField`, `slug` / `slugResourceFields` / `slugCreateFields`, `listInput`, and the tri-state reader `suppliedValue`.
  - **`Group.flat`** / **`Group.flatReadOnly`** — the CRUD and read-only presets over one resource, flat command inputs and a flat list query, returning `{ group, listQuery }`; **`Endpoint.flatRelated`**, **`Endpoint.relatedName`**, **`Endpoint.ResourceDocument`** / **`RelatedDocument`** / **`FlatCollectionDocument`** and **`Endpoint.FlatGetQuery`** for the longhand groups.
  - **`Assemble`** — the document assembler over `Handlers`: `resource`, `collection` (its include walk validated with `Query.validateIncludePaths` and resolved batched with `Handlers.resolveIncluded`), `relationship` (§8.4), `edgePage`, the capability hooks `roleCapabilities` / `ownedCapabilities` / `noCapabilities`, `stringifyLinks`, `toWireSafeResource` and `relationshipRefs`; generic in the viewer.
  - **`ResourceHandlers`** — `make` / `readOnly` / `related`: the handler set keyed by the presets' endpoint names, with the viewer, the link base, the transaction seam and the cache as parameters, `assertIdMatchesPath` failing `ApiError.Conflict`, and the list input inferred from the group's `listQuery` so an operation typed by a different input is a compile error.
  - **`Registry`** — `FamilyFor<G>` / `HandlersFor<G>` (the success channel checked against each endpoint's declared document), `checkFamily` (the module-init name-parity check), `familyLayer`, `layer`, `platformLayer` and `webHandler`.
  
  Also: `Middleware`'s media-type parser now reports an unparseable `q` rather than deciding it (the §5 check still treats it as a refusal; the negotiation verdict treats it as the default weight, as the applications did).
- 4c1eabf: Add the standard JSON:API query-parameter errors: `ApiError.UnsupportedIncludePath`, `ApiError.UnsupportedIncludeDepth`, `ApiError.UnsupportedSortField` and `ApiError.UnsupportedFieldsetMember` (grouped as `ApiError.QueryParameterErrors`), each carrying what the endpoint _does_ support in `meta` (`includablePaths`, `sortableFields`, `attributes`) so a rejection tells a client the legal set without a second request.
  
  Also adds `Query.validateIncludePaths`, a runtime validator (depth checked before membership, matching the whole dotted path) for resolvers that walk a whitelist not fully expressible as `Query.Include`'s closed schema.
  
  `UnsupportedSortField` and `UnsupportedFieldsetMember` are standalone declarations for now: `Query.schema`'s `sort` and `fields[TYPE]` codecs already validate against a closed, schema-build-time `Schema.Literals` set, so there's no dynamic "requested vs. supported" check point analogous to `include`'s (open-ended, resolver-validated) paths for them to be wired into yet.
  
  None of the four set `source.parameter` — `ApiError.Config` has no way to declare a `source` yet (tracked separately); once it does, these four are the natural first adopters.
- cb97cd1: **`Query.bracketKeys`: the general form of `Query.bracketPageKeys`.** Re-keys an arbitrary set of a flat query struct's encoded keys under an arbitrary bracket prefix — `page`, `filter`, `fields`, or one of your own — not just `offset` / `limit` under `page`. Composes when piped more than once onto the same struct, so a consumer-owned flat query struct can bracket several families at once without losing any of them (#111).
  
  ```ts
  const ListArticles = Schema.Struct({
    ...Query.Page.offset({ maxLimit: 100, fromString: false }),
    authorId: Schema.optionalKey(Schema.String),
    status: Schema.optionalKey(Schema.String),
  });
  
  const wire = ListArticles.pipe(
    Query.bracketKeys("page", ["offset", "limit"]),
    Query.bracketKeys("filter", ["status"]),
  );
  // wire:    { "page[offset]": …, "page[limit]": …, "filter[status]": …, authorId: … }
  // decoded: { offset, limit, status, authorId }   ← unchanged, still flat
  ```
  
  `Query.bracketPageKeys` is unchanged and now built on top of `bracketKeys` — `Query.bracketPageKeys(s)` is exactly `s.pipe(Query.bracketKeys("page", ["offset", "limit"]))`.
- 282f1ff: Add idempotent writes: the `Idempotency-Key` profile (#123)
  
  A retried `POST` duplicates. `lid` does not cover it — a local id correlates resources _within_ one request and says nothing about whether the request already ran. The new `Idempotency` module answers that as a JSON:API profile (`https://thomasfosterau.github.io/effect-jsonapi/profiles/idempotency/v1`), defined in full in [`docs/idempotency.md`](./docs/idempotency.md).
  
  - **The header, on the endpoints that honour it.** `Endpoint.create` / `update` / `delete` / `operations`, and the `Endpoint.resource` / `Group.resource` generators, take `idempotency: true | "required"`. It declares the `Idempotency-Key` request header (typed and parsed, not raw) and attaches `Idempotency.Middleware`, so an api carrying an idempotent endpoint does not type-check until a store is provided. Endpoints that do not opt in are unchanged.
  - **Replay is verbatim.** A retry carrying the same key gets the recorded response back byte for byte — the same status, headers and body — plus `Idempotency-Replayed: true`, so a `201` stays a `201` and typed clients keep working.
  - **The same key with a different body is an error, not a replay.** `422 Unprocessable Content` (`idempotency_key_mismatch`), checked before the in-flight case; a retry while the original is still running is `409 Conflict` (`idempotency_key_in_progress`). Both are JSON:API error documents carrying `source: { header: "idempotency-key" }`. A missing required key is the package's standard `400`.
  - **The store is a seam.** This package persists nothing: `Idempotency.Store` is three effects (`claim` / `complete` / `release`) the application supplies to `Idempotency.layer(store)`, with `claim`'s atomicity and the retention window as documented requirements. `Idempotency.memoryStore()` is a reference implementation for tests and single-process development.
  - **Atomic operations:** one key covers the whole request — the extension's own unit of atomicity — and replays the whole `atomic:results` document, so a replayed `lid` resolves to the id it resolved to the first time.
- 29228d5: Add a per-resource transform pass to the document builders, so sparse fieldsets and computed `meta` apply uniformly to primary data and `included`.
  
  `Handlers.data`, `Handlers.collection`, `Handlers.linkage` and `Handlers.buildIncluded` now take an `onResource` transform, applied **once per resource** to every slot the document has: the primary `data`, every deduplicated `included` member, and a linkage document's resource identifiers. It runs after dedup (so a transform runs once per distinct resource, not once per occurrence) and before the full-linkage check (so the check sees what the document actually emits). A resource reached in two slots is shaped once and reused, so it cannot come out two ways.
  
  Three transforms ship with it, plus an escape hatch:
  
  - `Handlers.project(fields)` / `Handlers.project(resource, fields)` — sparse fieldsets. A type with no requested set is returned unchanged (the spec's "every field", not "no field"), and only `attributes` is projected; `relationships`, `links` and `meta` are left alone. Relationship fields (`?fields[articles]=author`) are out of scope.
  - `Handlers.withMeta(compute)` — computed per-resource `meta`, merged over whatever the resource carries. An empty merged result emits **no** `meta` member rather than `{}`.
  - `Handlers.compose(first, second)` — one pass doing both.
  - `Handlers.transform<Lambda>(f)` — any other per-resource processing.
  
  A transform's effect stays visible in the document's type rather than widening to `ResourceValue`: `Handlers.data(article, { included, onResource: Handlers.project({ articles: ["title"] }) })` types both `data.attributes` and the included articles' `attributes` as `{ title: string }`. This is carried by a type-level function (`Handlers.TransformLambda` / `Handlers.Transformed`), since one transform is applied at several types in a single document. A plain function is still accepted and is checked against `Handlers.IdentityLambda` — it must return the resource's own type.
  
  `Handlers.DocumentValue`'s `Included` parameter is no longer constrained to `ResourceValue`, so it can name a transform's output type.
- 9126177: Make mutually-recursive resource definitions authorable.
  
  `Relationship.one(() => Person)` has always been a thunk, so the _runtime_ relationship graph could contain cycles. Inference could not: `Resource.make`'s return type is inferred, so an `Article` ⇄ `Comment` pair made each definition's type depend on the other's and TypeScript refused both with `TS7022` / `TS7024`. The ordinary parent ⇄ child JSON:API graph therefore had to hide one direction in a plain attribute (`productId`) and tell consumers about it out of band.
  
  A cyclic pair is now authorable with the same escape Effect's recursive schemas use — an explicit annotation on the recursive binding, which here is one `interface` per resource in the cycle:
  
  ```ts
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
  
  Attributes are hoisted to a `const` and referenced with `typeof`, so no attribute schema is restated. All four relationship kinds may take part in a cycle, self-references included, and everything derived from the definitions keeps working: `document()` / `collection()` (whose `included` union stays one hop wide, never the transitive closure), `?include=` path derivation (bounded by depth, not by the graph), create/update payloads, `Endpoint.*`, `Group.resource`, `Query.schema`, `Resource.extend` and `Resource.family`.
  
  Three supporting changes made it work:
  
  - **New:** the lowercase descriptor types `Relationship.one`, `Relationship.optional`, `Relationship.many` and `Relationship.paginated` — the types the constructors of the same name produce, defaults included (`one` / `optional` default to not filterable, `paginated` to no declared `order`). A resource definition is invariant in its relationship record, so an annotation has to name the type the constructor produced; these are it. A relationship that declares a `filter` or an `order` names it in the annotation, as the `const` tuple the constructor infers.
  - **New:** `Resource.Parameter<Type, Attributes, Rels, Meta, IdSchema>`, the parameter form of `Resource.Resource`, now used wherever the package takes a resource definition apart into its type parameters (`Endpoint.*`, `Group.resource`, `Resource.extend`, `Resource.family`). It reads `Type` off the definition's own `type` tag instead of inferring it structurally, which silently widened to `string` for an interface-annotated definition — taking every `Type`-derived default with it, starting with the endpoint path. As a type it is exactly `Resource.Resource`.
  - `Relationship.SchemaFor` now selects on the descriptor's `kind` tag rather than matching `D extends One<infer R>`, and the descriptor interfaces carry a phantom `~target` member so the target can be read by a plain indexed access. Matching a descriptor against the candidate interfaces made TypeScript relate the target resource back into the mapped type it was computing, which is the loop a cyclic graph could not close (`TS2615`). The two selections agree on every descriptor. `Relationship.TargetOf<D>` reads that phantom and is exported alongside it.
  
  The phantom member means a descriptor value assembled by hand (rather than through `Relationship.one` / `optional` / `many` / `paginated`) no longer satisfies the descriptor interfaces structurally. Use the constructors.
- 21d35b6: Add `Conformance` — an executable specification of JSON:API v1.1, and of this package's filter grammar profile, that a server can be driven through to prove it conforms.
  
  `Conformance.verify(api, { ids })` discovers your endpoints from the `HttpApi` value (method, path, declared query families, response media type) and then decides every rule against a real request/response pair over an in-memory transport wired to the real router — no port bound, no fixture beyond one known-existing id per resource type. `Conformance.verifyWith(api, { client, baseUrl })` runs the identical rules against a deployed server over any `HttpClient`. Conformance is a wire property, so the rules observe raw statuses, media-type parameters and unparsed bodies, and send the malformed requests a typed client cannot express.
  
  31 rules across two separately runnable tiers. The `spec` tier covers content negotiation (including the RFC 9110 §12.4.2 `q`-weight rules), document structure (top-level members, full linkage computed transitively, duplicate resources, resource identification, the `jsonapi` object), error objects and `source` discrimination, query-parameter handling (sparse fieldsets on primary data _and_ on `included`, unsupported `include` / `sort`, unknown parameters), 404 semantics and the atomic operations request document. The `profile` tier covers the filter grammar's advertisement, its rejections with `source.parameter`, and spelling equivalence between shorthand and group form, plus two library conventions (`jsonapi` version advertisement, the repeated-key query spelling). Pass `tiers: ["spec"]` to hold a server to the specification without adopting the profile.
  
  Failures name the rule, quote its normative sentence, cite its section and show the request that decided it. `Conformance.assert(report)` fails with a `ContractViolation` carrying all of that, and `Conformance.format(report)` renders the whole run.
  
  The report states what it did **not** check. A rule that could not run reports why — no endpoint of that shape, no sample id, a mutating probe not opted into — rather than passing vacuously, and `Conformance.gaps` declares the areas the kit does not cover at all (filter evaluation semantics, pagination-link and sort-ordering correctness, write semantics, atomic processing, link dereferenceability), each with its reason and tracking issues. Skips are counted separately from passes so a run that proved little cannot read as a clean one.
  
  Mutating probes are off by default, so a run is safe to point at a live server.

### Patch Changes

- 4471f9f: Fixed `Middleware.acceptIsAcceptable` and `Middleware.contentTypeIsAcceptable` (and the `Middleware.negotiate` predicate they back) incorrectly treating an `Accept` entry's `q` weight as a media type parameter. Per RFC 9110 §12.4.2, `q` terminates a media type's parameter list — it and anything after it are accept-extension parameters, not subject to JSON:API §5's ext/profile whitelist. Previously `application/vnd.api+json;q=0.9` was rejected outright, and a low-weighted JSON:API entry alongside a higher-weighted non-JSON:API one (e.g. `text/html;q=0.9, application/vnd.api+json;q=0.8`) produced a spurious 406. An entry weighted `q=0` is now correctly treated as an explicit refusal rather than a malformed parameter.
- 3f2f23a: Fix a phantom `unknown` requirement on every `:id` endpoint of a generated client
  
  The endpoint constructors that take an `:id` path parameter passed a bare field record as `params`, which left `HttpApiEndpoint`'s return type a deferred conditional. Declaration emit then serialised it with the conditional's true-branch narrowing baked in, as `Schema.Struct<Schema.Struct.Fields & { id: … }>`. That index signature admits `Schema.Top`, whose `DecodingServices` is `unknown`, so `get`, `update`, `delete`, `related`, `polymorphic` and the relationship methods on a client built with `HttpApiClient.make` each carried an `unknown` requirement that no layer could satisfy. Paramless endpoints (`list`, `create`, `collection`) were unaffected.
  
  The bug was only visible through the published `.d.ts`; type-checking against the sources resolved the same call sites cleanly, which is why the existing type-level tests never caught it. Passing `Schema.Struct({ id: … })` resolves the conditional eagerly, so the emitted parameter type is now a concrete `Schema.Struct<{ id: … }>` with no index signature, and the requirements come out as `never`. The parameter stays required and branded; the runtime behaviour is unchanged (`HttpApiEndpoint` already accepted a schema instance here).
  
  Consumers carrying a cast to launder the phantom requirement can drop it.
- 5205c5f: Migrate the toolchain to the Vite+ library standard.
  
  For consumers the package is the same API, built differently:
  
  - `dist/` is now emitted by `vp pack` (tsdown) — one ESM bundle per entry point (`.` and `./schema`) plus bundled declarations — instead of one file per module from `tsc`. The `exports` map and the two entry points are unchanged; the schema-only entry point still resolves `effect` and nothing else.
  - The sources compile under `exactOptionalPropertyTypes`. Every optional option a caller may pass an explicit `undefined` for (`Query.Options`, `Document.*`'s `included` / `meta` / `error`, `Handlers.data` / `collection` / `buildIncluded`'s `included` / `checkLinkage` / `onResource`, `Resource.make` / `extend`'s `id`, `attribute`'s `filterLiteral`) is now spelled `?: T | undefined`, so a consumer on that flag can forward its own optional values without a cast.
  - The published manifest declares its `effect` peer through pnpm's `catalogs.peers` (the floor itself is covered by this release's peer-floor entries) and is published with `pnpm publish` under npm OIDC trusted publishing.
  - `engines.node` is now `>=22`.

## 0.14.0

### Minor Changes

- facaa91: **`Resource.extend` accepts a custom `id` schema.** `extend(base, type, { id })` now mirrors
  `Resource.make`'s `id` option: the subtype's id is the consumer-provided schema and nothing else — no
  package brand is added — so a consumer that keys its subtypes with its own hierarchical brand
  catalogue (branding at the row-mapping seam via `AdminId.make(row.id)`) can use `extend` for subtype
  chains. The identifier, `ref`, payloads and documents follow the custom id exactly as they do for
  `make`. (#49)
  
  ```ts
  const AdminId = Schema.String.pipe(Schema.brand("AdminId"))
  const Admin = Resource.extend(Account, "admins", { id: AdminId })
  
  Admin.Id.make("1") // string & Brand<"AdminId">
  ```
  
  - `ExtendedId<BaseId, Type, Inherit, Custom = undefined>` gains a fourth parameter: `Custom` when
    given, else the existing `Inherit` behaviour, else the fresh `Id<Type>`.
  - `id` and `inheritId: true` are contradictory: the options type does not admit both, and passing
    both throws at definition time naming the two options.
  - Omit `id` and nothing changes — the default and `inheritId` behaviours are untouched.
- da55d44: **Input-only (write-only) attributes, and optional create attributes that accept `undefined`.**
  
  - `Resource.attribute(schema, { resource: false })` declares an attribute that is **accepted as
    input but never on the resource object** — an upload's binary, a password, a one-time token — so a
    write-only field is declarable in one place (#47). The attribute is absent from the resource
    `Schema.Struct` (at runtime and in the types: `ResourceFields["attributes"]` is now
    `Schema.Struct<ResourceAttributes<Attributes>>`), its documents, `AttributeKeys`, `attributeKeys`,
    `attributeAnnotations`, sparse fieldsets and `filterable` / `sortable`, while it still projects into
    `createPayload` / `createInput` and `updatePayload` / `updateInput` per its `create` / `update`
    settings, and into the atomic `add` / `update` operations.
  
    ```ts
    const Upload = Resource.make("uploads", {
      attributes: {
        fileName: Schema.NonEmptyString,
        file: Resource.attribute(FileSchema, { resource: false, update: false }) // create-only binary
      }
    })
    // Upload.Type.attributes  → { fileName }          Upload.createInput.Type → { fileName, file }
    ```
  
    The map _as declared_ stays reachable as `Upload.declaredAttributes` / `Resource.declaredAttributes(R)`
    (`Resource.DeclaredAttributesOf<R>`); `Resource.attributes(R)` keeps returning the resource-object
    map. `Resource.extend` inherits input-only attributes; name-only families keep intersecting
    resource-object fields. `Resource.make` throws, naming the attribute, for `resource: false` combined
    with both `create: false` and `update: false` (declares nothing), or with a `filter` / `sort`
    declaration (not on the resource object, so nothing to filter or sort by). `AttributeConfig` gains a
    trailing `Resource` parameter (defaulting to `true`).
  
  - `create: "optional"` now projects as `Schema.optional(S)` — the key may be absent, or present with
    a value or an explicit `undefined` — instead of the strict `Schema.optionalKey(S)`, matching what
    `updateInput` / `updatePayload` already do (#48). A caller building `{ x: maybeUndefined }` (a form
    adapter computing `x: input.x?.trim() || undefined`) now type-checks against `createInput` under
    `exactOptionalPropertyTypes` as it already did against `updateInput`. This is a **type widening** of
    `createInput` / `createPayload` (and the atomic `add` operation) for optional attributes: the field
    schema is `Schema.optional<S>` rather than `Schema.optionalKey<S>`, so its `Type` is
    `S["Type"] | undefined`. The same widening applies to a **bare `Schema.optionalKey(S)` attribute**
    (no descriptor), which the update side already widened; a bare `Schema.optional(S)` attribute is
    unchanged. On a JSON wire an explicit `undefined` and an absent key are the same thing. Code that
    pinned the `optionalKey` shape needs the wider type; nothing that decoded before is rejected now.
  
  - `Resource.attribute`'s `resource` option must be a literal (`true`, `false` or `"optional"`): a
    non-literal `boolean` is now a compile error, since the resource-object type cannot be decided from
    it.

## 0.13.0

### Minor Changes

- 555802f: **The canonical query string: `Query.canonical(schema)`, with the pagination link builders and
  `Handlers.collection` carrying the request's full query.** JSON:API 1.1 requires a collection
  document's `self` link to carry the query parameters the client provided; a decoded query now has
  exactly one wire spelling, produced by one function with one ordering rule.
  
  ```ts
  const listQuery = Query.schema(Article, {
    include: true,
    fields: true,
    sort: true,
    page: Query.Page.Offset,
    filter: true
  })
  const canonical = Query.canonical(listQuery)
  
  canonical(query)
  // → "include=author&fields[articles]=title&filter[status]=open&sort=-createdAt&page[offset]=0&page[limit]=10"
  ```
  
  - **One order.** `include`; `fields[*]` sorted by type; `filter[*]` in the filter grammar's
    canonical order (shorthand sorted by key, the group form in the encoder's pre-order); `sort`;
    `page[*]` in the page strategy's declared order (`offset, limit` — what the link builders already
    emit); then any other key sorted. Two equal decoded queries produce byte-identical strings whatever
    spelling they came from (key order, `?include=a&include=b` against `?include=a,b`,
    `filter[f][eq]=v` against `filter[f]=v`), and the string decodes back to the same query.
  - **One encoding.** `Query.serialise(pairs)`: RFC 3986 percent-encoding via `encodeURIComponent`
    (spaces `%20`, commas `%2C` — a list's separator and the grammar's `\,` alike), `[` / `]` left
    readable in keys, pairs joined with `&`. `URLSearchParams` / `UrlParams` decode it back
    identically. `Query.canonicalPairs(schema)` is the ordered pair list before serialisation.
  - **Link builders.** `Handlers.offsetPaginationLinks` / `numberPaginationLinks` now serialise
    through `Query.serialise` (their output is unchanged) and take an optional fourth argument
    `{ query: Query.canonicalPairs(listQuery)(query) }` — the request's other canonical pairs, into
    which each page cursor is slotted — so `self` / `first` / `prev` / `next` / `last` carry the
    full `include` / `fields` / `filter` / `sort`.
  - **`Handlers.collection`** takes a `query` option (the canonical pairs or string) appended to its
    `self` link, for collections that are not paginated.
- f59b77c: **The `filter` URL codec: `filter: true`, `Query.Filter(resource)` and the `Filter.Ast`.**
  The filter grammar in `docs/filter-grammar.md` is implemented over the per-attribute declaration.
  `Endpoint.list(R, { filter: true })` (and `Query.schema(R, { filter: true })`) decodes the
  `filter[...]` family to one normalised `Filter.Ast` root node, typed over the declared fields, and
  encodes a tree back to its canonical wire form.
  
  ```ts
  const Product = Resource.make("products", {
    attributes: {
      priceCents: Resource.attribute(Schema.Int, { filter: ["eq", "gt", "lt"] }),
      status: Resource.attribute(Schema.Literals(["draft", "live"]), { filter: true })
    }
  })
  
  Endpoint.list(Product, { filter: true })
  // GET /products?filter[status]=live&filter[priceCents][lt]=1000
  // → query.filter = And([Compare(lt, priceCents, 1000), Compare(eq, status, "live")])
  ```
  
  - **Surface.** `filter[f]=v` is `eq`, `filter[f]=a,b` is `in`, `filter[f][op]=v` any of the closed
    core `eq ne lt lte gt gte in nin isnull`; the Drupal-style group form
    (`filter[g][group][conjunction]=OR`, `filter[c][condition][path|operator|value|memberOf]`) spells
    `OR`, `NOT`, nesting and repeated `(field, operator)` pairs. Literals are decoded through the
    attribute's literal codec, with `\,` and `\\` as the only escapes.
  - **AST.** `Filter.Ast<Fields>` — `Compare`, `In`, `NotIn`, `IsNull`, `And`, `Or`, `Not` — plus the
    untyped `Filter.Node`, a runtime `Filter.Ast` schema, dumb constructors (`Filter.eq`, `Filter.isIn`,
    `Filter.and`, …) and `Filter.normalise`. `Query.FilterAst<R>` narrows `field` to the declared names
    and each literal to its field's type.
  - **Canonical form.** Decoding normalises (values and members sorted and deduplicated); encoding
    emits the shorthand when it round-trips and the group form with pre-order ids otherwise, so the
    canonical string is a function of the tree alone. `Filter.PROFILE_URI` (also
    `Query.FILTER_PROFILE_URI`) is the grammar's profile URI.
  - **Errors.** Every rejection — unknown field, undeclared operator, bad literal, malformed key,
    repeated key, and each structural fault of the group form — is one issue whose path is the
    offending flat key, and the schema-error middleware now renders a request-validation failure as an
    error object per reported issue, with `source.parameter` (`filter[age][gt]`, `page[limit]`),
    `source.header` or `source.pointer` (`/data/attributes/title`) and the issue's message as `detail`
    (`Middleware.schemaErrorDocument`). HttpApi decodes with `errors: "first"`, so a request part yields
    one error object; the `filter` family is the exception, its codec reporting every offending key
    together. A failure with no derivable source keeps the previous single-error document.
  - The per-key `filter: { q: Schema.String }` map is unchanged and remains the escape hatch; a
    heterogeneous endpoint must use it (`filter: true` throws at definition time).
  - `ApiError` wire schemas now decode an error document whose `meta` omits an optional field, instead
    of failing on the absent key.
- 8164019: **Per-attribute `filter` / `sort` declarations — `Filter.able` / `Sort.able` — with `Resource.filterable`
  and `Resource.sortable`.** Filterability is now declared on the resource, per attribute, rather than
  left to an open per-endpoint `filter: { key: Schema }` map. The declaration is made on the attribute
  schema itself, with pipeable, Effect-native combinators, and rides with it as a schema annotation
  (`Filter.AnnotationId` / `Sort.AnnotationId`) — the single source of truth the accessors read back —
  so it is carried through `Resource.extend`, `Resource.attributes` spreads, `resource: "optional"`,
  `Schema.NullOr` and `Schema.optionalKey`.
  
  ```ts
  import { Filter, Resource, Sort } from "@thomasfosterau/effect-jsonapi"
  
  const Product = Resource.make("products", {
    attributes: {
      name: Schema.NonEmptyString, // neither filterable nor sortable
      priceCents: Schema.Int.pipe(Filter.able([Filter.Op.eq, Filter.Op.gt, Filter.Op.lt]), Sort.able()),
      discontinued: Schema.Boolean.pipe(Filter.able()), // the whole operator core
      createdAt: Resource.readOnlyAttribute(Schema.DateFromString.pipe(Sort.able()))
    }
  })
  
  Resource.filterable(Product) // { priceCents: { operators, literal }, discontinued: { … } }
  Resource.sortable(Product) // ["priceCents", "createdAt"]
  Endpoint.list(Product, { sort: Resource.sortable(Product) })
  ```
  
  - `Filter.able()` admits the whole operator core, `Filter.able([...])` a subset in the order given;
    `Sort.able()` allows `?sort=`. Absent means not filterable / not sortable — the default fails
    closed, like `include` / `fields` / `sort`. An empty list or an operator outside the core is a
    compile error and a definition-time throw. Annotate last, for the types: the runtime declaration
    survives a later `.check` / `.annotate` / `Schema.brand`, but any rebuild drops the type-level
    marker.
  - `Resource.attribute(schema, { filter, filterLiteral, sort })` (and `Resource.readOnlyAttribute`)
    are **sugar** for those calls on the inner schema and stamp nothing else, so both spellings are
    indistinguishable to the accessors and to the types.
  - The operator vocabulary is **schema-backed, not stringly typed**: `Filter.Operator` is a
    `Schema.Literals` over `eq ne lt lte gt gte in nin isnull`, from which `Filter.operators` and
    `Filter.isOperator` derive; `Filter.Op` spells the operators as typed constants (`Filter.Op.gt` is
    `"gt"`), so a typo is a compile error while plain strings stay accepted.
  - Each filterable attribute gets a **literal codec** (`Schema.Codec<Type, string>`) derived from its
    schema's encoded form — `string`, `number`, `boolean`, or `Schema.NullOr` of one. The wire string is
    parsed strictly (`number` accepts only a finite decimal, `boolean` only `true` / `false`) and then
    decoded through the attribute schema itself, so refinements, brands, literal unions and
    `DateFromString` apply and `filter[priceCents][gt]=abc` fails decoding. An attribute whose encoded
    form is not a scalar cannot be declared filterable — `Resource.make` throws, naming it — unless the
    declaration supplies an explicit codec: `Filter.able(ops, { literal })`.
  - To-one relationships are filter fields too: `Relationship.one(ref, { filter })` and
    `Relationship.optional(ref, { filter })` admit `eq ne in nin isnull` — `Relationship.FilterOperator`,
    a `Schema.Literals` narrowing `Filter.Operator` (`true` means those five, an ordering operator is a
    definition-time error) — valued by the related resource's id: the literal codec is the target's `Id`
    schema, resolved lazily, so `filter[author]=9` decodes to the branded id. `Resource.filterable(R)`
    lists them alongside the attributes; `Resource.sortable` stays attributes only.
  - `Resource.sortable(R)` is typed as the literal key union, so it drops straight into
    `Query.schema(R, { sort: Resource.sortable(R) })` and `Endpoint.list(R, { sort: … })`. `sort: true`
    keeps meaning "every attribute".
  - Type-level: `Resource.FilterableKeys<R>`, `Resource.FilterOperators<R, K>`, `Resource.SortableKeys<R>`,
    `Resource.Filterable<R>`, `Resource.FilterLiteralType<S>` (alias of `Filter.LiteralType`),
    `Filter.Declared<S, Op>` / `Sort.Declared<S>` (the phantom-marked schema types) and
    `Resource.FilterDeclaration` (the `filter` sugar's shape).
  
  `Query.schema` is unchanged in this release; the `filter` URL codec over the declaration (the
  grammar in `docs/filter-grammar.md`) follows separately.

## 0.12.0

### Minor Changes

- 6f6314a: **The injected `IdSchema` is threaded through the endpoint constructors.** `Resource.make` has
  accepted a custom id schema since 0.4.0, but no endpoint constructor carried it: `Endpoint.get` /
  `list` / `create` / `update` / `delete`, the relationship constructors, `Endpoint.resource` and
  `Group.resource` all typed their resource parameter as `Resource<Type, Attributes, Rels, Meta>`,
  whose fifth type parameter defaults to the derived `Id<Type>`. A resource carrying the consumer's
  own branded id — the case the injection was added for — was therefore not assignable to any of
  them, and had to be cast at the call site even though the runtime was already correct (the
  constructors read `resource.Id` verbatim).

  Each of those constructors now takes the id schema as a type parameter of its own, defaulting to
  the derived `Id<Type>`, and threads it into `Resource<…>`:

  ```ts
  const InvoiceId = Schema.String.pipe(
    Schema.brand("AccountId"),
    Schema.brand("InvoiceId"),
  );
  const Invoice = Resource.make("invoices", {
    id: InvoiceId,
    attributes: { total: Schema.Number },
  });

  // no cast at any of these, and `:id` is `InvoiceId` rather than `Id<"invoices">`
  Endpoint.get(Invoice);
  Group.resource(Invoice);
  ```

  The brand reaches the `:id` path parameter and the documents each endpoint declares by default —
  the success document, the collection, `updatePayload` — so a handler and a generated client see the
  resource's real id type rather than the derived one. No runtime behaviour changes: the constructors
  already passed `resource.Id` through, and a resource with no injected id infers exactly what it
  inferred before.

  The parameter sits fifth, where it sits on `Resource` itself, on the constructors whose remaining
  parameters are all defaulted (`get` / `list` / `create` / `update` / `delete`, `Endpoint.resource`,
  `Group.resource`), and ahead of the parameter list's first required member elsewhere
  (`Endpoint.related` and the relationship constructors, `ResourceOptions`, `ResourceEndpoint`,
  `ResourceEndpoints`). That is visible only to code that instantiates one of them explicitly —
  `typeof Endpoint.get<…>`, `ResourceOptions<…>` — never to a normal call site.

## 0.11.0

### Minor Changes

- a7f3bbb: **Repeated `?include=` keys, and a `query` override on `Endpoint.get`.** Two halves of the same gap
  on the read path.

  `Query.schema` declared `include`'s wire form as `Schema.optionalKey(Schema.String)`, so the
  repeated-key spelling — `?include=a&include=b`, which `UrlParams.toRecord` decodes to an **array** —
  failed to decode and answered 400, where the comma form `?include=a,b` denoting the same set answered 200. Both spellings are now accepted and decode identically; encoding still emits the single comma
  form, so nothing a client is handed changes shape, and an unknown or unlisted path is still the 400
  it was in either spelling. No opt-in: this is a widening of the parameter the package composes.

  `Endpoint.get` also gains the `query` override `Endpoint.list` has carried since 0.9.0 — any
  `Schema.Top`, defaulting to today's `include` / `fields` composition, with those options ignored once
  it is given — threaded through `Endpoint.resource` / `Group.resource`'s per-endpoint `get` config,
  and `GetConfig` gains the matching `query` field:

  ```ts
  Endpoint.get(Article, {
    query: Schema.Struct({
      include: Schema.optionalKey(Schema.String),
      includeDeleted: Schema.optionalKey(Schema.Literals(["true", "false"])),
    }),
  });

  Group.resource(Article, { endpoints: { get: { query: GetArticle } } });
  ```

  Only the query changes; the `:id` path param, success document, errors and middleware are untouched.
  `Endpoint.get`'s type parameter list gains `QuerySchema` before `Success`, mirroring `list` — visible
  only to code that instantiates `typeof Endpoint.get<…>` explicitly, never to a normal call site.

- 74503fd: **`status` option on `Endpoint.create` / `Endpoint.update`.** `create` stamped `201` on its success
  schema unconditionally — re-stamping even a caller-supplied `success` — and `WriteConfig` carried no
  `status`, so an api whose creations answer `200` could not adopt the constructors without a wire
  change. Both constructors now take an optional `status`, defaulting to today's `201` for `create` and
  `200` for `update` whether or not `success` is given, and it is threaded through
  `Endpoint.resource` / `Group.resource`'s per-endpoint `create` / `update` config. This is the
  `status` `DeleteConfig` has carried since 0.9.0, on the write endpoints:

  ```ts
  Endpoint.create(Article, { status: 200 });
  Endpoint.update(Article, { status: 202 });

  Group.resource(Article, {
    endpoints: { create: { status: 200 }, update: { status: 200 } },
  });
  ```

  Only the status changes; path, params, request payload, success schema, errors and middleware are
  untouched.

- 0b79079: **`payloadMediaType` option on `Endpoint.create` / `Endpoint.update`.** Both constructors wrapped
  their `payload` — the override included — in the JSON:API media type, so the router's _request_
  registration was always `application/vnd.api+json` with no way out. Effect's router answers 415 on a
  mismatched request `Content-Type`, so a host that enforces §6 at its own seam and then dispatches
  writes to the router relabelled `application/json` had every package-built write rejected before a
  handler saw it.

  Both now take an optional `payloadMediaType`, defaulting to today's `application/vnd.api+json`, and
  it is threaded through `Endpoint.resource` / `Group.resource`'s per-endpoint `create` / `update`
  config:

  ```ts
  Endpoint.create(Article, {
    payload: Article.createInput,
    payloadMediaType: "application/json",
  });

  Group.resource(Article, {
    endpoints: { create: { payloadMediaType: "application/json" } },
  });
  ```

  Only the request registration moves: the payload schema, the response media type, path, params,
  errors and middleware are untouched. Pair it with `Middleware.layerHostNegotiated` — the counterpart
  for the negotiation half — so the package's own §5 check doesn't reject what the host admitted.

## 0.10.0

### Minor Changes

- ea5d196: **`success` override on `Endpoint.get` / `list` / `create` / `update`.** The constructors bound their
  response unconditionally to the resource's `document()` / `collection()`, so the only shape a
  handler could answer with was the resource itself. They now take an optional `success` schema —
  any `Schema.Top`, like `payload` — defaulting to exactly those documents, for apis whose response is
  a _wire variant_ of the resource: an assembler that stringifies every link before the document
  leaves the server emits `links.self` as a plain string, where the resource's own `Document.Link`
  decodes an absolute reference to a `URL` and hands every generated-client call site the wrong type.
  The override is served as `application/vnd.api+json` like every other body in the package, at 201
  for `create` as before, and the document envelope is untouched, so `Handlers.offsetPaginationLinks`
  and the other handler helpers still apply to an overridden `list`. The option is threaded through
  `Endpoint.resource` / `Group.resource`'s per-endpoint `get` / `list` / `create` / `update` config,
  so a generated group can adopt the wire variant without being spelled out by hand. Only the response
  changes — path, params, query parameters, request payload, errors and middleware are untouched.

## 0.9.0

### Minor Changes

- 58956ac: **Constrainable `include` paths.** `Query.Include` derived the resource's whole relationship graph
  to a depth of 2, and `include` was a boolean over that set — so an endpoint advertised every path
  the graph reaches, including ones its resolver was never written for. Advertising an unresolvable
  path answers 200 with an empty `included`, which is strictly worse than the 400 an unknown path
  already produces.

  `Query.Include` now takes an options object — `paths` (an explicit allow-list) and/or `depth`
  (`1` / `2` / `3`; `paths` wins when both are given) — and the same object may be passed as `include`
  wherever a boolean was accepted: `Endpoint.get` / `list` / `related` / `collection` /
  `polymorphic`, `Query.schema`, and `Endpoint.resource` / `Group.resource` both top-level and per
  endpoint. The literal path type narrows with the runtime set, so an unlisted path fails to compile
  as well as to decode. `include: true` still means today's full-graph depth-2 derivation, and the
  relationship endpoints — whose paths are their target's graph, not the configured resource's —
  inherit only that `include` is on.

  Adds `Resource.IncludeDepth` and `Resource.IncludePathsTo<R, Depth>` (the type-level mirror of
  `Resource.includePaths`' `maxDepth`), plus `Query.IncludeOptions` / `Query.IncludeOption` /
  `Query.IncludePathsOf`. `Query.Include<R>` gains a second, defaulted type parameter for its path
  set; `Endpoint.GetConfig<Meta>` gains a second, defaulted parameter for the resource it configures.

- aa7784b: **`query` override on `Endpoint.list`.** The constructor composed its query schema from the
  `include` / `fields` / `sort` / `page` / `filter` options and offered no way out of that composition,
  which always nests what it decodes (`page: { offset, limit }`, `filter: { … }`). It now takes an
  optional `query` schema — any `Schema.Top` — defaulting to that composition, for apis whose list
  contract is a flat struct their own operations layer consumes: a page cursor bracket-keyed on the
  wire but decoded flat (see `Query.bracketPageKeys`), entity foreign keys, and flags JSON:API has no
  query family for, which `filter` would otherwise put on the wire as `filter[<name>]`. The feature
  options are ignored once `query` is given. The option is threaded through `Endpoint.resource` /
  `Group.resource`'s per-endpoint `list` config. Only the query changes — path, success document,
  errors and middleware are untouched.
- fc6c707: **`success` override on `Endpoint.delete`.** The constructor bound its response unconditionally to
  `HttpApiSchema.NoContent`, so every generated delete was a 204 with an empty body. It now takes an
  optional `success` schema (and a `status` for the rare non-200 case), defaulting to that 204, for
  apis whose deletion answers with a body — a soft delete that marks the row deleted, re-reads it and
  returns the tombstone resource document. The override is served as `application/vnd.api+json` like
  every other body in the package. The option is threaded through `Endpoint.resource` /
  `Group.resource`'s per-endpoint `delete` config, so a generated group can adopt tombstone deletes
  without being spelled out by hand. Only the response changes — path, params, errors and middleware
  are untouched.

## 0.8.0

### Minor Changes

- fdb8e3b: Migrate off `Schema.TaggedErrorClass`, which effect removed in `4.0.0-beta.104` (renamed to
  `Schema.TaggedError`). The peer dependency requirement moves accordingly:
  `peerDependencies.effect` is now `>=4.0.0-beta.104` — a breaking change for consumers on
  effect `<= 4.0.0-beta.103`, who should stay on `effect-jsonapi@0.7.x`.

  `ApiError.make`'s runtime behavior and public types are unchanged; only the underlying effect
  call site moved. A handful of other effect API renames landed in the same range and are adapted
  here too: `HttpApiEndpoint.Any` → `HttpApiEndpoint.Top`, and the `HttpApiSchemaError` a
  `SchemaErrors` middleware handles can now carry a `"ResponseHeaders"` kind (a server-side response
  schema failure), which is now re-raised rather than mislabeled as a client 400.

  Also: effect's `Schema` values (including this package's `Resource` definitions) are now callable
  at runtime, so `Resource.Ref` and `Resource.isFamily` no longer rely on `typeof value === "function"`
  / `typeof value === "object"` to tell a resource from a lazy thunk — both public functions still
  behave the same for callers.

## 0.7.0

### Minor Changes

- 70343a7: Three additions for consumers whose transport doesn't match the package's defaults. All are opt-in
  and default to today's behaviour.

  **`payload` override on `Endpoint.create` / `Endpoint.update`.** Both constructors bound their
  request body unconditionally to the resource's `createPayload` / `updatePayload` — the nested
  JSON:API envelope. They now take an optional `payload` schema, defaulting to that envelope, for apis
  whose write contract is a flat command input (the resource's own `createInput` / `updateInput`, or
  any schema of your own) while still answering with JSON:API documents. The option is threaded
  through `Endpoint.resource` / `Group.resource`'s per-endpoint `create` / `update` config, so a
  generated group can adopt flat writes without being spelled out by hand. Only the request body
  changes — path, params, success document, errors and middleware are untouched.

  **`Query.bracketPageKeys`.** A standalone combinator re-keying a flat `{ limit, offset, … }` struct's
  page cursor to the spec-canonical `page[limit]` / `page[offset]` wire family, leaving the decoded
  type and every other field's wire key alone. `Query.schema`'s `page` option was the only route to
  those bracket keys, and it always nests the decoded cursor under `page` — this serves consumers who
  merge pagination flat into their own query struct instead of composing the whole query through
  `Query.schema`. No change to existing `Query.schema` paths.

  **Middleware usable without the endpoint constructors.** `Middleware.schemaError(part)` returns the
  JSON:API 400 that request validation produces, standalone — the counterpart to the existing
  `Middleware.negotiate`, so a framework hook that owns the URL can answer byte-identically to an
  `Endpoint`-built api. `Middleware.layerHostNegotiated` (and `Middleware.ContentNegotiationPassthrough`
  alone) satisfies the constructors' `ContentNegotiation` requirement without performing §5, for apis
  whose host already negotiated content upstream and would otherwise negotiate twice.

## 0.6.0

### Minor Changes

- 565071e: Decode JSON:API URI members to real `URL`s instead of plain strings.

  A new `Document.Url` schema decodes an **absolute** URI-reference to a WHATWG
  `URL` and leaves a **relative** reference (which the spec permits, and which the
  server-side `Handlers` helpers emit) as a `string` — its decoded type is
  `URL | string`. Both forms encode back to the original string, so the wire
  format is unchanged and relative links keep working.

  `Document.Url` is now used wherever the spec calls for a URI:

  - link targets — `Document.Link` and `LinkObject.href` (so `self` / `related` /
    pagination links across `TopLevelLinks`, `ResourceLinks`, `RelationshipLinks`
    and the error object's `about` / `type` links);
  - `LinkObject.describedby`;
  - the top-level `jsonapi` object's `ext` and `profile` URI arrays.

## 0.5.0

### Minor Changes

- f5e663f: Add **polymorphic resource families** (`Resource.family`) — a supertype over a set of member
  resources for heterogeneous "any node" use (closes #41).

  A family **is** the discriminated union over its members (decoded by the `type` tag) **and**
  structurally satisfies `Resource.Any`, so it can be used as primary `data`, as a compound
  `included` member, and — the headline — as a **relationship target**
  (`Relationship.one(() => family)` / `optional` / `many` / `paginated`), where linkage decodes for
  any member (keyed on the member `type`, never the family name) with no changes to the relationship
  machinery.

  - `Resource.family(Base, [A, B])` — base-anchored (recommended): the shared `Id` /
    `relationships` / attributes come from `Base`, so the shared id brand anchors "any member id"
    and dotted `?include=` paths through the family are meaningful (pair with members defined as
    `extend(Base, …, { inheritId: true })`).
  - `Resource.family("name", [A, B])` — named, no base: the shared id is a union of the members'
    ids and the shared relationships/attributes are the by-key intersection.
  - `family.document()` / `family.collection()` derive documents whose `data` is the member union
    and whose `included` spans every member's targets.
  - `Endpoint.polymorphic(family, …)` is the single-resource `GET /family/:id` (returning any
    member); `Endpoint.collection(family.members, …)` and `Group.make(family, …)` already cover the
    collection and group cases.
  - `Resource.isFamily`, `Resource.Family`, `Resource.FamilyIdentifier`,
    `Resource.FamilyDefaultIncluded`, `Resource.FamilyIncludePath`, `Resource.FamilyIncluded`.

  Strictly additive — no existing signatures change.

- dbada1f: Add **per-attribute projection descriptors** — control how each attribute appears in the resource
  object versus the four write projections (additive, no breaking changes):

  - **`Resource.attribute(schema, options)`.** Declares a per-attribute projection. Options (all
    optional; the defaults reproduce a plain `Schema` attribute):

    - `resource` — presence in the resource object schema + documents: `true` (default) or
      `"optional"` (an optional key).
    - `create` — presence in `createPayload` / `createInput`: `"required"` (default), `"optional"`,
      or `false` (excluded).
    - `update` — presence in `updatePayload` / `updateInput`: `"optional"` (default, tri-state) or
      `false` (excluded).
    - `clearable` — whether the update projection additionally accepts `null` to clear; defaults to
      whether the schema is `Schema.NullOr`.

  - **`Resource.readOnlyAttribute(schema)`.** Shorthand for a server-set attribute —
    `attribute(schema, { create: false, update: false })`: present in the resource object and
    documents, excluded from every write projection. Use it for version-chain timestamps
    (`createdAt`, `updatedAt`, …), counters and other server-computed state.

    ```ts
    const Article = Resource.make("articles", {
      attributes: {
        title: Schema.NonEmptyString,
        createdAt: Resource.readOnlyAttribute(Schema.Date),
        slug: Resource.attribute(Schema.String, { update: false }),
        summary: Resource.attribute(Schema.NullOr(Schema.String), {
          create: "optional",
        }),
      },
    });

    // Article.Type.attributes                  → { title, createdAt, slug, summary }
    // Article.createPayload … data.attributes  → { title, slug, summary? }   (no createdAt)
    // Article.updatePayload … data.attributes  → { title?, summary? }        (no createdAt, no slug)
    ```

  A plain `Schema` attribute keeps today's read-write behaviour, so the feature is fully opt-in. The
  descriptor rides on the attribute's schema value, so it flows through `attributeKeys`,
  `attributeAnnotations`, sparse `fields` and `include`, is carried through `Resource.extend`, and is
  respected by the Atomic `add` / `update` operations — consistently with the create/update payloads.
  The type-level projection helpers `Resource.Attribute`, `Resource.AttributeConfig`,
  `Resource.CreateAttributes` and `Resource.UpdateAttributes` (and the runtime
  `Resource.createAttributeFields` / `Resource.updateAttributeFields`) are exported too.

## 0.4.0

### Minor Changes

- dafe9ff: Unblock higher-level adoption with five additive features (no breaking changes):

  - **Custom id-schema injection.** `Resource.make` accepts an optional `id` schema (any codec whose
    `Encoded` is `string`), so a resource's id can carry a consumer-defined brand instead of the
    auto-derived `Resource.Id`. The id type is threaded through `Resource`, `Identifier`,
    `updatePayload`, and the document schemas (a new, defaulted last type parameter — existing
    callers are unchanged). `Resource.Identifier(type, id?)` accepts a custom id schema too.
  - **Subtype ids on extend.** `Resource.extend(Base, type, { inheritId: true })` brands the base's id
    schema with the child's type, so the child id accumulates the base's brand(s) and is assignable
    wherever the base id is expected — a true subtype relationship, transitive through an `extend`
    chain (`Admin.Id` ⊂ `Account.Id`). Defaults to `false` (an independent brand, as before).
  - **Tri-state update payloads.** A resource's `updatePayload` now models PATCH semantics distinctly
    per attribute via `Schema.optional`: an **absent** key means _leave unchanged_, an **`undefined`**
    value means _unset_, and a present value means _set_. Nullable attributes (`Schema.NullOr(...)`)
    therefore accept `value | null | undefined`.
  - **Per-attribute annotations.** `Resource.attributeAnnotations(resource)` reads the Effect schema
    annotations stamped on each attribute (e.g. a `dbColumn` mapping authored with
    `schema.annotate({ ... })`), so metadata can ride alongside an attribute schema.
  - **Flat ("command-style") payloads.** Resources expose `createInput` and `updateInput` — flat
    attribute structs without the JSON:API `{ data: { type, ... } }` envelope — for transports (RPC,
    remote functions) that carry a flat request shape.
  - **Document value types.** `Handlers.DocumentValue` is now exported (with an optional `jsonapi`
    member and `Handlers.JsonApiObjectValue`), and `Document.Value<R>` names a data-document value
    type, so consumers can annotate their document-assembling functions instead of hand-rolling the
    envelope.
  - **Decoupled middleware.** `Middleware.negotiate(headers, options?)` runs JSON:API §5 content
    negotiation outside Effect's HttpApi (returning the offending `UnsupportedMediaType` / `NotAcceptable`
    or `undefined`), and `ApiError.toDocument(error)` encodes any `ApiError` instance to a JSON:API
    error-document value — so a plain framework hook can reuse the negotiation and error machinery.

## 0.3.0

### Minor Changes

- 0da7692: Add `Query.Page.offset` (bounded, defaulted, optional plain-number) factory.

  `Query.Page.offset(options?)` returns the same `{ offset, limit }` field-map as the constant `Query.Page.Offset`, but configurable:

  - **Bounded** — `maxLimit` caps `limit` (a DoS guard); `minLimit` (default 1) floors it.
  - **Defaulted** — `defaultLimit` / `defaultOffset` fill in concrete values on decode when the wire key is absent; omit one to leave that field optional.
  - **Coercion-flexible** — `fromString: false` builds the fields from plain `Schema.Number` (encoded = number) instead of `FiniteFromString` (encoded = string), so the same schema works both as a numeric call-site input and behind a transport that coerces query strings (raw `HttpApiEndpoint` wrapped in `Schema.toCodecStringTree`).

  A page-number twin, `Query.Page.number(options?)`, applies the same bounds/defaults to the `size` field (1-based `number`). The existing `Page.Offset` / `Page.Number` / `Page.Cursor` constants are unchanged.

  ```ts
  Endpoint.list(Article, {
    page: Query.Page.offset({ maxLimit: 100, defaultLimit: 25 }),
  });
  ```

## 0.2.0

### Minor Changes

- 7cb72be: **Breaking:** `Document.DataDocument` is now a pure envelope — its `data` member is exactly the schema you pass, dropping the implicit `Schema.NullOr`. `DataDocument(R)` changes from `data: R | null` to `data: R`.

  JSON:API only permits `null` primary data for a single-resource request whose URL might correspond to a resource but currently doesn't ([§Fetching Resources → 200 OK](https://jsonapi.org/format/1.1/#fetching-resources-responses-200)). Fetch-existing / create (201) / update (200) always carry the resource — a missing one is a `404`, never `200 { data: null }` — so nullability is now the caller's compositional decision rather than something the constructor bakes in:

  ```ts
  DataDocument(Article); //                  data: Article            (was: Article | null)
  DataDocument(Schema.NullOr(Article)); //   data: Article | null
  DataDocument(Article.nullable()); //       data: Option<Article>, ⇆ null on the wire
  ```

  **Migration:** restore the old shape by wrapping the argument — `DataDocument(Schema.NullOr(R))`. Downstream this lets consumers delete hand-rolled non-null single-resource envelopes (e.g. a website's `ResourceDocument` becomes `Document.DataDocument(wireResource(resource))`).

  Ripple effects:

  - `Resource.document()` and `Endpoint.fetch` / `Endpoint.create` / `Endpoint.update` now produce non-null primary `data` (the canonical single-resource document for an existing resource).
  - `Endpoint.related` for a to-one relationship keeps the nullable form (`data: target | null`) to preserve the empty-linkage `data: null` case.
  - New `Resource.nullable()` method on every resource definition — `Article.nullable()` is `Schema.OptionFromNullOr(Article)`, the blessed, spec-clean nullable codec (`None ⇆ null`) for `Document.DataDocument(Article.nullable())`. Prefer it over effect's structural `Schema.Option` (`{ _tag, value }`), which would serialise a non-conformant body.

- 513119f: **Whole-resource endpoint generation:** `Endpoint.resource` and `Group.resource` derive an entire JSON:API endpoint set from a single resource definition — the full CRUD surface plus, for every relationship, the `related` and linkage endpoints appropriate to its kind — with `include` / `fields` / `sort` query parameters derived from the resource graph.

  ```ts
  // The whole group, fully typed, in one call:
  const articles = Group.resource(Article, {
    errors: [ArticleNotFound],
    page: Query.Page.Offset,
    // per-endpoint config overrides the top-level defaults:
    endpoints: {
      create: { errors: [TitleTaken] },
      list: { filter: { author: Schema.optionalKey(Schema.String) } },
    },
  });

  // Or get the endpoints as a tuple to compose with Group.make:
  const articles = Group.make(
    Article,
    ...Endpoint.resource(Article, { errors: [ArticleNotFound] }),
    Endpoint.list(Article, {
      name: "search",
      path: "/articles/search",
      filter: { q: Schema.String },
    }),
  );
  ```

  Defaults emit all five CRUD operations and every relationship's endpoints with `include` / `fields` / `sort` enabled; `page` and `filter` stay opt-in, and `errors` is applied uniformly. Everything is overridable, globally or per entry:

  - `endpoints` is an object keyed by operation (`get` / `list` / `create` / `update` / `delete`); each value is `true` (emit with defaults), `false` (omit), or an object configuring that endpoint (its `name` / `path` / `errors` and applicable query / `meta`), overriding the top-level defaults.
  - `relationships` is `true` (all, default) / `false` (none), or an object keyed by relationship name — each `false` to exclude, or an object to configure that relationship's endpoints. Relationships not mentioned are emitted with the defaults.
  - `meta` may be a `Schema` (overriding the document meta) or a function `(base) => schema` that _extends_ the resource's base meta rather than replacing it.

  The result is plain `HttpApiEndpoint` / `HttpApiGroup` values, so it composes with everything as before. See `Endpoint.ResourceOptions`.

  **Breaking:** several endpoint constructors are renamed, and the heterogeneous-collection constructor now takes an explicit route.

  - `Endpoint.fetch` → `Endpoint.get` (default endpoint name `"fetch"` → `"get"`).
  - `Endpoint.remove` → `Endpoint.delete` (default endpoint name `"remove"` → `"delete"`). `delete` is a reserved word, so it is re-exported from an internal implementation; `Endpoint.delete(...)` is the public name.
  - `Endpoint.fetchRelationship` → `Endpoint.getRelationship` (the relationship-linkage GET, for parity with `Endpoint.get`). The generated endpoint name `<name>Relationship` is unchanged, so handler keys and client methods are unaffected.
  - `Endpoint.search` → `Endpoint.collection`, and its `name` and `path` are now **required** (the `"search"` / `/search` defaults are removed). A polymorphic collection has no owning resource and so no conventional route; the constructor name no longer presumes "search" (it fits feeds and timelines just as well). The exported `SearchIncluded` type is renamed to `CollectionIncluded`.

  **Migration:** replace `Endpoint.fetch(R, …)` / `Endpoint.remove(R, …)` with `Endpoint.get(R, …)` / `Endpoint.delete(R, …)`, and rename the corresponding handler keys and client methods (`"fetch"` → `"get"`, `"remove"` → `"delete"`). Replace `Endpoint.fetchRelationship(R, …)` with `Endpoint.getRelationship(R, …)` — a rename of the constructor only; its `<name>Relationship` endpoint name (and thus its handler key) is unchanged. Replace `Endpoint.search([…], { … })` with `Endpoint.collection([…], { name: "search", path: "/search", … })` (the explicit `name` / `path` reproduce the old defaults), and rename any `SearchIncluded` references to `CollectionIncluded`. `Endpoint.removeRelationship` is unchanged — it matches the spec's "removing members" terminology and operates on relationship linkage, not whole resources.

- 55f8920: Add `Resource.extend` for subtyping resources, plus accessors for extracting a resource's attributes and relationships.

  ### `Resource.extend` — subtype an existing resource

  `Resource.extend(Base, type, options?)` defines a new resource that inherits the base's attributes and relationships, to which `options` adds more (keys present in `options` override the base's). JSON:API has no native subtyping, so the result is a _distinct_ resource type — its own `type` tag and branded id, with payloads and documents derived afresh — that shares the base's structure. Handy when several resources carry a common set of attributes/relationships defined once. `meta` is inherited from the base unless overridden.

  ```ts
  const Account = Resource.make("accounts", {
    attributes: {
      email: Schema.NonEmptyString,
      createdAt: Schema.DateFromString,
    },
    relationships: { organisation: Relationship.one(() => Organisation) },
  });

  // `admins` inherits email, createdAt and organisation, adding `permissions`.
  const Admin = Resource.extend(Account, "admins", {
    attributes: { permissions: Schema.Array(Schema.String) },
  });
  ```

  ### Extracting attributes and relationships
  - `Resource.attributes(resource)` returns the attribute field map the resource was defined with; spread it into another resource's `attributes` to reuse its schemas.
  - `Resource.relationships(resource)` returns the relationship descriptor record.
  - Type-level counterparts `Resource.AttributesOf<R>` and `Resource.RelationshipsOf<R>`, plus `Resource.ExtendedAttributes` / `Resource.ExtendedRelationships` describing the merge `extend` performs.

## 0.1.0

### Minor Changes

- 0ed140d: Add helpers for the JSON:API atomic operations extension (https://jsonapi.org/ext/atomic/), plus the base-spec lid (local id) concepts they build on.

  ### Lids as a first-class Resource concept
  - Every resource definition now derives `localIdentifier` (the `{ type, lid }` schema) and `lidRef(lid)` (typed local-identifier values), alongside the existing `identifier` / `ref(id)`.
  - `Resource.LocalIdentifier`, `Resource.Ref` (id-or-lid identifier union) and `Resource.RefValue` are exported from the Resource module.
  - The new standalone Lid module provides handler-side lid resolution: `Lid.make()` tracks the server-assigned ids of lid-created resources and resolves lid-based refs (including inside relationship linkage) back to typed identifiers; `Lid.UnknownLidError` signals refs to lids no operation declared.

  ### `Endpoint.operations` — the endpoint

  `Endpoint.operations([Article, Comment], options?)` builds a `POST /operations` endpoint whose payload is an `atomic:operations` document and whose success is a 200 `atomic:results` document. The operation union — resource add/update/remove, relationship operations, and lid-based refs — is derived from the resource definitions, like everything else in the library.

  Operations respect the relationship kinds: `add` operations require `one` relationships and exclude `paginated` ones (mirroring create payloads); `one` relationship updates can never be `null` while `optional` ones can; `many` and `paginated` relationships are managed through `add` / `update` / `remove` relationship operations.

  ### `Atomic` — schemas, constructors and handler helpers
  - **Discoverable operation derivation**: `Atomic.operationsFor(Article)` returns a named record of every operation derived for a resource — `add`, `update`, `remove`, and per-relationship operations by kind (`relationships.author.update`, `relationships.comments.add` / `update` / `remove`). The request document union is built from this record.
  - **Document schemas**: `RequestDocument`, `ResultDocument`, `Operations`, plus the building blocks (`AddOperation`, `UpdateOperation`, `RemoveOperation`, relationship operations, `ResourceRef` / `RelationshipRef`).
  - **Client-side constructors**: `Atomic.request`, `Atomic.add`, `Atomic.update`, `Atomic.remove`, `Atomic.updateRelationship`, `Atomic.addToRelationship`, `Atomic.removeFromRelationship` — typed operation values that encode to the spec's wire format.
  - **Handler-side helpers**: `Atomic.results` / `Atomic.result` / `Atomic.emptyResult` for building `atomic:results` documents; `Atomic.targetsResource` / `Atomic.targetsRelationship` / `Atomic.isRelationshipOperation` type guards that narrow the operation union to fully typed `data` / `ref` — dual data-first/curried APIs, so they drop into Effect's `Match` module (`Match.when(Atomic.targetsResource(Article), ...)`); `Atomic.operationPointer` for error sources.
  - **Constants**: `Atomic.EXTENSION_URI`, `Atomic.MEDIA_TYPE`, `Atomic.jsonapi`.

  ### Content negotiation: `ext` / `profile` media type parameters

  The middleware now implements JSON:API v1.1 §5 precisely: only media type parameters _other than_ `ext` / `profile` (or `ext` parameters carrying unsupported extension URIs) are rejected with 415/406. Previously any parameter was rejected, which also rejected spec-legal `profile` parameters.

  `Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] })` configures the supported extension URIs; `Middleware.layer` is unchanged (no extensions). The `contentTypeIsAcceptable` / `acceptIsAcceptable` predicates accept an optional `NegotiationOptions` argument.

  Atomic operations responses carry the extension media type (`application/vnd.api+json;ext="https://jsonapi.org/ext/atomic"`); requests are accepted with or without the `ext` parameter.

- 32dcaee: Clean-slate redesign: spec-compliant JSON:API v1.1 on Effect v4's HttpApi, by construction.

  The library is rebuilt around a resource-centric model in which a single definition is the source
  of truth and everything else — identifiers, payloads, documents, query parameters, endpoints,
  errors and middleware — is derived from it. Following the conventions of `effect` and
  `@effect/platform`, each module is exported as a namespace from the package root:

  ```ts
  import {
    ApiError,
    Atomic,
    Client,
    Document,
    Endpoint,
    Group,
    Handlers,
    Lid,
    Middleware,
    Query,
    Relationship,
    Resource,
  } from "@thomasfosterau/effect-jsonapi";
  ```

  ### Resources (`Resource.make`, `Relationship.one` / `optional` / `many` / `paginated`)
  - `Resource.make(type, { attributes, relationships?, meta? })` returns the resource object
    `Schema.Struct` augmented with derived members: `Id` (branded per-type id), `identifier`,
    `createPayload` (no `id`, optional `lid`), `updatePayload` (`id` required, partial attributes),
    `document()` and `collection()` (compound `included` union derived from the relationship graph).
  - Relationships reference other resource definitions through lazy thunks
    (`Relationship.one(() => Person)`) instead of strings — typos are compile errors and the
    relationship graph is walkable at runtime.

  ### Errors (`ApiError.make`)
  - One declaration produces a tagged Effect error class **and** its wire schema: a spec-compliant
    JSON:API error document at the declared HTTP status. No more hand-written
    `toDocument` / `fromDocument` round-trips.
  - Standard errors are predefined: `ApiError.BadRequest` (400), `ApiError.Forbidden` (403),
    `ApiError.NotAcceptable` (406), `ApiError.Conflict` (409), `ApiError.UnsupportedMediaType` (415).

  ### Endpoints & groups (`Endpoint.*`, `Group.make`)
  - `Endpoint.fetch` / `list` / `create` / `update` / `remove` adopt HttpApi's structured options
    model and bake in the JSON:API conventions: conventional paths, `application/vnd.api+json`,
    spec status codes (200/201/204), error documents, and typed query parameters.
  - `Endpoint.search` builds heterogeneous collection endpoints (search, feeds): `data` is a mixed
    array of several resource types discriminated by their `type` tags, with query features
    (`fields[TYPE]`, `include`, `sort`) derived across all of the searched resources.
    `Group.make` accepts a plain string name for groups that span resource types.
  - All constructors return plain `HttpApiEndpoint` / `HttpApiGroup` values — they compose with
    vanilla `HttpApi`, `HttpApiBuilder`, `HttpApiClient`, `HttpApiTest` and `OpenApi`.

  ### Typed query parameters (`Query.schema`, `Query.Page`)
  - First-class schemas for the spec's query families: `include` (literal paths derived from the
    relationship graph, 2 hops), `fields[TYPE]` (closed per-type attribute sets), `sort` (typed
    fields + direction), `page[*]` (`Query.Page.Offset` / `Query.Page.Number` / `Query.Page.Cursor`
    / custom), `filter[*]` (user-defined).
  - Flat bracket-keyed strings on the wire; ergonomic nested typed values in handlers; invalid
    values become spec-compliant 400 error documents.

  ### Client-side include narrowing (`Client.narrowIncluded`)
  - Narrows a response document's `included` member to exactly the resources reachable via the
    include paths the client requested (`["author"]` → `included: ReadonlyArray<Person>`), justified
    by the spec's "MUST NOT include unrequested resource objects" rule. Pure type-level operation;
    works with `HttpApiClient` and `HttpApiTest` clients.
  - `Resource.IncludePath<R>` / `Resource.IncludedFor<R, Paths>` exported for building custom typed
    client wrappers; `Resource.make(...).ref(id)` creates typed resource-identifier values.

  ### Protocol middleware (`Middleware`)
  - Content negotiation (415/406 per JSON:API §5) and schema-error translation (validation failures
    become JSON:API 400 documents) are `HttpApiMiddleware` services attached to every endpoint —
    the api cannot be built without providing `Middleware.layer`, so compliance cannot be forgotten.

  ### Handler-side document builders (`Handlers.data`, `Handlers.collection`)
  - Build response documents from resources; `included` is deduplicated by `(type, id)` and checked
    for the spec's full-linkage rule; pagination link helpers included.

  ### Packaging
  - The worked example moved out of the published package into `examples/blog`, exercised by an
    end-to-end test suite.
  - Every public symbol of the previous surface is removed or renamed. Pinned to
    `effect@>=4.0.0-beta.84`; Node.js 20+.
