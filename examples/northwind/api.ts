/**
 * The Northwind Traders HTTP API: JSON:API endpoints with conventional paths,
 * typed query parameters and JSON:API error documents — composed into a vanilla
 * `HttpApi`.
 *
 * - `categories`, `suppliers`, `shippers`, `territories` are read-only
 *   reference data (fetch + list)
 * - `customers` is read-only, but a customer's orders are reachable through the
 *   `orders` list filter (GET /orders?filter[customer]=<id>)
 * - `products` is full CRUD with offset/limit pagination, typed numeric price
 *   filters and category/supplier reassignment through relationship endpoints.
 *   Its list endpoint doubles as the reverse "products in a category / from a
 *   supplier" lookup via filters
 * - `employees` can be browsed and have their sales territories assigned through
 *   relationship endpoints; the reporting hierarchy is a `filter[manager]` lookup
 * - `orders` can be opened and shipped: creating an order header (201), updating
 *   it (recording the shipped date), assigning a shipper through a relationship
 *   endpoint, and reading the paginated line-item feed with deep includes
 * - `search` is a heterogeneous endpoint across products, customers and
 *   suppliers — a single global catalog search
 */
import { Schema } from "effect";
import { HttpApi } from "effect/http-api";
import { Endpoint, Group, Query } from "@thomasfosterau/effect-jsonapi";
import {
  CategoryNotFound,
  CustomerNotFound,
  EmployeeNotFound,
  OrderNotFound,
  ProductNameTaken,
  ProductNotFound,
  ShipperNotFound,
  SupplierNotFound,
  TerritoryNotFound,
} from "./errors.js";
import {
  Category,
  Customer,
  Employee,
  Order,
  OrderItem,
  Product,
  Shipper,
  Supplier,
  Territory,
} from "./resources.js";

/**
 * Typed collection meta carried by list responses.
 */
export const PageMeta = Schema.Struct({
  total: Schema.Int,
});

/**
 * The decoded type of the typed collection {@link PageMeta}.
 */
export type PageMeta = typeof PageMeta.Type;

/**
 * Offset/limit pagination capped at 100 rows — a shared DoS guard.
 *
 * `Query.Page.offset(...)` is the bounded, configurable variant of the
 * `Query.Page.Offset` constant; defining it once and reusing it keeps the cap
 * (and the `page[offset]` / `page[limit]` keys) consistent across every
 * paginated endpoint, so the input and the emitted pagination links can't drift.
 */
export const Pagination = Query.Page.offset({ maxLimit: 100 });

// ---------------------------------------------------------------------------
// Paginated query schemas
// ---------------------------------------------------------------------------
//
// Each paginated endpoint's query schema is built once, here, and shared with
// its handler, which spells the pagination links from it:
// `Handlers.offsetPaginationLinks(path, page, total, { query:
// Query.canonicalPairs(CategoriesQuery)(query) })`. A link's query and the
// query the endpoint decodes then come from one schema, so `next` is the same
// `sort` / `filter` / `include` / `fields` on the next page. A list endpoint
// takes the schema as its `query`; the related, relationship and search
// endpoints take no `query` override, so they are handed the same options
// object the schema is built from and derive the identical schema.

const categoriesQueryOptions = {
  sort: ["name"],
  page: Pagination,
} as const;
/** The query `GET /categories` decodes. */
export const CategoriesQuery = Query.schema(Category, categoriesQueryOptions);

const suppliersQueryOptions = {
  sort: ["companyName", "country"],
  page: Pagination,
  filter: {
    country: Schema.optionalKey(Schema.String),
  },
} as const;
/** The query `GET /suppliers` decodes. */
export const SuppliersQuery = Query.schema(Supplier, suppliersQueryOptions);

const shippersQueryOptions = {
  sort: ["companyName"],
  page: Pagination,
} as const;
/** The query `GET /shippers` decodes. */
export const ShippersQuery = Query.schema(Shipper, shippersQueryOptions);

const territoriesQueryOptions = {
  sort: ["description", "region"],
  page: Pagination,
  filter: {
    region: Schema.optionalKey(Schema.String),
  },
} as const;
/** The query `GET /territories` decodes. */
export const TerritoriesQuery = Query.schema(Territory, territoriesQueryOptions);

const customersQueryOptions = {
  sort: ["companyName", "country"],
  page: Pagination,
  filter: {
    country: Schema.optionalKey(Schema.String),
  },
} as const;
/** The query `GET /customers` decodes. */
export const CustomersQuery = Query.schema(Customer, customersQueryOptions);

const productsQueryOptions = {
  include: true,
  sort: ["name", "unitPrice", "unitsInStock"],
  page: Pagination,
  filter: {
    category: Schema.optionalKey(Schema.String),
    supplier: Schema.optionalKey(Schema.String),
    discontinued: Schema.optionalKey(Schema.Literals(["true", "false"])),
    minPrice: Schema.optionalKey(Schema.FiniteFromString),
    maxPrice: Schema.optionalKey(Schema.FiniteFromString),
  },
} as const;
/** The query `GET /products` decodes. */
export const ProductsQuery = Query.schema(Product, productsQueryOptions);

const employeesQueryOptions = {
  include: true,
  sort: ["lastName", "hireDate"],
  page: Pagination,
  filter: {
    manager: Schema.optionalKey(Schema.String),
  },
} as const;
/** The query `GET /employees` decodes. */
export const EmployeesQuery = Query.schema(Employee, employeesQueryOptions);

const ordersQueryOptions = {
  include: true,
  sort: ["orderDate", "requiredDate", "freight"],
  page: Pagination,
  filter: {
    customer: Schema.optionalKey(Schema.String),
    employee: Schema.optionalKey(Schema.String),
    shipped: Schema.optionalKey(Schema.Literals(["true", "false"])),
    country: Schema.optionalKey(Schema.String),
  },
} as const;
/** The query `GET /orders` decodes. */
export const OrdersQuery = Query.schema(Order, ordersQueryOptions);

const orderLineItemsQueryOptions = { include: true, page: Pagination } as const;
/** The query `GET /orders/:id/lineItems` decodes. */
export const OrderLineItemsQuery = Query.schema(OrderItem, orderLineItemsQueryOptions);

const orderLineItemsRelationshipQueryOptions = { page: Pagination } as const;
/** The query `GET /orders/:id/relationships/lineItems` decodes. */
export const OrderLineItemsRelationshipQuery = Query.schema(
  OrderItem,
  orderLineItemsRelationshipQueryOptions,
);

const searchResources = [Product, Customer, Supplier] as const;
const searchQueryOptions = {
  filter: { q: Schema.String },
  include: true,
  fields: true,
  page: Pagination,
} as const;
/** The query `GET /search` decodes. */
export const SearchQuery = Query.schema(searchResources, searchQueryOptions);

export const categories = Group.make(
  Category,
  // GET /categories/:id
  Endpoint.get(Category, {
    errors: [CategoryNotFound],
  }),
  // GET /categories?sort=name&page[offset]=0&page[limit]=10
  Endpoint.list(Category, {
    ...categoriesQueryOptions,
    query: CategoriesQuery,
    meta: PageMeta,
  }),
);

export const suppliers = Group.make(
  Supplier,
  // GET /suppliers/:id
  Endpoint.get(Supplier, {
    errors: [SupplierNotFound],
  }),
  // GET /suppliers?filter[country]=UK&sort=companyName
  Endpoint.list(Supplier, {
    ...suppliersQueryOptions,
    query: SuppliersQuery,
    meta: PageMeta,
  }),
);

export const shippers = Group.make(
  Shipper,
  // GET /shippers/:id
  Endpoint.get(Shipper, {
    errors: [ShipperNotFound],
  }),
  // GET /shippers
  Endpoint.list(Shipper, {
    ...shippersQueryOptions,
    query: ShippersQuery,
    meta: PageMeta,
  }),
);

export const territories = Group.make(
  Territory,
  // GET /territories/:id
  Endpoint.get(Territory, {
    errors: [TerritoryNotFound],
  }),
  // GET /territories?filter[region]=Eastern
  Endpoint.list(Territory, {
    ...territoriesQueryOptions,
    query: TerritoriesQuery,
    meta: PageMeta,
  }),
);

export const customers = Group.make(
  Customer,
  // GET /customers/:id
  Endpoint.get(Customer, {
    errors: [CustomerNotFound],
  }),
  // GET /customers?filter[country]=Germany&sort=companyName
  Endpoint.list(Customer, {
    ...customersQueryOptions,
    query: CustomersQuery,
    meta: PageMeta,
  }),
);

export const products = Group.make(
  Product,
  // GET /products/:id?include=category,supplier&fields[products]=name,unitPrice
  Endpoint.get(Product, {
    include: true,
    fields: true,
    errors: [ProductNotFound],
  }),
  // GET /products?filter[category]=1&filter[minPrice]=10&filter[maxPrice]=50&sort=-unitPrice
  // Numeric filters decode from the query string into `number`s; this list
  // endpoint also serves the reverse "products in a category / from a supplier"
  // lookups via filter[category] / filter[supplier].
  Endpoint.list(Product, {
    ...productsQueryOptions,
    query: ProductsQuery,
    meta: PageMeta,
  }),
  // POST /products → 201 (category and supplier are required relationships)
  Endpoint.create(Product, {
    errors: [ProductNameTaken, CategoryNotFound, SupplierNotFound],
  }),
  // PATCH /products/:id (partial attributes — e.g. mark discontinued)
  Endpoint.update(Product, {
    errors: [ProductNotFound],
  }),
  // DELETE /products/:id → 204
  Endpoint.delete(Product, {
    errors: [ProductNotFound],
  }),
  // GET /products/:id/supplier — the supplying company, as a full resource
  Endpoint.related(Product, "supplier", {
    errors: [ProductNotFound],
  }),
  // PATCH /products/:id/relationships/category — reassign the category
  Endpoint.updateRelationship(Product, "category", {
    errors: [ProductNotFound, CategoryNotFound],
  }),
  // PATCH /products/:id/relationships/supplier — reassign the supplier
  Endpoint.updateRelationship(Product, "supplier", {
    errors: [ProductNotFound, SupplierNotFound],
  }),
);

export const employees = Group.make(
  Employee,
  // GET /employees/:id?include=territories
  Endpoint.get(Employee, {
    include: true,
    errors: [EmployeeNotFound],
  }),
  // GET /employees?filter[manager]=2 — an employee's direct reports
  Endpoint.list(Employee, {
    ...employeesQueryOptions,
    query: EmployeesQuery,
    meta: PageMeta,
  }),
  // --- Relationship (linkage) endpoints: territory assignment -----------------
  // GET /employees/:id/relationships/territories — territory identifiers
  Endpoint.getRelationship(Employee, "territories", {
    errors: [EmployeeNotFound],
  }),
  // PATCH /employees/:id/relationships/territories — replace the full set
  Endpoint.updateRelationship(Employee, "territories", {
    errors: [EmployeeNotFound, TerritoryNotFound],
  }),
  // POST /employees/:id/relationships/territories — assign territories
  Endpoint.addRelationship(Employee, "territories", {
    errors: [EmployeeNotFound, TerritoryNotFound],
  }),
  // DELETE /employees/:id/relationships/territories → 204 — unassign territories
  Endpoint.removeRelationship(Employee, "territories", {
    errors: [EmployeeNotFound],
  }),
);

export const orders = Group.make(
  Order,
  // GET /orders/:id?include=customer,employee.territories,shipper
  Endpoint.get(Order, {
    include: true,
    fields: true,
    errors: [OrderNotFound],
  }),
  // GET /orders?filter[customer]=1&filter[shipped]=false&sort=-orderDate
  Endpoint.list(Order, {
    ...ordersQueryOptions,
    query: OrdersQuery,
    meta: PageMeta,
  }),
  // POST /orders → 201 (customer and employee are required relationships)
  Endpoint.create(Order, {
    errors: [CustomerNotFound, EmployeeNotFound],
  }),
  // PATCH /orders/:id — record the shipped date, adjust freight, etc.
  Endpoint.update(Order, {
    errors: [OrderNotFound],
  }),
  // --- Related resource endpoint ----------------------------------------------
  // GET /orders/:id/lineItems?page[offset]=0&page[limit]=10&include=product.category —
  // the paginated line-item feed the `lineItems` relationship's related link
  // points at, with the line item's product (and, a hop further, its category
  // or supplier) brought in as a compound document
  Endpoint.related(Order, "lineItems", {
    ...orderLineItemsQueryOptions,
    meta: PageMeta,
    errors: [OrderNotFound],
  }),
  // --- Relationship (linkage) endpoints ---------------------------------------
  // GET /orders/:id/relationships/lineItems?page[offset]=0&page[limit]=10 —
  // line-item identifiers, paginated: what the `lineItems` relationship's
  // `self` link points at
  Endpoint.getRelationship(Order, "lineItems", {
    ...orderLineItemsRelationshipQueryOptions,
    errors: [OrderNotFound],
  }),
  // GET /orders/:id/relationships/shipper — the shipper identifier (or null)
  Endpoint.getRelationship(Order, "shipper", {
    errors: [OrderNotFound],
  }),
  // PATCH /orders/:id/relationships/shipper — assign ({ data: identifier }) or
  // clear ({ data: null }) the shipper
  Endpoint.updateRelationship(Order, "shipper", {
    errors: [OrderNotFound, ShipperNotFound],
  }),
);

/**
 * Global catalog search: a heterogeneous collection of products, customers and
 * suppliers, discriminated by their `type` tags.
 */
export const search = Group.make(
  "search",
  // GET /search?filter[q]=chai&include=category&page[offset]=0&page[limit]=10
  Endpoint.collection(searchResources, {
    ...searchQueryOptions,
    name: "search",
    path: "/search",
    meta: PageMeta,
  }),
);

export const Api = HttpApi.make("northwind")
  .add(categories)
  .add(suppliers)
  .add(shippers)
  .add(territories)
  .add(customers)
  .add(products)
  .add(employees)
  .add(orders)
  .add(search);
