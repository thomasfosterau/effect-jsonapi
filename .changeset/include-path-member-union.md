---
"@thomasfosterau/effect-jsonapi": patch
---

`Resource.ResolveIncludePath` now distributes over a union of resource definitions and walks each member's includable relationships only, so it no longer crosses one member's `paginated` relationship on a path that is legal for another member (#347). `Resource.IncludedFor`, `Resource.FamilyIncluded` and `Client.narrowIncluded` follow. With `Post.author = Relationship.one(() => Person)` and `Draft.author = Relationship.paginated(() => Revision)`, `Resource.FamilyIncluded<typeof Entries, ["author"]>` is `typeof Person` where it was `typeof Person | typeof Revision`, and the same holds at any later hop. A `paginated` relationship's target never appears in `included`, so the dropped types are ones no compliant response carries. These are now the same types the endpoint documents and `fields: true` derive.

Two other cases change with it. A path segment that only some members declare now reaches the targets of the members that declare it. Before, it reached nothing for the whole union, so `Resource.FamilyIncluded` left out resources the server does send. On a single resource, a path naming a `paginated` relationship, which is never a legal include path, now resolves to `never`.

The change is type-level only. A `switch` on a narrowed `included[].type` with a `case` for a type that can no longer occur, such as `"revisions"` above, is now a compile error (TS2678). Delete that `case`.
