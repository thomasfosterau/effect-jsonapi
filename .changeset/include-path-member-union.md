---
"@thomasfosterau/effect-jsonapi": minor
---

**`Resource.ResolveIncludePath` now distributes over a union of resource definitions and walks each member's includable relationships only, so it no longer crosses one member's `paginated` relationship on a path that is legal for another member (#347).** `Resource.IncludedFor`, `Resource.FamilyIncluded` and `Client.narrowIncluded` follow. With `Post.author = Relationship.one(() => Person)` and `Draft.author = Relationship.paginated(() => Revision)`, `Resource.FamilyIncluded<typeof Entries, ["author"]>` is `typeof Person` where it was `typeof Person | typeof Revision`, and the same holds at any later hop. A `paginated` relationship's target never appears in `included`, so the dropped types are ones no compliant response carries. These are now the same types the endpoint documents and `fields: true` derive.

The change is type-level only, and it is breaking in three ways:

- **A path segment that only some members declare now reaches the targets of the members that declare it.** Before, it reached nothing for the whole union, so `Resource.FamilyIncluded<typeof Entries, ["author", "editor"]>` left out `editor`'s target, which the server does send. The narrowed union grows: an exhaustive `switch` on a narrowed `included[].type` (a `default` that assigns to `never`) no longer compiles until it handles the added type. This is the one break in code that was sound before.
- **A path naming another member's `paginated` relationship no longer reaches its target**, as above. A `switch` on a narrowed `included[].type` with a `case` for a type that can no longer occur, such as `"revisions"`, is now a compile error (TS2678). Delete that `case`.
- **On a single resource, a path naming a `paginated` relationship now resolves to `never`**, for every direct user of `Resource.ResolveIncludePath`, `Resource.IncludedFor` and `Resource.FamilyIncluded`, not only through `Client.narrowIncluded` (whose `include` argument already rejected such a path). `Resource.IncludedFor<typeof Draft, ["author"]>` was `typeof Revision` and is now `never`. Such a path is never a legal `include`, so no compliant response carries what it named.

A wide path keeps its meaning, minus `paginated` targets: `Resource.ResolveIncludePath<R, string>` and `Resource.IncludedFor<R, ReadonlyArray<string>>` are `R`'s includable direct targets, and ``Resource.ResolveIncludePath<R, `${string}.${string}`>`` adds their includable direct targets, as before.
