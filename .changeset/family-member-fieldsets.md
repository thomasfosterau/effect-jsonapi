---
"@thomasfosterau/effect-jsonapi": minor
---

**`fields: true` declares `fields[TYPE]` for each member of a `Resource.family` the response can carry, and the default document makes those members partial (#350).** A family's `type` is its name, never a wire type: what a response carries for a relationship targeting the family are its members, each under its own type. Before, `fields: true` declared only `fields[<family name>]` (say `fields[nodes]`), which matches no resource object, so a client could not trim the members, and `fields[editors]` was a 400 as an undeclared type.

Now, wherever `Query.FieldsetResources` reaches a family (the resource itself, a non-`paginated` direct target, or a resource a legal include path reaches), it also contains the family's members. So:

- `Query.schema(R, { fields: true })` and every read endpoint that declares `fields` (`get`, `list`, `related`, `collection`, `polymorphic`, and those `Endpoint.resource` / `Group.resource` generate) declare `fields[TYPE]` for each member type: the flat wire keys gain `fields[editors]` / `fields[reviewers]`, and the decoded `query.fields` gains `editors?` / `reviewers?`, each closed over that member's own attributes. A request naming one is accepted and handed to the handler, where `Handlers.project(query.fields)` applies it to the members in `included` (or in `data`, for a `related` endpoint whose target is a family). A family reached only through a `paginated` relationship declares nothing, as before.
- The default document of an endpoint declaring `fields` replaces a family in `data` or `included` with the union of its members, each with every attribute optional. A handler can answer with projected members with no cast, and a client reads the members' attributes as optional, where they were required before. Code that read a required member attribute out of such an endpoint's response now gets an optional one; pass `fields: false` (or a strict `success`) to keep the strict document.
- `fields[<family name>]` is still declared and decodes as before, and it still trims nothing.

Endpoints without `fields` are unchanged.
