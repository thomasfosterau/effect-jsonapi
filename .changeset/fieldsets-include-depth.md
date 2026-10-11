---
"@thomasfosterau/effect-jsonapi": minor
---

**`fields: true` now declares a sparse fieldset for exactly the types the response can carry (#311).** In 0.16.x it declared the resource and every direct relationship target, `paginated` ones included, whatever `include` said. A `fields[TYPE]` for any other type was silently dropped and the request answered 200 with that type untrimmed. So on an endpoint with `include: true`, `GET /articles/1?include=comments.author&fields[people]=name` answered 200 but ignored `fields[people]`, because `people` is a target of `comments`, not of `articles`. JSON:API 1.1 §Sparse Fieldsets: "A client **MAY** request that an endpoint return only specific [fields] in the response on a per-type basis by including a `fields[TYPE]` query parameter." That request now decodes to `{ include: ["comments.author"], fields: { people: ["name"] } }`, and the handler can trim `people`.

What each configuration declares:

- `include` off (absent or `false`): the resource and its non-`paginated` direct relationship targets, the default `included` union, which a server MAY include by default.
- `include: true`, `{ depth }` or `{ paths }`: the same, plus every resource on the way down each legal include path, its leaf included. That is two hops under `include: true`, the `depth` a `Query.IncludeOptions` names, or exactly the listed `paths`; `comments.author.employer` declares `comments`, `people` and `companies`.
- A declared `Include.Surface`: exactly the resource and the types the surface's paths reach, which is its `included` union. A direct target the surface leaves out is not declared.

On a heterogeneous endpoint, every member is declared, and each member walks every path.

**This narrows what 0.16.x accepted.** Two kinds of type that 0.16.x declared are now undeclared:

- a target reachable only through a `paginated` relationship, which is never an include path and never in `included`;
- under a declared `Include.Surface`, a direct target the surface leaves out.

With this release's 400 for an undeclared `fields[TYPE]`, a request naming either is now a 400 naming the parameter in `source.parameter`, where 0.16.x decoded it and answered 200. Such a request was trimming a type the response cannot contain, so a client should stop sending it. A type no legal path reaches, such as one a hop past the deepest path, was never declared and is now that 400 too. A declared type with no attribute gets the empty-vocabulary 400.

The decoded `fields` struct, the flat `fields[TYPE]` keys and `Query.FieldsetResources` all follow the same set. The decoded `fields` loses its keys for the dropped types. `Query.FieldsetResources` takes the endpoint's `include` option as a new, optional second type parameter (`Query.FieldsetResources<typeof Article, true>`). Without it, the type means `include` off, so it no longer lists `paginated`-only targets.
