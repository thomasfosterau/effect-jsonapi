/**
 * Type-level tests for #595: a flat group's include surface must not widen
 * its endpoints' decoding services. `Group.flat` / `flatReadOnly` used to infer
 * the documents' `included` from `options.include?.included` while the
 * surface type was still generic, which widened it to `Schema.Top`, whose
 * services are `unknown`; a typed client's methods then required `unknown`.
 *
 * This file is type-checked by the `typecheck` task, never run; the
 * `@ts-expect-error` annotations are the assertions, each paired with its
 * legal form.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { HttpClient } from "effect/http";
import { HttpApi } from "effect/http-api";
import {
  Client,
  FlatQuery,
  Group,
  Handlers,
  Include,
  Registry,
  Relationship,
  Resource,
  ResourceHandlers,
} from "@thomasfosterau/effect-jsonapi";

const WidgetId = Schema.String.pipe(Schema.brand("WidgetId"));
const GadgetId = Schema.String.pipe(Schema.brand("GadgetId"));

// A back-reference typed through a ref interface, as an application with a
// relationship-target registry spells it (preferenceflow's `lazyTarget`).
interface WidgetRef extends Resource.Any {
  readonly type: "widgets";
  readonly identifier: Resource.Identifier<"widgets", typeof WidgetId>;
}
declare const widgetTarget: () => WidgetRef;

const Gadget = Resource.make("gadgets", {
  id: GadgetId,
  attributes: { name: Schema.String },
  relationships: { widgets: Relationship.many(widgetTarget) },
});
const Widget = Resource.make("widgets", {
  id: WidgetId,
  attributes: { name: Schema.String },
  relationships: { maker: Relationship.one(() => Gadget) },
});
const WIDGET_INCLUDE = Include.make(Widget, { maker: Gadget });
const ListWidgets = FlatQuery.listInput({ maxLimit: 100 }, {});

const { group: widgets } = Group.flat({
  resource: Widget,
  create: Schema.Struct({ name: Schema.String }),
  update: Schema.Struct({ id: WidgetId }),
  list: ListWidgets,
  include: WIDGET_INCLUDE,
});
const { group: gadgets } = Group.flatReadOnly({
  resource: Gadget,
  list: ListWidgets,
  include: Include.make(Gadget, { widgets: Widget }),
});
const { group: hidden } = Group.flat({
  resource: Widget,
  create: Schema.Struct({ name: Schema.String }),
  update: Schema.Struct({ id: WidgetId }),
  list: ListWidgets,
  include: WIDGET_INCLUDE,
  hiddenWrites: true,
});

declare const needsService: Schema.Codec<unknown, unknown, "Service">;

// The surface itself needs no services.
const noServices = (_: Schema.Top & { readonly DecodingServices: never }): void => {};
noServices(WIDGET_INCLUDE.included);
// @ts-expect-error -- control: a schema that does need a service is refused
noServices(needsService);

// Every endpoint's success schema decodes without services.
noServices(widgets.endpoints.get["~Success"]);
noServices(widgets.endpoints.list["~Success"]);
noServices(widgets.endpoints.create["~Success"]);
noServices(gadgets.endpoints.get["~Success"]);
noServices(gadgets.endpoints.list["~Success"]);
noServices(hidden.endpoints.update["~Success"]);

// A typed client over the groups requires only `HttpClient`, at `make` and in
// every method.
const Api = HttpApi.make("shop").add(widgets).add(gadgets);
const program = Effect.fn("program")(function* () {
  const client = yield* Client.make(Api, { baseUrl: "http://localhost" });
  yield* client.widgets.get({ params: { id: WidgetId.make("1") }, query: {} });
  yield* client.gadgets.list({ query: { limit: 10, offset: 0 } });
});
export const requirements: Effect.Effect<void, unknown, HttpClient.HttpClient> = program();

// ---------------------------------------------------------------------------
// The handlers satisfy a group whose `included` is the surface's precise union
// ---------------------------------------------------------------------------

// The include registry's loaders return the members' own resource values
// (`satisfies`, so their types stay visible), and the handlers' documents type
// `included` by them: a `Group.flatReadOnly` success with the surface's union
// is then satisfiable without a cast.
const gadgetTargets = {
  widgets: (ids: ReadonlyArray<string>) =>
    Effect.succeed(
      ids.map((id) => Widget.make({ id: WidgetId.make(id), attributes: { name: "w" } })),
    ),
} satisfies Handlers.IncludeTargets;

const GADGET_INCLUDE = Include.make(Gadget, { widgets: Widget });
const gadgetGroup = Group.flatReadOnly({
  resource: Gadget,
  list: ListWidgets,
  include: GADGET_INCLUDE,
});

export const gadgetFamily = {
  group: "gadgets",
  handlers: ResourceHandlers.readOnly({
    segment: "gadgets",
    listQuery: gadgetGroup.listQuery,
    linkBase: Effect.succeed("https://example.test"),
    include: { includable: GADGET_INCLUDE.paths, targets: gadgetTargets },
    ops: {
      list: () => Effect.succeed({ items: [], totalCount: 0 }),
      get: (id: string) =>
        Effect.succeed(Gadget.make({ id: GadgetId.make(id), attributes: { name: "g" } })),
    },
  }),
} satisfies Registry.FamilyFor<typeof gadgetGroup.group>;

// …and so do the CRUD handlers, writes included, over a `Group.flat` with a
// surface.
const widgetTargets = {
  gadgets: (ids: ReadonlyArray<string>) =>
    Effect.succeed(
      ids.map((id) => Gadget.make({ id: GadgetId.make(id), attributes: { name: "g" } })),
    ),
} satisfies Handlers.IncludeTargets;

const widgetGroup = Group.flat({
  resource: Widget,
  create: Schema.Struct({ name: Schema.String }),
  update: Schema.Struct({ id: WidgetId }),
  list: ListWidgets,
  include: WIDGET_INCLUDE,
});

export const widgetFamily = {
  group: "widgets",
  handlers: ResourceHandlers.make({
    segment: "widgets",
    listQuery: widgetGroup.listQuery,
    linkBase: Effect.succeed("https://example.test"),
    include: { includable: WIDGET_INCLUDE.paths, targets: widgetTargets },
    ops: {
      list: () => Effect.succeed({ items: [], totalCount: 0 }),
      get: (id: string) =>
        Effect.succeed(Widget.make({ id: WidgetId.make(id), attributes: { name: "w" } })),
      create: (_input: { readonly name: string }) => Effect.succeed({ id: WidgetId.make("1") }),
      update: (input: { readonly id: string }) => Effect.succeed({ id: input.id }),
      delete: () => Effect.void,
    },
  }),
} satisfies Registry.FamilyFor<typeof widgetGroup.group>;
