/**
 * The flat group presets, pinned against the consuming applications' group
 * factory corpus: the endpoint set each emits, the verbs and paths, the 409
 * on `update` alone, the wire query the endpoints decode, the `listQuery`
 * handed back beside the group, and — the wire contract itself — the exact
 * `METHOD /path -> statuses` list `OpenApi.fromApi` renders, which is what a
 * consuming application's contract snapshot pins.
 */
import { describe, expect, it } from "vite-plus/test";
import { Exit, Schema } from "effect";
import { HttpApi, OpenApi } from "effect/http-api";
import * as Endpoint from "./Endpoint.js";
import * as FlatQuery from "./FlatQuery.js";
import * as Group from "./Group.js";
import * as Include from "./Include.js";
import * as Query from "./Query.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";

const decode = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownSync(schema as unknown as Schema.Codec<S["Type"]>);

/** A built group's endpoints, structurally. */
interface GroupLike {
  readonly identifier: string;
  readonly endpoints: Readonly<Record<string, unknown>>;
}
interface EndpointLike {
  readonly method: string;
  readonly path: string;
  readonly query?: Schema.Top;
  readonly error: ReadonlySet<Schema.Top>;
}
const endpointOf = (group: GroupLike, name: string): EndpointLike => {
  const endpoint = group.endpoints[name];
  if (endpoint === undefined) throw new Error(`no '${name}' endpoint`);
  return endpoint as EndpointLike;
};
const queryOf = (group: GroupLike, name: string): Schema.Top => {
  const query = endpointOf(group, name).query;
  if (query === undefined) throw new Error(`${name} declares no query`);
  return query;
};

const WidgetId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("WidgetId"));
const Gadget = Resource.make("gadgets", { attributes: { name: Schema.String } });
const Widget = Resource.make("widgets", {
  id: WidgetId,
  attributes: { name: Resource.attribute(Schema.String) },
  relationships: { maker: Relationship.one(() => Gadget) },
});
const WIDGET_INCLUDE = Include.make(Widget, { maker: Gadget });

const Create = Schema.Struct({ name: Schema.String });
const Update = Schema.Struct({ id: WidgetId, name: Schema.optionalKey(Schema.String) });
const ListWidgets = FlatQuery.listInput(
  { maxLimit: 100 },
  { owner: Schema.optionalKey(Schema.String) },
);

describe("Group.flat", () => {
  const { group } = Group.flat({
    resource: Widget,
    create: Create,
    update: Update,
    list: ListWidgets,
    include: WIDGET_INCLUDE,
  });

  it("emits exactly the five CRUD endpoints, and no relationship endpoints", () => {
    expect(Object.keys(group.endpoints).toSorted()).toEqual([
      "create",
      "delete",
      "get",
      "list",
      "update",
    ]);
  });

  it("maps the endpoints onto the JSON:API verbs and paths", () => {
    const shape = (name: string) =>
      `${endpointOf(group, name).method} ${endpointOf(group, name).path}`;
    expect(shape("list")).toBe("GET /widgets");
    expect(shape("get")).toBe("GET /widgets/:id");
    expect(shape("create")).toBe("POST /widgets");
    expect(shape("update")).toBe("PATCH /widgets/:id");
    expect(shape("delete")).toBe("DELETE /widgets/:id");
  });

  it("declares the 409 on `update` and nowhere else", () => {
    expect(endpointOf(group, "update").error.size).toBe(1);
    expect(endpointOf(group, "create").error.size).toBe(0);
    expect(endpointOf(group, "delete").error.size).toBe(0);
  });

  it("keeps the family's branded id as the `:id` path param", () => {
    expect(Widget.Id).toBe(WidgetId);
  });
});

describe("Group.flat: hiddenWrites", () => {
  const options = { resource: Widget, create: Create, update: Update, list: ListWidgets };
  const hiding = Group.flat({ ...options, hiddenWrites: true }).group;
  const plain = Group.flat(options).group;
  // SAFETY: every endpoint of a flat group declares exactly one success schema.
  const successOf = (group: GroupLike, name: string) =>
    [
      ...(group.endpoints[name] as { readonly success: ReadonlySet<Schema.Codec<unknown>> })
        .success,
    ][0]!;
  const encode = (group: GroupLike, name: string) =>
    Schema.encodeUnknownExit(successOf(group, name));

  const id = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
  const committed = { data: { type: "widgets", id, meta: { version: 3 } } };
  const full = { data: { type: "widgets", id, attributes: { name: "Sprocket" } } };

  it.each(["create", "update"])("lets %s answer the committed identifier document", (name) => {
    expect(encode(hiding, name)(committed)).toEqual(Exit.succeed(committed));
    expect(decode(successOf(hiding, name))(committed)).toEqual(committed);
  });

  it.each(["create", "update"])("still lets %s answer, and decode, the full document", (name) => {
    expect(encode(hiding, name)(full)).toEqual(Exit.succeed(full));
    expect(decode(successOf(hiding, name))(full)).toEqual(full);
  });

  it("leaves get declaring the full document alone", () => {
    expect(Exit.isFailure(encode(hiding, "get")(committed))).toBe(true);
  });

  it.each(["create", "update", "get"])(
    "leaves %s of a group without the option declaring the full document alone",
    (name) => {
      expect(Exit.isFailure(encode(plain, name)(committed))).toBe(true);
    },
  );
});

describe("Group.flatReadOnly", () => {
  const { group, listQuery } = Group.flatReadOnly({
    resource: Widget,
    list: ListWidgets,
    filters: ["owner"],
    include: WIDGET_INCLUDE,
  });

  it("emits `list` and `get` only", () => {
    expect(Object.keys(group.endpoints).toSorted()).toEqual(["get", "list"]);
  });

  it("decodes the bracket-keyed pagination input, defaulting absent keys", () => {
    const query = queryOf(group, "list");
    expect(decode(query)({})).toEqual({ limit: 50, offset: 0 });
    expect(
      decode(query)({ "page[limit]": "5", "page[offset]": "10", "filter[owner]": "ada" }),
    ).toEqual({
      limit: 5,
      offset: 10,
      owner: "ada",
    });
  });

  it("`get` takes the include parameter and nothing else", () => {
    const query = queryOf(group, "get");
    expect(decode(query)({})).toEqual({});
    expect(decode(query)({ include: "maker" })).toEqual({ include: ["maker"] });
  });

  it("hands back the list query the endpoint decodes with, spelling the same pairs", () => {
    const query = { limit: 5, offset: 10, owner: "ada", include: ["maker"] };
    expect(Query.canonicalPairs(listQuery)(query)).toEqual(
      Query.canonicalPairs(queryOf(group, "list") as Query.FlatQuerySchema)(query),
    );
    expect(Query.canonicalPairs(listQuery)(query)).toEqual([
      ["include", "maker"],
      ["filter[owner]", "ada"],
      ["page[offset]", "10"],
      ["page[limit]", "5"],
    ]);
  });

  it("round-trips a serialised link back through the endpoint", () => {
    const query = { limit: 10, offset: 20, owner: "ada", include: ["maker"] };
    const serialised = Query.serialise(Query.canonicalPairs(listQuery)(query));
    const wire = Object.fromEntries(new URLSearchParams(serialised).entries());
    expect(decode(queryOf(group, "list"))(wire)).toEqual(query);
  });
});

describe("Endpoint.flatRelated", () => {
  it("names the endpoint `related_<key>` at `/:id/<key>`, paginated for a to-many", () => {
    const many = Endpoint.flatRelated({
      key: "items",
      cardinality: "many",
      idSchema: WidgetId,
      target: Gadget,
    });
    expect(many.identifier).toBe("related_items");
    expect(many.path).toBe("/:id/items");
    expect(decode(many.query as Schema.Top)({ "page[limit]": "5" })).toEqual({
      limit: 5,
      offset: 0,
    });
    const one = Endpoint.flatRelated({
      key: "maker",
      cardinality: "one",
      idSchema: WidgetId,
      target: Gadget,
    });
    expect(one.query).toBeUndefined();
    const included = Endpoint.flatRelated({
      key: "maker",
      cardinality: "one",
      idSchema: WidgetId,
      target: Gadget,
      included: Gadget,
    });
    expect(decode(included.query as Schema.Top)({ include: "a,b" })).toEqual({
      include: ["a", "b"],
    });
  });
});

/**
 * The wire contract a consuming application pins: every operation's method,
 * path and declared statuses, rendered through `OpenApi.fromApi` and sorted.
 * The read-only and CRUD lines below are byte-for-byte the lines
 * preferenceflow's `packages/api/tests/contract-snapshot.test.ts` expects of
 * its `readOnlyResourceGroup` / `resourceGroup` families.
 */
describe("the wire contract", () => {
  interface OpenApiPaths {
    readonly paths: Readonly<
      Record<
        string,
        Readonly<Record<string, { readonly responses: Readonly<Record<string, unknown>> }>>
      >
    >;
  }
  const render = (api: unknown): ReadonlyArray<string> => {
    const spec = OpenApi.fromApi(api as never) as unknown as OpenApiPaths;
    return Object.entries(spec.paths)
      .flatMap(([path, operations]) =>
        Object.entries(operations).map(
          ([method, operation]) =>
            `${method.toUpperCase()} ${path} -> ${Object.keys(operation.responses).join(", ")}`,
        ),
      )
      .toSorted();
  };

  it("is exactly the pinned endpoint list (method, path, declared statuses)", () => {
    const Api = HttpApi.make("contract")
      .add(Group.flatReadOnly({ resource: Gadget, list: ListWidgets }).group)
      .add(
        Group.flat({
          resource: Widget,
          list: ListWidgets,
          create: Create,
          update: Update,
          include: WIDGET_INCLUDE,
        }).group,
      );
    expect(render(Api)).toEqual(
      [
        "GET /gadgets -> 200, 400, 406, 415",
        "GET /gadgets/{id} -> 200, 400, 406, 415",
        "DELETE /widgets/{id} -> 204, 400, 406, 415",
        "GET /widgets -> 200, 400, 406, 415",
        "GET /widgets/{id} -> 200, 400, 406, 415",
        "PATCH /widgets/{id} -> 200, 400, 406, 409, 415",
        "POST /widgets -> 201, 400, 406, 415",
      ].toSorted(),
    );
  });

  it("is unchanged in its statuses by hiddenWrites", () => {
    const api = (hiddenWrites: boolean) =>
      HttpApi.make("contract").add(
        Group.flat({
          resource: Widget,
          list: ListWidgets,
          create: Create,
          update: Update,
          hiddenWrites,
        }).group,
      );
    expect(render(api(true))).toEqual(render(api(false)));
  });
});
