---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking:** a relationship descriptor's storage `key` and canonical `order` are `Option`s, no longer `T | undefined` (#626, part of #533).

- `Relationship.one` / `optional` descriptors (`Relationship.One`, `Optional`, `one`, `optional`) carry `key: Option.Option<K>`: `Option.some("authorId")` when a `key` is declared, `Option.none()` when none is. A declared key still infers its literal (`Option<"authorId">`); an undeclared one reads as `Option<never>`.
- `Relationship.paginated` descriptors (`Relationship.Paginated`, `paginated`) carry `order: Option.Option<O>` the same way, with the declared `const` tuple as `O` and `Option<never>` when no order is declared.
- `Relationship.StorageKey` is `string` (it was `string | undefined`), and `Paginated`'s `O` is constrained by `Order<R>` alone. The lowercase annotations default the undeclared parameter to `never`, so `Relationship.one<Comment>` and `Relationship.paginated<Comment>` still name an unkeyed / order-less descriptor. An explicit `undefined` type argument (`Relationship.one<Comment, false, undefined>`, `Relationship.paginated<Comment, undefined>`) is now a constraint error: omit it, or pass `never`.
- The wide forms (`Relationship.One<Any>`, `Optional<Any>`, `Paginated<Any>`, `Descriptor`) still match keyed and unkeyed, ordered and order-less descriptors alike.

The wire schema, the query grammar and the endpoints are unchanged. Migration, for apps that derive storage (a table, a sync engine's node graph) or a default sort from the descriptors:

```ts
import { Option } from "effect";

// before: const column = descriptor.key ?? defaultColumn
const column = Option.getOrElse(descriptor.key, () => defaultColumn);

// before: if (descriptor.order !== undefined) { … descriptor.order … }
if (Option.isSome(descriptor.order)) {
  const terms = descriptor.order.value;
}

// before: descriptor.order?.map(toSql)
const orderBy = Option.map(descriptor.order, (terms) => terms.map(toSql));

// branching on both cases at once
const label = Option.match(descriptor.key, {
  onNone: () => "unkeyed",
  onSome: (key) => `keyed by ${key}`,
});

// to keep the old `string | undefined` shape while migrating
const legacyKey = Option.getOrUndefined(descriptor.key);
```

The `key` and `order` options themselves no longer accept `undefined` (they were typed `K | undefined` through the parameter). Under `exactOptionalPropertyTypes`, `{ key: maybeKey }` / `{ order: maybeOrder }` is a compile error; pass the key only when it is defined:

```ts
// before: Relationship.one(() => Person, { key: maybeKey })
const author =
  maybeKey === undefined
    ? Relationship.one(() => Person)
    : Relationship.one(() => Person, { key: maybeKey });
```
