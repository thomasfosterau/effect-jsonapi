---
"@thomasfosterau/effect-jsonapi": minor
---

Add **polymorphic resource families** (`Resource.family`) — a supertype over a set of member
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
