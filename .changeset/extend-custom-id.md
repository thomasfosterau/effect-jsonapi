---
"@thomasfosterau/effect-jsonapi": minor
---

**`Resource.extend` accepts a custom `id` schema.** `extend(base, type, { id })` now mirrors
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
