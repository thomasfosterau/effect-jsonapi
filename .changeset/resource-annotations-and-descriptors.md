---
"@thomasfosterau/effect-jsonapi": minor
---

**Resource-level annotations and attribute introspection: `Resource.annotate`, `Resource.annotations`
and `Resource.attributeDescriptors`.** A `Resource.make` definition is the natural single source of
truth for more than the HTTP layer — database columns, form descriptors, search indexes, admin UI —
and two things blocked a library from deriving off one.

**A resource could not carry metadata.** `Resource.make` assembles its result with `Object.assign`,
attaching `Id`, `identifier`, `relationships`, `declaredAttributes`, `createPayload`, `ref`,
`document()` and the rest onto the schema. `Schema.Top#annotate` returns a new schema carrying none
of them, and no longer referentially identical to the original — so `resource.annotate(...)`
destroyed the resource, and third parties resorted to stamping non-enumerable symbol properties onto
the package's objects instead.

`Resource.annotate(resource, annotations)` rebuilds the resource around the annotated schema, so what
comes back is a complete resource: a valid `Relationship.one(() => …)` target, a valid
`Resource.extend` base, identical to the original in every respect but the bag. `Resource.make` takes
the same bag inline via a new `annotations` option, `Resource.annotations(resource)` reads it back,
and `Resource.extend` inherits it with the child's keys winning (and accepts its own `annotations`).
Keys should be namespaced (`"@acme/storage"`), since the bag is shared by every consumer deriving
from the resource.

`Resource.annotate` is a function rather than a mutation, so annotate a resource where it is defined,
before wiring it into a relationship graph — a `Relationship.one(() => Person)` thunk written against
the un-annotated `Person` keeps returning that one.

**An attribute's declared shape was not readable.** `Resource.attribute(schema, { … })` knows by
declaration whether an attribute is optional on the resource projection, nullable, read-only and so
on, but nothing exposed the projected shape, leaving `resource.fields.attributes.ast` behind a cast
through `unknown`, or decode probes against sentinel values, as the only routes.

`Resource.attributeDescriptors(resource)` returns, in declaration order, each attribute's `key`,
`schema`, presence across the three projections (`resource` / `create` / `update`, all three
normalised to `"required" | "optional" | false`), `clearable`, `nullable`, `readOnly` and
`annotations`. It covers the map as declared, like `Resource.declaredAttributes`, so input-only
attributes are included and reported as `resource: false`.

Both are additive; nothing about existing resources changes, and a resource that declares no
annotations is built exactly as before.
