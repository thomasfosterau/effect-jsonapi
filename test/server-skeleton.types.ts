/**
 * Type-level invariants of the server skeleton:
 *
 * - `Registry.HandlersFor<G>` checks every handler's success channel against
 *   its endpoint's declared `success:` schema — a producer that drifts from
 *   the document its endpoint declares is a compile error, not a silent 500
 *   on encode;
 * - `Group.flat` / `Group.flatReadOnly` hand back a `listQuery` whose decoded
 *   `Type` is the flat list input, so a handler can require "this family's
 *   own list query" and its `list` operation is typed by it.
 */
import { Effect, Schema } from "effect";
import {
  Assemble,
  FlatQuery,
  Group,
  Registry,
  Resource,
  ResourceHandlers,
} from "@thomasfosterau/effect-jsonapi";

/** Pins a value to an expected type without using it (`noUnusedLocals`). */
const assertType = <Expected>(_value: Expected): void => {};

const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } });
type PersonId = typeof Person.Id.Type;
const ListPeople = FlatQuery.listInput({ maxLimit: 100 }, { q: Schema.optionalKey(Schema.String) });
const { group, listQuery } = Group.flat({
  resource: Person,
  list: ListPeople,
  filters: ["q"],
  create: Schema.Struct({ name: Schema.NonEmptyString }),
  update: Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.NonEmptyString) }),
});
// The endpoint declares the *wire* document (string links), which is what the
// assembler produces — a model resource with a `URL` link is not it.
const ada = Assemble.stringifyLinks(
  Person.make({ id: Person.Id.make("1"), attributes: { name: "Ada" } }),
);

// ── listQuery inference ─────────────────────────────────────────────

declare const decoded: typeof listQuery.Type;
// The flat input, unchanged: defaulted cursor, the family's filter, the open include.
assertType<number>(decoded.limit);
assertType<number>(decoded.offset);
assertType<string | undefined>(decoded.q);
assertType<ReadonlyArray<string> | undefined>(decoded.include);
// @ts-expect-error — `sort` is the flat input's, decoded, not a string
assertType<string>(decoded.sort);

// A handler config typed by the family's list query: the `list` op receives
// the decoded shape, inferred from `listQuery` alone.
assertType<Registry.Family>({
  group: "people",
  handlers: ResourceHandlers.readOnly({
    segment: "people",
    listQuery,
    linkBase: Effect.succeed("https://example.test"),
    ops: {
      list: (input) => {
        assertType<string | undefined>(input.q);
        // @ts-expect-error — the input is the flat list type; `nope` is not a member
        assertType<unknown>(input.nope);
        return Effect.succeed({ items: [], totalCount: 0 });
      },
      get: (id: PersonId) => Effect.succeed(Person.make({ id, attributes: { name: "Ada" } })),
    },
  }),
});

// An operation typed by a different list input than the endpoint decodes is refused.
ResourceHandlers.readOnly({
  segment: "people",
  listQuery,
  linkBase: Effect.succeed("https://example.test"),
  ops: {
    // @ts-expect-error — `listQuery` decodes no `owner`; the op's input is not the family's
    list: (input: { readonly owner: string }) => Effect.succeed({ items: [], totalCount: 0 }),
    get: (id: PersonId) => Effect.succeed(Person.make({ id, attributes: { name: "Ada" } })),
  },
});

// A read-only preset infers the same query type from its own list input.
const readOnly = Group.flatReadOnly({ resource: Person, list: ListPeople });
declare const readOnlyDecoded: typeof readOnly.listQuery.Type;
assertType<string | undefined>(readOnlyDecoded.q);
// @ts-expect-error — a filter must name a field of the list input
Group.flatReadOnly({ resource: Person, list: ListPeople, filters: ["nope"] });

// ── HandlersFor success-channel checking ────────────────────────────

type G = typeof group;
declare const document: Registry.EndpointSuccess<G, "get">;
assertType<{ readonly type: "people"; readonly id: string }>(document.data);

// Every handler name the group declares is required, and nothing else.
type Names = Registry.EndpointNames<G>;
assertType<ReadonlyArray<Names>>(["list", "get", "create", "update", "delete"]);
// @ts-expect-error — not an endpoint of the group
assertType<Names>("restore");

// A handler whose success matches the endpoint's document type-checks…
const okFamily = {
  group: "people",
  handlers: {
    list: () => Effect.succeed({ data: [], jsonapi: { version: "1.1" as const } }),
    get: () => Effect.succeed({ data: ada }),
    create: () => Effect.succeed({ data: ada }),
    update: () => Effect.succeed({ data: ada }),
    delete: () => Effect.void,
  },
} satisfies Registry.FamilyFor<G>;
assertType<Registry.Family>(okFamily);

// …and one that answers the wrong document shape does not.
assertType<Registry.FamilyFor<G>>({
  group: "people",
  handlers: {
    ...okFamily.handlers,
    // @ts-expect-error — `data` must be a `people` resource, not a bare string
    get: () => Effect.succeed({ data: "nope" }),
  },
});

// …nor one that names the wrong group or drops an endpoint.
assertType<Registry.FamilyFor<G>>({
  // @ts-expect-error — the group identifier is the resource type
  group: "persons",
  handlers: okFamily.handlers,
});
assertType<Registry.FamilyFor<G>>({
  group: "people",
  // @ts-expect-error — `delete` is missing
  handlers: {
    list: okFamily.handlers.list,
    get: okFamily.handlers.get,
    create: okFamily.handlers.create,
    update: okFamily.handlers.update,
  },
});

// The factory's own handlers satisfy the family check.
assertType<Registry.FamilyFor<G>>({
  group: "people",
  handlers: ResourceHandlers.make({
    segment: "people",
    listQuery,
    linkBase: Effect.succeed("https://example.test"),
    ops: {
      list: () => Effect.succeed({ items: [], totalCount: 0 }),
      get: (id: PersonId) => Effect.succeed(Person.make({ id, attributes: { name: "Ada" } })),
      create: (_input: { readonly name: string }) => Effect.succeed({ id: Person.Id.make("1") }),
      update: (input: { readonly id: PersonId }) => Effect.succeed({ id: input.id }),
      delete: () => Effect.void,
    },
  }),
});

// ── Hidden writes (Group.flat `hiddenWrites`, ResourceHandlers `hiddenWrite`) ──

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.String }) {}
const hidingOps = {
  list: () => Effect.succeed({ items: [], totalCount: 0 }),
  get: (id: PersonId): Effect.Effect<typeof Person.Type, NotFound> =>
    Effect.succeed(Person.make({ id, attributes: { name: "Ada" } })),
  create: (_input: { readonly name: string }) =>
    Effect.succeed({ id: Person.Id.make("1"), version: 1 }),
  update: (input: { readonly id: PersonId }) => Effect.succeed({ id: input.id, version: "v2" }),
  delete: () => Effect.void,
};
const hidingHandlers = ResourceHandlers.make({
  segment: "people",
  listQuery,
  linkBase: Effect.succeed("https://example.test"),
  ops: hidingOps,
  // The rule's error is the operations' own, inferred.
  hiddenWrite: {
    type: "people",
    when: (error) => {
      assertType<NotFound>(error);
      return error instanceof NotFound;
    },
  },
});

// Without the option, a write's success is the full document alone, as before.
declare const created: Registry.EndpointSuccess<G, "create">;
assertType<string>(created.data.attributes.name);

// With it, `create` / `update` also admit the committed identifier document…
const hiding = Group.flat({
  resource: Person,
  list: ListPeople,
  create: Schema.Struct({ name: Schema.NonEmptyString }),
  update: Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.NonEmptyString) }),
  hiddenWrites: true,
});
type H = typeof hiding.group;
declare const hiddenCreated: Registry.EndpointSuccess<H, "create">;
assertType<"people">(hiddenCreated.data.type);
// @ts-expect-error — the success may carry no attributes; narrow on `"attributes" in data` first
assertType<string>(hiddenCreated.data.attributes.name);
// …while `get` keeps the full document: a hidden resource is still a 404 there.
declare const hiddenGot: Registry.EndpointSuccess<H, "get">;
assertType<string>(hiddenGot.data.attributes.name);

// A handler set answering hidden writes satisfies the group that declares them…
assertType<Registry.FamilyFor<H>>({ group: "people", handlers: hidingHandlers });
// …and not one that doesn't, whose writes would fail to encode the identifier document.
// @ts-expect-error — `create` / `update` may answer a document `G` does not declare
assertType<Registry.FamilyFor<G>>({ group: "people", handlers: hidingHandlers });

// The rule's `type` is the resource's own.
ResourceHandlers.make({
  segment: "people",
  listQuery,
  linkBase: Effect.succeed("https://example.test"),
  ops: hidingOps,
  // @ts-expect-error — the committed document names the resource's type
  hiddenWrite: { type: "persons", when: () => true },
});
