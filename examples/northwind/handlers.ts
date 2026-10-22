/**
 * The Northwind Traders API's handlers: vanilla `HttpApiBuilder.group`
 * implementations backed by an in-memory store, using the JSON:API document
 * builders.
 *
 * Handlers receive fully-decoded, typed requests:
 *   - `params.id` is the resource's branded id
 *   - `query.include` / `query.fields` / `query.sort` / `query.page` /
 *     `query.filter` are typed
 *   - `payload.data.attributes` is the typed create/update payload
 *   - relationship endpoints receive typed linkage payloads
 *
 * and return document values (`Handlers.data` / `Handlers.collection` /
 * `Handlers.linkage`), which are validated against the endpoint's document
 * schema on the way out. Each of those documents advertises the JSON:API
 * version it implements (`jsonapi: Document.v1_1`); the `ApiError` error
 * documents carry no `jsonapi` member. The reads that declare `fields` —
 * `GET /products/:id`, `GET /orders/:id` and `/search` — answer
 * `?fields[TYPE]=` by projecting each resource they carry, primary data and
 * `included` alike, with `onResource: Handlers.project(query.fields)`; the
 * other reads declare no `fields`, so their clients read every attribute as
 * required.
 */
import { Effect, Iterable, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Document, Handlers, Middleware } from "@thomasfosterau/effect-jsonapi";
import { Api } from "./api.js";
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
 * Drops every `undefined` member of a payload's `attributes`. In-process — and
 * over codec transports that preserve it — an explicit `undefined` is accepted
 * for an optional attribute, but the resource's own schema takes the key
 * absent, and under `exactOptionalPropertyTypes` the two spell differently.
 */
const definedAttributes = <A extends Record<string, unknown>>(
  attributes: A,
): { readonly [K in keyof A]: Exclude<A[K], undefined> } =>
  Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined)) as {
    readonly [K in keyof A]: Exclude<A[K], undefined>;
  };

/**
 * Applies a PATCH's `attributes` over the current ones. An absent member —
 * or, in-process, an explicit `undefined` — leaves the current value; a plain
 * spread would type the result as possibly-`undefined`.
 */
const patchAttributes = <A extends Record<string, unknown>>(
  current: A,
  patch: { readonly [K in keyof A]?: A[K] | undefined } | undefined,
): A => ({ ...current, ...definedAttributes(patch ?? {}) });

// ---------------------------------------------------------------------------
// In-memory store — a slice of the classic Northwind dataset
// ---------------------------------------------------------------------------

export const beverages: Category = Category.make({
  id: Category.Id.make("1"),
  attributes: { name: "Beverages", description: "Soft drinks, coffees, teas, beers and ales" },
});

export const condiments: Category = Category.make({
  id: Category.Id.make("2"),
  attributes: {
    name: "Condiments",
    description: "Sweet and savory sauces, relishes, spreads and seasonings",
  },
});

export const seafood: Category = Category.make({
  id: Category.Id.make("3"),
  attributes: { name: "Seafood", description: "Seaweed and fish" },
});

export const exotic: Supplier = Supplier.make({
  id: Supplier.Id.make("1"),
  attributes: {
    companyName: "Exotic Liquids",
    contactName: "Charlotte Cooper",
    country: "UK",
    city: "London",
  },
});

export const tokyo: Supplier = Supplier.make({
  id: Supplier.Id.make("2"),
  attributes: {
    companyName: "Tokyo Traders",
    contactName: "Yoshi Nagase",
    country: "Japan",
    city: "Tokyo",
  },
});

export const grandma: Supplier = Supplier.make({
  id: Supplier.Id.make("3"),
  attributes: {
    companyName: "Grandma Kelly's Homestead",
    contactName: "Regina Murphy",
    country: "USA",
    city: "Ann Arbor",
  },
});

export const speedy: Shipper = Shipper.make({
  id: Shipper.Id.make("1"),
  attributes: { companyName: "Speedy Express", phone: "(503) 555-9831" },
});

export const united: Shipper = Shipper.make({
  id: Shipper.Id.make("2"),
  attributes: { companyName: "United Package", phone: "(503) 555-3199" },
});

export const federal: Shipper = Shipper.make({
  id: Shipper.Id.make("3"),
  attributes: { companyName: "Federal Shipping", phone: "(503) 555-9931" },
});

export const alfreds: Customer = Customer.make({
  id: Customer.Id.make("1"),
  attributes: {
    companyName: "Alfreds Futterkiste",
    contactName: "Maria Anders",
    country: "Germany",
    city: "Berlin",
  },
});

export const aroundHorn: Customer = Customer.make({
  id: Customer.Id.make("2"),
  attributes: {
    companyName: "Around the Horn",
    contactName: "Thomas Hardy",
    country: "UK",
    city: "London",
  },
});

export const bottomDollar: Customer = Customer.make({
  id: Customer.Id.make("3"),
  attributes: {
    companyName: "Bottom-Dollar Markets",
    contactName: "Elizabeth Lincoln",
    country: "Canada",
    city: "Tsawassen",
  },
});

export const westboro: Territory = Territory.make({
  id: Territory.Id.make("01581"),
  attributes: { description: "Westboro", region: "Eastern" },
});

export const boston: Territory = Territory.make({
  id: Territory.Id.make("02116"),
  attributes: { description: "Boston", region: "Eastern" },
});

export const santaMonica: Territory = Territory.make({
  id: Territory.Id.make("90405"),
  attributes: { description: "Santa Monica", region: "Western" },
});

// Andrew is VP of Sales (no manager); Nancy, Janet and Margaret report to him.
export const andrew: Employee = Employee.make({
  id: Employee.Id.make("2"),
  attributes: {
    firstName: "Andrew",
    lastName: "Fuller",
    title: "Vice President, Sales",
    hireDate: new Date("1992-08-14T00:00:00.000Z"),
  },
  relationships: { territories: { data: [Territory.ref(santaMonica.id)] } },
});

export const nancy: Employee = Employee.make({
  id: Employee.Id.make("1"),
  attributes: {
    firstName: "Nancy",
    lastName: "Davolio",
    title: "Sales Representative",
    hireDate: new Date("1992-05-01T00:00:00.000Z"),
    managerId: andrew.id,
  },
  relationships: { territories: { data: [Territory.ref(westboro.id), Territory.ref(boston.id)] } },
});

export const janet: Employee = Employee.make({
  id: Employee.Id.make("3"),
  attributes: {
    firstName: "Janet",
    lastName: "Leverling",
    title: "Sales Representative",
    hireDate: new Date("1992-04-01T00:00:00.000Z"),
    managerId: andrew.id,
  },
  relationships: { territories: { data: [] } },
});

export const margaret: Employee = Employee.make({
  id: Employee.Id.make("4"),
  attributes: {
    firstName: "Margaret",
    lastName: "Peacock",
    title: "Sales Representative",
    hireDate: new Date("1993-05-03T00:00:00.000Z"),
    managerId: andrew.id,
  },
  relationships: { territories: { data: [] } },
});

export const chai: Product = Product.make({
  id: Product.Id.make("1"),
  attributes: { name: "Chai", unitPrice: 18, unitsInStock: 39, discontinued: false },
  relationships: {
    category: { data: Category.ref(beverages.id) },
    supplier: { data: Supplier.ref(exotic.id) },
  },
});

export const chang: Product = Product.make({
  id: Product.Id.make("2"),
  attributes: { name: "Chang", unitPrice: 19, unitsInStock: 17, discontinued: false },
  relationships: {
    category: { data: Category.ref(beverages.id) },
    supplier: { data: Supplier.ref(exotic.id) },
  },
});

export const aniseed: Product = Product.make({
  id: Product.Id.make("3"),
  attributes: { name: "Aniseed Syrup", unitPrice: 10, unitsInStock: 13, discontinued: false },
  relationships: {
    category: { data: Category.ref(condiments.id) },
    supplier: { data: Supplier.ref(exotic.id) },
  },
});

export const konbu: Product = Product.make({
  id: Product.Id.make("4"),
  attributes: { name: "Konbu", unitPrice: 6, unitsInStock: 24, discontinued: false },
  relationships: {
    category: { data: Category.ref(seafood.id) },
    supplier: { data: Supplier.ref(tokyo.id) },
  },
});

export const gumbo: Product = Product.make({
  id: Product.Id.make("5"),
  attributes: {
    name: "Chef Anton's Gumbo Mix",
    unitPrice: 21.35,
    unitsInStock: 0,
    discontinued: true,
  },
  relationships: {
    category: { data: Category.ref(condiments.id) },
    supplier: { data: Supplier.ref(grandma.id) },
  },
});

// The relationship object of an order's paginated line-item feed: links only,
// no inline data.
const orderLineItems = (orderId: string) =>
  Handlers.paginatedRelationship("orders", orderId, "lineItems");

export const order10248: Order = Order.make({
  id: Order.Id.make("10248"),
  attributes: {
    orderDate: new Date("1996-07-04T00:00:00.000Z"),
    requiredDate: new Date("1996-08-01T00:00:00.000Z"),
    shippedDate: new Date("1996-07-16T00:00:00.000Z"),
    freight: 32.38,
    shipCity: "Berlin",
    shipCountry: "Germany",
  },
  relationships: {
    customer: { data: Customer.ref(alfreds.id) },
    employee: { data: Employee.ref(nancy.id) },
    shipper: { data: Shipper.ref(speedy.id) },
    lineItems: orderLineItems("10248"),
  },
});

export const order10249: Order = Order.make({
  id: Order.Id.make("10249"),
  attributes: {
    orderDate: new Date("1996-07-05T00:00:00.000Z"),
    requiredDate: new Date("1996-08-16T00:00:00.000Z"),
    // not yet shipped: no shippedDate, no shipper
    freight: 11.61,
    shipCity: "London",
    shipCountry: "UK",
  },
  relationships: {
    customer: { data: Customer.ref(aroundHorn.id) },
    employee: { data: Employee.ref(janet.id) },
    shipper: { data: null },
    lineItems: orderLineItems("10249"),
  },
});

export const order10250: Order = Order.make({
  id: Order.Id.make("10250"),
  attributes: {
    orderDate: new Date("1996-07-08T00:00:00.000Z"),
    requiredDate: new Date("1996-08-05T00:00:00.000Z"),
    shippedDate: new Date("1996-07-12T00:00:00.000Z"),
    freight: 65.83,
    shipCity: "Tsawassen",
    shipCountry: "Canada",
  },
  relationships: {
    customer: { data: Customer.ref(bottomDollar.id) },
    employee: { data: Employee.ref(andrew.id) },
    shipper: { data: Shipper.ref(united.id) },
    lineItems: orderLineItems("10250"),
  },
});

export const lineItems: ReadonlyArray<OrderItem> = [
  OrderItem.make({
    id: OrderItem.Id.make("1"),
    attributes: { unitPrice: 18, quantity: 12, discount: 0 },
    relationships: { product: { data: Product.ref(chai.id) } },
  }),
  OrderItem.make({
    id: OrderItem.Id.make("2"),
    attributes: { unitPrice: 6, quantity: 10, discount: 0.05 },
    relationships: { product: { data: Product.ref(konbu.id) } },
  }),
  OrderItem.make({
    id: OrderItem.Id.make("3"),
    attributes: { unitPrice: 19, quantity: 5, discount: 0 },
    relationships: { product: { data: Product.ref(chang.id) } },
  }),
];

const store = {
  categories: new Map<string, Category>([beverages, condiments, seafood].map((c) => [c.id, c])),
  suppliers: new Map<string, Supplier>([exotic, tokyo, grandma].map((s) => [s.id, s])),
  shippers: new Map<string, Shipper>([speedy, united, federal].map((s) => [s.id, s])),
  customers: new Map<string, Customer>([alfreds, aroundHorn, bottomDollar].map((c) => [c.id, c])),
  territories: new Map<string, Territory>([westboro, boston, santaMonica].map((t) => [t.id, t])),
  employees: new Map<string, Employee>([nancy, andrew, janet, margaret].map((e) => [e.id, e])),
  products: new Map<string, Product>([chai, chang, aniseed, konbu, gumbo].map((p) => [p.id, p])),
  orders: new Map<string, Order>([order10248, order10249, order10250].map((o) => [o.id, o])),
  orderItems: new Map<string, OrderItem>(lineItems.map((item) => [item.id, item])),
  // The paginated line-item feed is backed by its own index, not by inline
  // linkage on the order.
  itemsByOrder: new Map<string, Array<string>>([
    [order10248.id, ["1", "2"]],
    [order10249.id, ["3"]],
    [order10250.id, []],
  ]),
};

const loadCategory = (id: string): Effect.Effect<Category, CategoryNotFound> => {
  const category = store.categories.get(id);
  return category === undefined
    ? Effect.fail(new CategoryNotFound({ id }))
    : Effect.succeed(category);
};

const loadSupplier = (id: string): Effect.Effect<Supplier, SupplierNotFound> => {
  const supplier = store.suppliers.get(id);
  return supplier === undefined
    ? Effect.fail(new SupplierNotFound({ id }))
    : Effect.succeed(supplier);
};

const loadShipper = (id: string): Effect.Effect<Shipper, ShipperNotFound> => {
  const shipper = store.shippers.get(id);
  return shipper === undefined ? Effect.fail(new ShipperNotFound({ id })) : Effect.succeed(shipper);
};

const loadCustomer = (id: string): Effect.Effect<Customer, CustomerNotFound> => {
  const customer = store.customers.get(id);
  return customer === undefined
    ? Effect.fail(new CustomerNotFound({ id }))
    : Effect.succeed(customer);
};

const loadTerritory = (id: string): Effect.Effect<Territory, TerritoryNotFound> => {
  const territory = store.territories.get(id);
  return territory === undefined
    ? Effect.fail(new TerritoryNotFound({ id }))
    : Effect.succeed(territory);
};

const loadEmployee = (id: string): Effect.Effect<Employee, EmployeeNotFound> => {
  const employee = store.employees.get(id);
  return employee === undefined
    ? Effect.fail(new EmployeeNotFound({ id }))
    : Effect.succeed(employee);
};

// The employee, once every territory `refs` names is known — checked in order,
// so the first unknown one is the one reported.
const withKnownTerritories = (
  id: string,
  refs: ReadonlyArray<{ readonly id: string }>,
): Effect.Effect<Employee, EmployeeNotFound | TerritoryNotFound> =>
  loadEmployee(id).pipe(
    Effect.tap(() => Effect.forEach(refs, (ref) => loadTerritory(ref.id), { concurrency: 1 })),
  );

/**
 * Removes a product outright, bypassing the API — the cleanup a conformance
 * run's write fixture hands back (`test/conformance.test.ts`).
 */
export const discardProduct = (id: string): Effect.Effect<void> =>
  Effect.sync(() => {
    store.products.delete(id);
  });

/**
 * Removes an order outright, bypassing the API — orders have no DELETE
 * endpoint, so this is the only way a conformance run's created orders go.
 */
export const discardOrder = (id: string): Effect.Effect<void> =>
  Effect.sync(() => {
    store.orders.delete(id);
    store.itemsByOrder.delete(id);
  });

const loadProduct = (id: string): Effect.Effect<Product, ProductNotFound> => {
  const product = store.products.get(id);
  return product === undefined ? Effect.fail(new ProductNotFound({ id })) : Effect.succeed(product);
};

const loadOrder = (id: string): Effect.Effect<Order, OrderNotFound> => {
  const order = store.orders.get(id);
  return order === undefined ? Effect.fail(new OrderNotFound({ id })) : Effect.succeed(order);
};

// ---------------------------------------------------------------------------
// Include resolution & shared helpers
// ---------------------------------------------------------------------------

// `?include=` is resolved by `Handlers.resolveIncluded`, which walks every
// requested path to its last segment — `employee.territories` on an order,
// `product.supplier` on a line item — loading each level in one batch per type
// and contributing each `(type, id)` once across the whole primary set. All it
// needs is one loader per resource type the paths can reach; over this
// in-memory store, a loader is a lookup in that type's table.
const loadFrom =
  <A extends Handlers.ResourceValue>(table: ReadonlyMap<string, A>): Handlers.IncludeTarget<A> =>
  (ids) =>
    Effect.succeed(
      ids.flatMap((id) => {
        const resource = table.get(id);
        return resource === undefined ? [] : [resource];
      }),
    );

// One registry per primary type, holding exactly the types its include paths
// reach — so the resolved `included` stays within the union the endpoint's
// document schema declares for it.

// products → category, supplier (also the products in `/search` results)
const productTargets = {
  categories: loadFrom(store.categories),
  suppliers: loadFrom(store.suppliers),
} satisfies Handlers.IncludeTargets;

// employees → territories
const employeeTargets = {
  territories: loadFrom(store.territories),
} satisfies Handlers.IncludeTargets;

// orders → customer, employee, employee.territories, shipper (`lineItems` is
// paginated, so it is not an include path)
const orderTargets = {
  customers: loadFrom(store.customers),
  employees: loadFrom(store.employees),
  territories: loadFrom(store.territories),
  shippers: loadFrom(store.shippers),
} satisfies Handlers.IncludeTargets;

// line items → product, product.category, product.supplier
const orderItemTargets = {
  products: loadFrom(store.products),
  categories: loadFrom(store.categories),
  suppliers: loadFrom(store.suppliers),
} satisfies Handlers.IncludeTargets;

// Apply `?sort=` terms (already decoded to `{ field, direction }`) in order.
const sortBy = <A extends { readonly attributes: any }>(
  items: Array<A>,
  sort: ReadonlyArray<{ readonly field: string; readonly direction: "asc" | "desc" }> | undefined,
): Array<A> => {
  for (const term of [...(sort ?? [])].reverse()) {
    const direction = term.direction === "desc" ? -1 : 1;
    items.sort((a, b) => {
      const left = a.attributes[term.field];
      const right = b.attributes[term.field];
      return (left < right ? -1 : left > right ? 1 : 0) * direction;
    });
  }
  return items;
};

// Apply `?page[offset]=&page[limit]=` pagination.
const paginate = <A>(
  items: ReadonlyArray<A>,
  page: { readonly offset?: number; readonly limit?: number } | undefined,
): {
  readonly page: ReadonlyArray<A>;
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
} => {
  const total = items.length;
  const offset = page?.offset ?? 0;
  const limit = page?.limit ?? Math.max(total, 1);
  return { page: items.slice(offset, offset + limit), total, offset, limit };
};

const matches = (haystack: ReadonlyArray<string | undefined>, needle: string): boolean =>
  haystack.some(
    (value) => value !== undefined && value.toLowerCase().includes(needle.toLowerCase()),
  );

// ---------------------------------------------------------------------------
// Reference data: categories, suppliers, shippers, territories, customers
// ---------------------------------------------------------------------------

export const CategoriesLive = HttpApiBuilder.group(Api, "categories", (handlers) =>
  handlers
    .handle("get", ({ params }) =>
      loadCategory(params.id).pipe(
        Effect.map((category) =>
          Handlers.data(category, { self: `/categories/${category.id}`, jsonapi: Document.v1_1 }),
        ),
      ),
    )
    .handle("list", ({ query }) => {
      const categories = sortBy([...store.categories.values()], query.sort);
      const { limit, offset, page, total } = paginate(categories, query.page);
      return Effect.succeed(
        Handlers.collection(page, {
          meta: { total },
          links: Handlers.offsetPaginationLinks("/categories", { offset, limit }, total),
          jsonapi: Document.v1_1,
        }),
      );
    }),
);

export const SuppliersLive = HttpApiBuilder.group(Api, "suppliers", (handlers) =>
  handlers
    .handle("get", ({ params }) =>
      loadSupplier(params.id).pipe(
        Effect.map((supplier) =>
          Handlers.data(supplier, { self: `/suppliers/${supplier.id}`, jsonapi: Document.v1_1 }),
        ),
      ),
    )
    .handle("list", ({ query }) => {
      let suppliers = [...store.suppliers.values()];
      const country = query.filter?.country;
      if (country !== undefined) {
        suppliers = suppliers.filter((supplier) => supplier.attributes.country === country);
      }
      sortBy(suppliers, query.sort);
      const { limit, offset, page, total } = paginate(suppliers, query.page);
      return Effect.succeed(
        Handlers.collection(page, {
          meta: { total },
          links: Handlers.offsetPaginationLinks("/suppliers", { offset, limit }, total),
          jsonapi: Document.v1_1,
        }),
      );
    }),
);

export const ShippersLive = HttpApiBuilder.group(Api, "shippers", (handlers) =>
  handlers
    .handle("get", ({ params }) =>
      loadShipper(params.id).pipe(
        Effect.map((shipper) =>
          Handlers.data(shipper, { self: `/shippers/${shipper.id}`, jsonapi: Document.v1_1 }),
        ),
      ),
    )
    .handle("list", ({ query }) => {
      const shippers = sortBy([...store.shippers.values()], query.sort);
      const { limit, offset, page, total } = paginate(shippers, query.page);
      return Effect.succeed(
        Handlers.collection(page, {
          meta: { total },
          links: Handlers.offsetPaginationLinks("/shippers", { offset, limit }, total),
          jsonapi: Document.v1_1,
        }),
      );
    }),
);

export const TerritoriesLive = HttpApiBuilder.group(Api, "territories", (handlers) =>
  handlers
    .handle("get", ({ params }) =>
      loadTerritory(params.id).pipe(
        Effect.map((territory) =>
          Handlers.data(territory, {
            self: `/territories/${territory.id}`,
            jsonapi: Document.v1_1,
          }),
        ),
      ),
    )
    .handle("list", ({ query }) => {
      let territories = [...store.territories.values()];
      const region = query.filter?.region;
      if (region !== undefined) {
        territories = territories.filter((territory) => territory.attributes.region === region);
      }
      sortBy(territories, query.sort);
      const { limit, offset, page, total } = paginate(territories, query.page);
      return Effect.succeed(
        Handlers.collection(page, {
          meta: { total },
          links: Handlers.offsetPaginationLinks("/territories", { offset, limit }, total),
          jsonapi: Document.v1_1,
        }),
      );
    }),
);

export const CustomersLive = HttpApiBuilder.group(Api, "customers", (handlers) =>
  handlers
    .handle("get", ({ params }) =>
      loadCustomer(params.id).pipe(
        Effect.map((customer) =>
          Handlers.data(customer, { self: `/customers/${customer.id}`, jsonapi: Document.v1_1 }),
        ),
      ),
    )
    .handle("list", ({ query }) => {
      let customers = [...store.customers.values()];
      const country = query.filter?.country;
      if (country !== undefined) {
        customers = customers.filter((customer) => customer.attributes.country === country);
      }
      sortBy(customers, query.sort);
      const { limit, offset, page, total } = paginate(customers, query.page);
      return Effect.succeed(
        Handlers.collection(page, {
          meta: { total },
          links: Handlers.offsetPaginationLinks("/customers", { offset, limit }, total),
          jsonapi: Document.v1_1,
        }),
      );
    }),
);

// ---------------------------------------------------------------------------
// Products — full CRUD, the catalog's reverse lookups, reassignment
// ---------------------------------------------------------------------------

export const ProductsLive = HttpApiBuilder.group(Api, "products", (handlers) =>
  handlers
    .handle("get", ({ params, query }) =>
      Effect.gen(function* () {
        const product = yield* loadProduct(params.id);
        const included = yield* Handlers.resolveIncluded(product, query.include, productTargets);
        return Handlers.data(product, {
          included,
          self: `/products/${product.id}`,
          onResource: Handlers.project(query.fields),
          jsonapi: Document.v1_1,
        });
      }),
    )
    .handle("list", ({ query }) => {
      let products = [...store.products.values()];

      // filter[category]=<category id> — a category's products
      const category = query.filter?.category;
      if (category !== undefined) {
        products = products.filter(
          (product) => product.relationships!.category.data.id === category,
        );
      }
      // filter[supplier]=<supplier id> — a supplier's products
      const supplier = query.filter?.supplier;
      if (supplier !== undefined) {
        products = products.filter(
          (product) => product.relationships!.supplier.data.id === supplier,
        );
      }
      // filter[discontinued]=true|false
      const discontinued = query.filter?.discontinued;
      if (discontinued !== undefined) {
        products = products.filter(
          (product) => product.attributes.discontinued === (discontinued === "true"),
        );
      }
      // filter[minPrice]= / filter[maxPrice]= — decoded from the query string to numbers
      const minPrice = query.filter?.minPrice;
      if (minPrice !== undefined) {
        products = products.filter((product) => product.attributes.unitPrice >= minPrice);
      }
      const maxPrice = query.filter?.maxPrice;
      if (maxPrice !== undefined) {
        products = products.filter((product) => product.attributes.unitPrice <= maxPrice);
      }

      sortBy(products, query.sort);
      const { limit, offset, page, total } = paginate(products, query.page);

      return Handlers.resolveIncluded(page, query.include, productTargets).pipe(
        Effect.map((included) =>
          Handlers.collection(page, {
            included,
            meta: { total },
            links: Handlers.offsetPaginationLinks("/products", { offset, limit }, total),
            jsonapi: Document.v1_1,
          }),
        ),
      );
    })
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const name = payload.data.attributes.name;
        if (Iterable.some(store.products.values(), (existing) => existing.attributes.name === name))
          return yield* Effect.fail(new ProductNameTaken({ name }));
        // `category` and `supplier` are required (`one`) relationships — the
        // payload always carries them, and both targets must exist.
        yield* loadCategory(payload.data.relationships.category.data.id);
        yield* loadSupplier(payload.data.relationships.supplier.data.id);
        const product = Product.make({
          id: Product.Id.make(`${store.products.size + 1}`),
          attributes: definedAttributes(payload.data.attributes),
          relationships: payload.data.relationships,
        });
        store.products.set(product.id, product);
        // The created resource carries its own `self` link: the 201's `Location`
        // header is copied from it, so the two match.
        const self = `/products/${product.id}`;
        return Handlers.data({ ...product, links: { self } }, { self, jsonapi: Document.v1_1 });
      }),
    )
    .handle("update", ({ params, payload }) =>
      loadProduct(params.id).pipe(
        Effect.map((product) => {
          const updated = Product.make({
            ...product,
            attributes: patchAttributes(product.attributes, payload.data.attributes),
            relationships: {
              category: payload.data.relationships?.category ?? product.relationships!.category,
              supplier: payload.data.relationships?.supplier ?? product.relationships!.supplier,
            },
          });
          store.products.set(updated.id, updated);
          return Handlers.data(updated, {
            self: `/products/${updated.id}`,
            jsonapi: Document.v1_1,
          });
        }),
      ),
    )
    .handle("delete", ({ params }) =>
      loadProduct(params.id).pipe(
        Effect.map((product) => {
          store.products.delete(product.id);
        }),
      ),
    )
    // GET /products/:id/supplier — the supplying company as a full resource
    .handle("supplier", ({ params }) =>
      loadProduct(params.id).pipe(
        Effect.map((product) => {
          const supplier = store.suppliers.get(product.relationships!.supplier.data.id) ?? null;
          return Handlers.data(supplier, {
            self: Handlers.relatedLink("products", product.id, "supplier"),
            jsonapi: Document.v1_1,
          });
        }),
      ),
    )
    // PATCH /products/:id/relationships/category — reassign the category
    .handle("updateCategoryRelationship", ({ params, payload }) =>
      loadProduct(params.id).pipe(
        Effect.flatMap((product) =>
          loadCategory(payload.data.id).pipe(
            Effect.map(() => {
              const updated = Product.make({
                ...product,
                relationships: { ...product.relationships!, category: { data: payload.data } },
              });
              store.products.set(updated.id, updated);
              return Handlers.linkage(payload.data, {
                self: Handlers.relationshipLink("products", product.id, "category"),
                jsonapi: Document.v1_1,
              });
            }),
          ),
        ),
      ),
    )
    // PATCH /products/:id/relationships/supplier — reassign the supplier
    .handle("updateSupplierRelationship", ({ params, payload }) =>
      loadProduct(params.id).pipe(
        Effect.flatMap((product) =>
          loadSupplier(payload.data.id).pipe(
            Effect.map(() => {
              const updated = Product.make({
                ...product,
                relationships: { ...product.relationships!, supplier: { data: payload.data } },
              });
              store.products.set(updated.id, updated);
              return Handlers.linkage(payload.data, {
                self: Handlers.relationshipLink("products", product.id, "supplier"),
                jsonapi: Document.v1_1,
              });
            }),
          ),
        ),
      ),
    ),
);

// ---------------------------------------------------------------------------
// Employees — browsing, the reporting hierarchy, territory assignment
// ---------------------------------------------------------------------------

export const EmployeesLive = HttpApiBuilder.group(Api, "employees", (handlers) =>
  handlers
    .handle("get", ({ params, query }) =>
      Effect.gen(function* () {
        const employee = yield* loadEmployee(params.id);
        const included = yield* Handlers.resolveIncluded(employee, query.include, employeeTargets);
        return Handlers.data(employee, {
          included,
          self: `/employees/${employee.id}`,
          jsonapi: Document.v1_1,
        });
      }),
    )
    .handle("list", ({ query }) => {
      let employees = [...store.employees.values()];
      // filter[manager]=<employee id> — an employee's direct reports
      const manager = query.filter?.manager;
      if (manager !== undefined) {
        employees = employees.filter((employee) => employee.attributes.managerId === manager);
      }
      sortBy(employees, query.sort);
      const { limit, offset, page, total } = paginate(employees, query.page);
      return Handlers.resolveIncluded(page, query.include, employeeTargets).pipe(
        Effect.map((included) =>
          Handlers.collection(page, {
            included,
            meta: { total },
            links: Handlers.offsetPaginationLinks("/employees", { offset, limit }, total),
            jsonapi: Document.v1_1,
          }),
        ),
      );
    })
    // GET /employees/:id/relationships/territories
    .handle("territoriesRelationship", ({ params }) =>
      loadEmployee(params.id).pipe(
        Effect.map((employee) =>
          Handlers.linkage(employee.relationships?.territories.data ?? [], {
            self: Handlers.relationshipLink("employees", employee.id, "territories"),
            related: Handlers.relatedLink("employees", employee.id, "territories"),
            jsonapi: Document.v1_1,
          }),
        ),
      ),
    )
    // PATCH /employees/:id/relationships/territories — replace the full set
    .handle("updateTerritoriesRelationship", ({ params, payload }) =>
      // every territory in the replacement set must exist
      withKnownTerritories(params.id, payload.data).pipe(
        Effect.map((employee) => {
          const updated = Employee.make({
            ...employee,
            relationships: { ...employee.relationships!, territories: { data: payload.data } },
          });
          store.employees.set(updated.id, updated);
          return Handlers.linkage(payload.data, {
            self: Handlers.relationshipLink("employees", employee.id, "territories"),
            jsonapi: Document.v1_1,
          });
        }),
      ),
    )
    // POST /employees/:id/relationships/territories — assign territories
    .handle("addTerritoriesRelationship", ({ params, payload }) =>
      withKnownTerritories(params.id, payload.data).pipe(
        Effect.map((employee) => {
          const existing = employee.relationships?.territories.data ?? [];
          const known = new Set<string>(existing.map((ref) => ref.id));
          const added = [...existing, ...payload.data.filter((ref) => !known.has(ref.id))];
          const updated = Employee.make({
            ...employee,
            relationships: { ...employee.relationships!, territories: { data: added } },
          });
          store.employees.set(updated.id, updated);
          return Handlers.linkage(added, {
            self: Handlers.relationshipLink("employees", employee.id, "territories"),
            jsonapi: Document.v1_1,
          });
        }),
      ),
    )
    // DELETE /employees/:id/relationships/territories → 204 — unassign territories
    .handle("removeTerritoriesRelationship", ({ params, payload }) =>
      loadEmployee(params.id).pipe(
        Effect.map((employee) => {
          const remove = new Set<string>(payload.data.map((ref) => ref.id));
          const remaining = (employee.relationships?.territories.data ?? []).filter(
            (ref) => !remove.has(ref.id),
          );
          const updated = Employee.make({
            ...employee,
            relationships: { ...employee.relationships!, territories: { data: remaining } },
          });
          store.employees.set(updated.id, updated);
        }),
      ),
    ),
);

// ---------------------------------------------------------------------------
// Orders — opening, shipping, the line-item feed
// ---------------------------------------------------------------------------

// The line items attached to an order, via the relationship index.
const itemsFor = (orderId: string): Array<OrderItem> =>
  (store.itemsByOrder.get(orderId) ?? []).flatMap((itemId) => {
    const item = store.orderItems.get(itemId);
    return item === undefined ? [] : [item];
  });

export const OrdersLive = HttpApiBuilder.group(Api, "orders", (handlers) =>
  handlers
    .handle("get", ({ params, query }) =>
      Effect.gen(function* () {
        const order = yield* loadOrder(params.id);
        const included = yield* Handlers.resolveIncluded(order, query.include, orderTargets);
        return Handlers.data(order, {
          included,
          self: `/orders/${order.id}`,
          onResource: Handlers.project(query.fields),
          jsonapi: Document.v1_1,
        });
      }),
    )
    .handle("list", ({ query }) => {
      let orders = [...store.orders.values()];

      // filter[customer]=<customer id> — a customer's orders
      const customer = query.filter?.customer;
      if (customer !== undefined) {
        orders = orders.filter((order) => order.relationships!.customer.data.id === customer);
      }
      // filter[employee]=<employee id> — an employee's orders
      const employee = query.filter?.employee;
      if (employee !== undefined) {
        orders = orders.filter((order) => order.relationships!.employee.data.id === employee);
      }
      // filter[shipped]=true|false — has the order shipped?
      const shipped = query.filter?.shipped;
      if (shipped !== undefined) {
        orders = orders.filter(
          (order) => (order.attributes.shippedDate !== undefined) === (shipped === "true"),
        );
      }
      // filter[country]=<ship country>
      const country = query.filter?.country;
      if (country !== undefined) {
        orders = orders.filter((order) => order.attributes.shipCountry === country);
      }

      sortBy(orders, query.sort);
      const { limit, offset, page, total } = paginate(orders, query.page);

      return Handlers.resolveIncluded(page, query.include, orderTargets).pipe(
        Effect.map((included) =>
          Handlers.collection(page, {
            included,
            meta: { total },
            links: Handlers.offsetPaginationLinks("/orders", { offset, limit }, total),
            jsonapi: Document.v1_1,
          }),
        ),
      );
    })
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        // `customer` and `employee` are required (`one`) relationships — the
        // payload always carries them, and both must exist.
        yield* loadCustomer(payload.data.relationships.customer.data.id);
        yield* loadEmployee(payload.data.relationships.employee.data.id);
        const id = Order.Id.make(`${10248 + store.orders.size}`);
        const order = Order.make({
          id,
          attributes: definedAttributes(payload.data.attributes),
          relationships: {
            customer: payload.data.relationships.customer,
            employee: payload.data.relationships.employee,
            // shipper is optional in the payload; default to unshipped
            shipper: payload.data.relationships.shipper ?? { data: null },
            // The paginated line-item feed starts empty; only its links exist.
            lineItems: orderLineItems(id),
          },
        });
        store.orders.set(order.id, order);
        store.itemsByOrder.set(order.id, []);
        // The created resource carries its own `self` link: the 201's `Location`
        // header is copied from it, so the two match.
        const self = `/orders/${order.id}`;
        return Handlers.data({ ...order, links: { self } }, { self, jsonapi: Document.v1_1 });
      }),
    )
    .handle("update", ({ params, payload }) =>
      loadOrder(params.id).pipe(
        Effect.map((order) => {
          const relationships = order.relationships!;
          const updated = Order.make({
            ...order,
            attributes: patchAttributes(order.attributes, payload.data.attributes),
            relationships: {
              customer: payload.data.relationships?.customer ?? relationships.customer,
              employee: payload.data.relationships?.employee ?? relationships.employee,
              shipper: payload.data.relationships?.shipper ?? relationships.shipper,
              lineItems: relationships.lineItems,
            },
          });
          store.orders.set(updated.id, updated);
          return Handlers.data(updated, { self: `/orders/${updated.id}`, jsonapi: Document.v1_1 });
        }),
      ),
    )
    // GET /orders/:id/lineItems — the paginated line-item feed, with deep includes
    .handle("lineItems", ({ params, query }) =>
      Effect.gen(function* () {
        const order = yield* loadOrder(params.id);
        const all = itemsFor(order.id);
        const { limit, offset, page, total } = paginate(all, query.page);
        const path = Handlers.relatedLink("orders", order.id, "lineItems");
        const included = yield* Handlers.resolveIncluded(page, query.include, orderItemTargets);
        return Handlers.collection(page, {
          included,
          meta: { total },
          links: Handlers.offsetPaginationLinks(path, { offset, limit }, total),
          jsonapi: Document.v1_1,
        });
      }),
    )
    // GET /orders/:id/relationships/lineItems — the line-item feed's identifiers
    .handle("lineItemsRelationship", ({ params, query }) =>
      loadOrder(params.id).pipe(
        Effect.map((order) => {
          const all = itemsFor(order.id).map((item) => OrderItem.ref(item.id));
          const { limit, offset, page, total } = paginate(all, query.page);
          const path = Handlers.relationshipLink("orders", order.id, "lineItems");
          return Handlers.linkage(page, {
            related: Handlers.relatedLink("orders", order.id, "lineItems"),
            meta: { total },
            links: Handlers.offsetPaginationLinks(path, { offset, limit }, total),
            jsonapi: Document.v1_1,
          });
        }),
      ),
    )
    // GET /orders/:id/relationships/shipper — the shipper identifier (or null)
    .handle("shipperRelationship", ({ params }) =>
      loadOrder(params.id).pipe(
        Effect.map((order) =>
          Handlers.linkage(order.relationships!.shipper.data, {
            self: Handlers.relationshipLink("orders", order.id, "shipper"),
            related: Handlers.relatedLink("orders", order.id, "shipper"),
            jsonapi: Document.v1_1,
          }),
        ),
      ),
    )
    // PATCH /orders/:id/relationships/shipper — assign or clear the shipper
    .handle("updateShipperRelationship", ({ params, payload }) =>
      loadOrder(params.id).pipe(
        Effect.flatMap((order) => {
          const assign =
            payload.data === null ? Effect.void : loadShipper(payload.data.id).pipe(Effect.asVoid);
          return assign.pipe(
            Effect.map(() => {
              const updated = Order.make({
                ...order,
                relationships: { ...order.relationships!, shipper: { data: payload.data } },
              });
              store.orders.set(updated.id, updated);
              return Handlers.linkage(payload.data, {
                self: Handlers.relationshipLink("orders", order.id, "shipper"),
                jsonapi: Document.v1_1,
              });
            }),
          );
        }),
      ),
    ),
);

// ---------------------------------------------------------------------------
// Search — a heterogeneous collection of products, customers and suppliers
// ---------------------------------------------------------------------------

export const SearchLive = HttpApiBuilder.group(Api, "search", (handlers) =>
  handlers.handle("search", ({ query }) => {
    const q = query.filter?.q ?? "";

    // search across all three resource types; results stay discriminated by `type`
    const products = [...store.products.values()].filter((product) =>
      matches([product.attributes.name], q),
    );
    const customers = [...store.customers.values()].filter((customer) =>
      matches([customer.attributes.companyName, customer.attributes.contactName], q),
    );
    const suppliers = [...store.suppliers.values()].filter((supplier) =>
      matches([supplier.attributes.companyName, supplier.attributes.contactName], q),
    );
    const results = [...products, ...customers, ...suppliers];

    const { limit, offset, page, total } = paginate(results, query.page);

    // Only products have relationships, so the walk reaches nothing from the
    // customers and suppliers in the page; a supplier already in the results is
    // not repeated in `included`.
    return Handlers.resolveIncluded(page, query.include, productTargets).pipe(
      Effect.map((included) =>
        Handlers.collection(page, {
          included,
          meta: { total },
          links: Handlers.offsetPaginationLinks("/search", { offset, limit }, total),
          onResource: Handlers.project(query.fields),
          jsonapi: Document.v1_1,
        }),
      ),
    );
  }),
);

/**
 * Everything needed to serve the Northwind Traders API: the handlers plus the
 * JSON:API protocol middleware (content negotiation + spec-compliant 400s).
 *
 * The middleware is provided *into* the handler groups (not merged alongside
 * them) so that every endpoint's middleware requirement is satisfied.
 */
export const NorthwindLive = Layer.mergeAll(
  CategoriesLive,
  SuppliersLive,
  ShippersLive,
  TerritoriesLive,
  CustomersLive,
  ProductsLive,
  EmployeesLive,
  OrdersLive,
  SearchLive,
).pipe(Layer.provideMerge(Middleware.layer));
