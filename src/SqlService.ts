/**
 * A {@link ResourceService.Service} over `effect/sql`: one table per
 * resource, a column per attribute and to-one relationship, and a join table
 * per to-many relationship. Published only at
 * `@thomasfosterau/effect-jsonapi/SqlService`, so the root entry point never
 * loads `effect/sql`.
 *
 * @since 0.24.0
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import type * as Filter from "./Filter.js";
import * as Handlers from "./Handlers.js";
import { declarationError } from "./internal/errors.js";
import { render } from "./internal/json.js";
import { type ErasedService, forResource } from "./internal/erasedService.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";
import type * as ResourceService from "./ResourceService.js";

/**
 * Where a to-one relationship is stored: a column of the resource's table
 * holding the target's id. Defaults to the relationship's `key`, or its name.
 *
 * @since 0.24.0
 * @category models
 */
export interface ToOneStorage {
  readonly column: string;
}

/**
 * Where a to-many relationship is stored: a join table with one row per
 * member, `from` holding the resource's id and `to` the member's.
 *
 * @since 0.24.0
 * @category models
 */
export interface ToManyStorage {
  readonly table: string;
  readonly from: string;
  readonly to: string;
}

/**
 * The `WHERE` condition for one custom filter operator (`Filter.operator`):
 * the field's column and the node's decoded value (one literal, or a list
 * for a `list` operator), as a fragment of the client's own `sql` tag.
 *
 * @since 0.24.0
 * @category models
 */
export type CustomCondition = (
  sql: SqlClient.SqlClient,
  column: Statement.Identifier,
  value: Filter.Custom["value"],
) => Statement.Fragment;

/**
 * Options of {@link make}.
 *
 * @since 0.24.0
 * @category models
 */
export interface Options<Res extends ResourceService.Definition, E> {
  /** The resource's table. */
  readonly table: string;
  /** The failure for an id the table does not hold, e.g. the group's 404. */
  readonly notFound: (id: string) => E;
  /** The id column. Defaults to `id`. */
  readonly id?: string;
  /**
   * Column names by attribute. An attribute not named here is stored under
   * its `sqlColumn` annotation, or else its own key.
   */
  readonly columns?: { readonly [K in keyof Res["fields"]["attributes"]["fields"]]?: string };
  /**
   * Storage by relationship. Every inline to-many relationship needs a
   * {@link ToManyStorage}; a to-one relationship defaults to a column.
   */
  readonly relationships?: {
    readonly [K in keyof Res["relationships"]]?: ToOneStorage | ToManyStorage;
  };
  /**
   * The SQL for each custom filter operator the resource's list endpoint
   * declares, by operator name. A `Custom` node with no entry here is a
   * defect.
   */
  readonly operators?: R.ReadonlyRecord<string, CustomCondition>;
}

// A row as a driver answers it.
type Row = R.ReadonlyRecord<string, Schema.Json>;

// An id cell as the id string it stores.
const text = (cell: Schema.Json): string =>
  P.isString(cell) ? cell : P.isNumber(cell) ? cell.toString() : render(cell);
type Identifier = Handlers.ResourceIdentifierValue;

interface Stored extends Handlers.ResourceValue {
  readonly attributes: R.ReadonlyRecord<string, unknown>;
}

// The storage plan a resource and its options resolve to, once.
interface Plan {
  readonly table: string;
  readonly id: string;
  readonly attributes: ReadonlyArray<{
    readonly key: string;
    readonly column: string;
    readonly read: boolean;
    readonly nullable: boolean;
    readonly codec: Schema.Codec<unknown, unknown>;
  }>;
  readonly toOne: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly column: string;
  }>;
  readonly toMany: ReadonlyArray<{ readonly name: string; readonly type: string } & ToManyStorage>;
  readonly paginated: ReadonlyArray<string>;
  readonly operators: R.ReadonlyRecord<string, CustomCondition>;
}

const isToMany = (storage: ToOneStorage | ToManyStorage): storage is ToManyStorage =>
  "table" in storage;

const planOf = <Res extends ResourceService.Definition, E>(
  resource: Res,
  options: Options<Res, E>,
): Plan => {
  // SAFETY: both maps are keyed by the resource's own field names.
  const columns = (options.columns ?? {}) as R.ReadonlyRecord<string, string>;
  const storage = (options.relationships ?? {}) as R.ReadonlyRecord<
    string,
    ToOneStorage | ToManyStorage
  >;
  const relationships = R.toEntries(resource.relationships);
  const toOne = Arr.filter(relationships, ([, descriptor]) => Relationship.isToOne(descriptor));
  const toMany = Arr.filter(
    relationships,
    ([, descriptor]) => Relationship.isToMany(descriptor) && Relationship.isLinkable(descriptor),
  );
  return {
    table: options.table,
    id: options.id ?? "id",
    attributes: Arr.map(Resource.attributeDescriptors(resource), (descriptor) => ({
      key: descriptor.key,
      column:
        columns[descriptor.key] ??
        Option.getOrElse(
          Option.filter(Option.fromUndefinedOr(descriptor.annotations?.sqlColumn), P.isString),
          () => descriptor.key,
        ),
      read: descriptor.resource !== false,
      nullable: descriptor.nullable,
      codec: Schema.toCodecJson(descriptor.schema),
    })),
    toOne: Arr.map(toOne, ([name, descriptor]) => ({
      name,
      type: (descriptor.ref() as { readonly type: string }).type,
      column: Option.match(Option.fromUndefinedOr(storage[name]), {
        onSome: (stored) => (isToMany(stored) ? name : stored.column),
        onNone: () =>
          Option.getOrElse(
            Option.filter(
              (descriptor as { readonly key?: Option.Option<string> }).key ?? Option.none(),
              P.isString,
            ),
            () => name,
          ),
      }),
    })),
    toMany: Arr.map(toMany, ([name, descriptor]) => {
      const stored = Option.filter(Option.fromUndefinedOr(storage[name]), isToMany);
      if (Option.isNone(stored)) {
        throw declarationError(
          `SqlService.make: the to-many relationship "${name}" of "${resource.type}" needs a { table, from, to } in \`relationships\``,
        );
      }
      return { name, type: (descriptor.ref() as { readonly type: string }).type, ...stored.value };
    }),
    paginated: Arr.map(
      Arr.filter(relationships, ([, descriptor]) => !Relationship.isLinkable(descriptor)),
      ([name]) => name,
    ),
    operators: options.operators ?? {},
  };
};

// The column a filter or sort field names: an attribute's, or a to-one
// relationship's (filtered by the target's id).
const columnOf = (plan: Plan, field: string): Option.Option<string> =>
  Option.orElse(
    Option.map(
      Arr.findFirst(plan.attributes, (attribute) => attribute.key === field),
      (attribute) => attribute.column,
    ),
    () =>
      Option.map(
        Arr.findFirst(plan.toOne, (relationship) => relationship.name === field),
        (relationship) => relationship.column,
      ),
  );

const unsupported = (message: string) => Effect.die(declarationError(`SqlService ${message}`));

/**
 * A {@link ResourceService.Service} over the ambient `SqlClient`, for a
 * resource stored in one table. Every attribute is a column holding its JSON
 * encoding (`Schema.toCodecJson`, so a `Date` is an ISO string), every to-one
 * relationship a column holding the target's id, and every inline to-many
 * relationship a join table.
 *
 * `list` translates the endpoint's decoded filter, sort and page into one
 * statement plus a `COUNT(*)`: a filter map compares each field for
 * equality, a `Filter` grammar tree becomes the corresponding `WHERE` (text
 * operators by code point, as the profile says), sort terms become `ORDER BY`
 * with the id as the tie-break, and offset and number pages become `LIMIT` /
 * `OFFSET`. `findMany`, the batch loader `included` resolution calls, is one
 * `WHERE id IN (…)` per level, and each read loads its to-many linkage in one
 * more query. A database failure is a defect (answered 500). A cursor page
 * and a `Relationship.paginated` relationship's members are not yet
 * supported and are defects too, as is a custom filter operator
 * (`Filter.operator`) without SQL in `options.operators`.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert"
 * import { Effect, Schema } from "effect"
 * import { SqliteClient } from "@effect/sql-sqlite-node"
 * import { SqlClient } from "effect/sql"
 * import { Resource } from "@thomasfosterau/effect-jsonapi"
 * import * as SqlService from "@thomasfosterau/effect-jsonapi/SqlService"
 *
 * const Article = Resource.make("articles", { attributes: { title: Schema.String } })
 * class ArticleNotFound extends Schema.TaggedError<ArticleNotFound>()("ArticleNotFound", {
 *   id: Schema.String
 * }) {}
 *
 * const program = Effect.gen(function* () {
 *   const sql = yield* SqlClient.SqlClient
 *   yield* sql`CREATE TABLE articles (id TEXT PRIMARY KEY, title TEXT NOT NULL)`
 *   yield* sql`INSERT INTO articles (id, title) VALUES ('1', 'Hello')`
 *   const articles = yield* SqlService.make(Article, {
 *     table: "articles",
 *     notFound: (id) => new ArticleNotFound({ id })
 *   })
 *   const page = yield* articles.list({ sort: [{ field: "title", direction: "asc" }] })
 *   strictEqual(page.total, 1)
 * }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })))
 *
 * void Effect.runPromise(program)
 * ```
 *
 * @since 0.24.0
 * @category constructors
 */
export const make = <Res extends ResourceService.Definition, E>(
  resource: Res,
  options: Options<Res, E>,
): Effect.Effect<ResourceService.Complete<Res, E>, never, SqlClient.SqlClient> =>
  Effect.map(Effect.service(SqlClient.SqlClient), (sql) => {
    const plan = planOf(resource, options);
    const table = sql(plan.table);
    const idColumn = sql(plan.id);

    // The to-many linkage of each of `ids`, one query per relationship.
    const linkages = (ids: ReadonlyArray<string>) =>
      Effect.forEach(
        plan.toMany,
        (relationship) =>
          Arr.isReadonlyArrayNonEmpty(ids)
            ? Effect.map(
                sql<Row>`SELECT ${sql(relationship.from)} AS "from", ${sql(relationship.to)} AS "to" FROM ${sql(relationship.table)} WHERE ${sql.in(relationship.from, ids)}`,
                (rows): readonly [Plan["toMany"][number], ReadonlyArray<Row>] => [
                  relationship,
                  rows,
                ],
              )
            : Effect.succeed<readonly [Plan["toMany"][number], ReadonlyArray<Row>]>([
                relationship,
                [],
              ]),
        { concurrency: "unbounded" },
      );

    // A row and its to-many rows, as the resource value they store.
    const toValue = (
      row: Row,
      members: ReadonlyArray<readonly [Plan["toMany"][number], ReadonlyArray<Row>]>,
    ) => {
      const id = text(row[plan.id] ?? null);
      return Effect.map(
        Effect.forEach(
          Arr.filter(
            plan.attributes,
            (attribute) =>
              attribute.read && !(P.isNull(row[attribute.column]) && !attribute.nullable),
          ),
          (attribute) =>
            Effect.map(
              Schema.decodeEffect(attribute.codec)(row[attribute.column]),
              (value) => [attribute.key, value] as const,
            ),
          { concurrency: "unbounded" },
        ),
        (attributes): Stored => ({
          type: resource.type,
          id,
          attributes: R.fromEntries(attributes),
          relationships: R.fromEntries([
            ...Arr.map(plan.toOne, (relationship) => {
              const target = row[relationship.column];
              return [
                relationship.name,
                {
                  data:
                    P.isNull(target) || P.isUndefined(target)
                      ? null
                      : { type: relationship.type, id: text(target) },
                },
              ] as const;
            }),
            ...Arr.map(
              members,
              ([relationship, rows]) =>
                [
                  relationship.name,
                  {
                    data: Arr.map(
                      Arr.filter(rows, (member) => text(member.from ?? null) === id),
                      (member): Identifier => ({
                        type: relationship.type,
                        id: text(member.to ?? null),
                      }),
                    ),
                  },
                ] as const,
            ),
            ...Arr.map(
              plan.paginated,
              (name) => [name, Handlers.paginatedRelationship(resource.type, id, name)] as const,
            ),
          ]),
        }),
      );
    };

    const values = (rows: ReadonlyArray<Row>) =>
      Effect.flatMap(linkages(Arr.map(rows, (row) => text(row[plan.id] ?? null))), (members) =>
        Effect.forEach(rows, (row) => toValue(row, members), { concurrency: "unbounded" }),
      );

    const encodeAttribute = <V>(key: string, value: V) =>
      Option.match(
        Arr.findFirst(plan.attributes, (attribute) => attribute.key === key),
        {
          onNone: () => Effect.succeed(Option.none<readonly [string, unknown]>()),
          onSome: (attribute) =>
            Effect.map(
              P.isNull(value)
                ? Effect.succeed(null)
                : Schema.encodeUnknownEffect(attribute.codec)(value),
              (encoded) => Option.some([attribute.column, encoded] as const),
            ),
        },
      );

    // The columns a write's attributes and to-one relationships set.
    const columnsOf = (data: ResourceService.WriteData) =>
      Effect.map(
        Effect.forEach(
          R.toEntries(data.attributes ?? {}),
          ([key, value]) =>
            P.isUndefined(value) ? Effect.succeedNone : encodeAttribute(key, value),
          { concurrency: "unbounded" },
        ),
        (attributes): R.ReadonlyRecord<string, unknown> =>
          R.fromEntries([
            ...Arr.getSomes(attributes),
            ...Arr.getSomes(
              Arr.map(plan.toOne, (relationship) =>
                Option.map(
                  Option.fromUndefinedOr(data.relationships?.[relationship.name]),
                  (member) =>
                    [
                      relationship.column,
                      Option.getOrNull(
                        Option.map(Arr.head(identifiersOf(member.data)), (target) => target.id),
                      ),
                    ] as const,
                ),
              ),
            ),
          ]),
      );

    const replaceMembers = (
      id: string,
      relationship: Plan["toMany"][number],
      members: ReadonlyArray<Identifier>,
    ) =>
      Effect.andThen(
        sql`DELETE FROM ${sql(relationship.table)} WHERE ${sql(relationship.from)} = ${id}`,
        insertMembers(id, relationship, members),
      );

    const insertMembers = (
      id: string,
      relationship: Plan["toMany"][number],
      members: ReadonlyArray<Identifier>,
    ) =>
      Arr.isReadonlyArrayNonEmpty(members)
        ? Effect.asVoid(
            sql`INSERT INTO ${sql(relationship.table)} ${sql.insert(
              Arr.map(members, (member) => ({
                [relationship.from]: id,
                [relationship.to]: member.id,
              })),
            )}`,
          )
        : Effect.void;

    // The to-many members a write's `relationships` replaces.
    const writeMembers = (id: string, data: ResourceService.WriteData) =>
      Effect.forEach(
        plan.toMany,
        (relationship) =>
          Option.match(Option.fromUndefinedOr(data.relationships?.[relationship.name]), {
            onNone: () => Effect.void,
            onSome: (member) => replaceMembers(id, relationship, identifiersOf(member.data)),
          }),
        { concurrency: 1 },
      );

    const rowsById = (ids: ReadonlyArray<string>) =>
      Arr.isReadonlyArrayNonEmpty(ids)
        ? sql<Row>`SELECT * FROM ${table} WHERE ${sql.in(plan.id, ids)}`
        : Effect.succeed([]);

    const find = (id: string): Effect.Effect<Stored, E> =>
      Effect.flatMap(Effect.orDie(Effect.flatMap(rowsById([id]), values)), (found) =>
        Option.match(Arr.head(found), {
          onNone: () => Effect.fail(options.notFound(id)),
          onSome: Effect.succeed,
        }),
      );

    const where = (filter: ResourceService.ListQuery["filter"]) =>
      P.isUndefined(filter) ? Effect.succeed(sql.literal("1=1")) : condition(sql, plan, filter);

    const orderBy = (sort: ResourceService.ListQuery["sort"]) =>
      Effect.map(
        Effect.forEach(
          sort ?? [],
          (term) =>
            Option.match(columnOf(plan, term.field), {
              onNone: () => unsupported(`cannot sort by "${term.field}"`),
              onSome: (column) =>
                Effect.succeed(
                  sql`${sql(column)} ${sql.literal(term.direction === "desc" ? "DESC" : "ASC")}`,
                ),
            }),
          { concurrency: "unbounded" },
        ),
        (terms) => sql.csv("ORDER BY", [...terms, sql`${idColumn} ASC`]),
      );

    const window = (query: ResourceService.ListQuery) => {
      const page = query.page ?? {};
      if (Arr.some(R.values(page), P.isString)) return unsupported("answers only numeric pages");
      const at = (key: string) => Option.filter(Option.fromUndefinedOr(page[key]), P.isNumber);
      const numbered = Option.isSome(at("number")) || Option.isSome(at("size"));
      const limit = numbered ? at("size") : at("limit");
      const offset = numbered
        ? Option.map(at("size"), (size) => (Option.getOrElse(at("number"), () => 1) - 1) * size)
        : at("offset");
      return Effect.succeed(
        Option.match(limit, {
          onNone: () =>
            Option.match(offset, {
              onNone: () => sql.literal(""),
              onSome: (skip) => sql`LIMIT -1 OFFSET ${skip}`,
            }),
          onSome: (take) => sql`LIMIT ${take} OFFSET ${Option.getOrElse(offset, () => 0)}`,
        }),
      );
    };

    const service: Required<ErasedService<E, never>> = {
      find: (id) => find(id),
      findMany: (ids) => Effect.orDie(Effect.flatMap(rowsById(ids), values)),
      list: (query) =>
        Effect.orDie(
          Effect.gen(function* () {
            const filter = yield* where(query.filter);
            const order = yield* orderBy(query.sort);
            const page = yield* window(query);
            const rows = yield* sql<Row>`SELECT * FROM ${table} WHERE ${filter} ${order} ${page}`;
            const [count] = yield* sql<{
              readonly total: number;
            }>`SELECT COUNT(*) AS total FROM ${table} WHERE ${filter}`;
            return { items: yield* values(rows), total: count?.total ?? 0 };
          }),
        ),
      create: (data) =>
        Effect.orDie(
          sql.withTransaction(
            Effect.gen(function* () {
              const columns = yield* columnsOf(data);
              const row = P.isUndefined(data.id) ? columns : { ...columns, [plan.id]: data.id };
              const [inserted] =
                yield* sql<Row>`INSERT INTO ${table} ${sql.insert(row).returning(sql(plan.id))}`;
              const id = text(inserted?.[plan.id] ?? data.id ?? null);
              yield* writeMembers(id, data);
              return id;
            }),
          ),
        ).pipe(Effect.flatMap(find)),
      update: (id, data) =>
        Effect.andThen(
          find(id),
          Effect.orDie(
            sql.withTransaction(
              Effect.gen(function* () {
                const columns = yield* columnsOf(data);
                if (!R.isEmptyRecord(columns)) {
                  yield* sql`UPDATE ${table} SET ${sql.update(columns)} WHERE ${idColumn} = ${id}`;
                }
                yield* writeMembers(id, data);
              }),
            ),
          ),
        ).pipe(Effect.andThen(find(id))),
      delete: (id) =>
        Effect.andThen(
          find(id),
          Effect.orDie(
            sql.withTransaction(
              Effect.andThen(
                Effect.forEach(
                  plan.toMany,
                  (relationship) =>
                    sql`DELETE FROM ${sql(relationship.table)} WHERE ${sql(relationship.from)} = ${id}`,
                  { concurrency: 1 },
                ),
                sql`DELETE FROM ${table} WHERE ${idColumn} = ${id}`,
              ),
            ),
          ),
        ),
      related: (_, name) => unsupported(`does not yet page the relationship "${name}"`),
      setRelationship: (id, name, data) =>
        Effect.andThen(
          find(id),
          Effect.orDie(
            Option.match(
              Arr.findFirst(plan.toMany, (relationship) => relationship.name === name),
              {
                onSome: (relationship) =>
                  Effect.asVoid(
                    sql.withTransaction(replaceMembers(id, relationship, identifiersOf(data))),
                  ),
                onNone: () =>
                  Option.match(
                    Arr.findFirst(plan.toOne, (relationship) => relationship.name === name),
                    {
                      onNone: () => unsupported(`stores no relationship "${name}"`),
                      onSome: (relationship) =>
                        Effect.asVoid(
                          sql`UPDATE ${table} SET ${sql.update({
                            [relationship.column]: Option.getOrNull(
                              Option.map(Arr.head(identifiersOf(data)), (target) => target.id),
                            ),
                          })} WHERE ${idColumn} = ${id}`,
                        ),
                    },
                  ),
              },
            ),
          ),
        ),
      addToRelationship: (id, name, data) =>
        Effect.flatMap(find(id), (value) =>
          Effect.orDie(
            Option.match(
              Arr.findFirst(plan.toMany, (relationship) => relationship.name === name),
              {
                onNone: () => unsupported(`stores no to-many relationship "${name}"`),
                onSome: (relationship) => {
                  const present = identifiersOf(value.relationships?.[name]?.data ?? null);
                  return insertMembers(
                    id,
                    relationship,
                    Arr.dedupeWith(
                      Arr.filter(
                        data,
                        (member) => !Arr.some(present, (linked) => linked.id === member.id),
                      ),
                      (left, right) => left.id === right.id,
                    ),
                  );
                },
              },
            ),
          ),
        ),
      removeFromRelationship: (id, name, data) =>
        Effect.andThen(
          find(id),
          Effect.orDie(
            Option.match(
              Arr.findFirst(plan.toMany, (relationship) => relationship.name === name),
              {
                onNone: () => unsupported(`stores no to-many relationship "${name}"`),
                onSome: (relationship) =>
                  Arr.isReadonlyArrayNonEmpty(data)
                    ? Effect.asVoid(
                        sql`DELETE FROM ${sql(relationship.table)} WHERE ${sql(relationship.from)} = ${id} AND ${sql.in(
                          relationship.to,
                          Arr.map(data, (member) => member.id),
                        )}`,
                      )
                    : Effect.void,
              },
            ),
          ),
        ),
    };
    // The rows decode through the resource's own attribute codecs into the
    // values it describes, and each operation reads its arguments through the
    // resource's own shapes.
    return forResource<Res, E>(service);
  });

const identifiersOf = (linkage: Handlers.LinkageValue): ReadonlyArray<Identifier> =>
  P.isNull(linkage) ? [] : "type" in linkage ? [linkage] : linkage;

// A decoded filter that is the `Filter` grammar's tree, which a field map's
// struct never is: its members are field names, and none is `_tag`.
const isNode = <A>(filter: A): filter is A & Filter.Node => P.hasProperty(filter, "_tag");

// A text operator over `name`, by code point and case-sensitive.
const textMatch = (sql: SqlClient.SqlClient, name: Statement.Identifier, text: Filter.Text) =>
  sql.onDialectOrElse({
    sqlite: () =>
      text.op === "contains"
        ? sql`instr(${name}, ${text.value}) > 0`
        : text.op === "startsWith"
          ? sql`substr(${name}, 1, length(${text.value})) = ${text.value}`
          : sql`(length(${text.value}) = 0 OR substr(${name}, -length(${text.value})) = ${text.value})`,
    orElse: () =>
      text.op === "contains"
        ? sql`strpos(${name}, ${text.value}) > 0`
        : text.op === "startsWith"
          ? sql`left(${name}, length(${text.value})) = ${text.value}`
          : sql`right(${name}, length(${text.value})) = ${text.value}`,
  });

const comparison = {
  eq: "=",
  ne: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
} as const;

// The `WHERE` condition a decoded filter is: a field map's equalities, or a
// `Filter` grammar tree.
const condition = (
  sql: SqlClient.SqlClient,
  plan: Plan,
  filter: R.ReadonlyRecord<string, unknown>,
): Effect.Effect<Statement.Fragment> => {
  const column = (field: string) =>
    Option.match(columnOf(plan, field), {
      onNone: () => unsupported(`cannot filter by "${field}"`),
      onSome: (name) => Effect.succeed(sql(name)),
    });
  // A literal as the column stores it: an attribute's JSON encoding, or a
  // to-one target's id as it is.
  const literal = <V>(field: string, value: V) =>
    Option.match(
      Arr.findFirst(plan.attributes, (attribute) => attribute.key === field),
      {
        onNone: () => Effect.succeed(value),
        onSome: (attribute) => Effect.orDie(Schema.encodeUnknownEffect(attribute.codec)(value)),
      },
    );
  const node = (ast: Filter.Node): Effect.Effect<Statement.Fragment> =>
    Match.valueTags(ast, {
      Compare: (compare) =>
        Effect.flatMap(column(compare.field), (name) =>
          Effect.map(
            literal(compare.field, compare.value),
            (value) => sql`${name} ${sql.literal(comparison[compare.op])} ${value}`,
          ),
        ),
      In: (member) => membership(member.field, member.values, "IN"),
      NotIn: (member) => membership(member.field, member.values, "NOT IN"),
      IsNull: (test) =>
        Effect.map(
          column(test.field),
          (name) => sql`${name} ${sql.literal(test.negated ? "IS NOT NULL" : "IS NULL")}`,
        ),
      // By code point and case-sensitive, as `LIKE` is not.
      Text: (text) => Effect.map(column(text.field), (name) => textMatch(sql, name, text)),
      And: (group) =>
        Effect.map(Effect.forEach(group.members, node, { concurrency: "unbounded" }), (members) =>
          Arr.isReadonlyArrayNonEmpty(members) ? sql.and(members) : sql.literal("1=1"),
        ),
      Or: (group) =>
        Effect.map(Effect.forEach(group.members, node, { concurrency: "unbounded" }), (members) =>
          Arr.isReadonlyArrayNonEmpty(members) ? sql.or(members) : sql.literal("1=0"),
        ),
      Not: (negation) => Effect.map(node(negation.member), (member) => sql`NOT (${member})`),
      Custom: (custom) =>
        Option.match(R.get(plan.operators, custom.op), {
          onNone: () => unsupported(`has no SQL for the custom filter operator "${custom.op}"`),
          onSome: (build) =>
            Effect.map(column(custom.field), (name) => build(sql, name, custom.value)),
        }),
    });
  const membership = <V>(field: string, values: ReadonlyArray<V>, operator: "IN" | "NOT IN") =>
    Effect.flatMap(column(field), (name) =>
      Effect.map(
        Effect.forEach(values, (value) => literal(field, value), { concurrency: "unbounded" }),
        (encoded) => sql`${name} ${sql.literal(operator)} ${sql.in(encoded)}`,
      ),
    );
  return isNode(filter)
    ? node(filter)
    : Effect.map(
        Effect.forEach(
          Arr.filter(R.toEntries(filter), ([, value]) => !P.isUndefined(value)),
          ([field, value]) =>
            Effect.flatMap(column(field), (name) =>
              Effect.map(literal(field, value), (encoded) => sql`${name} = ${encoded}`),
            ),
          { concurrency: "unbounded" },
        ),
        (clauses) => (Arr.isReadonlyArrayNonEmpty(clauses) ? sql.and(clauses) : sql.literal("1=1")),
      );
};
