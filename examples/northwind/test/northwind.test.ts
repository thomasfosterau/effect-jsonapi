/**
 * End-to-end test of the Northwind Traders API example: a real HTTP round-trip
 * (request encoding → routing → middleware → handler → response decoding)
 * through the in-memory `HttpApiTest` client.
 */
import { describe, expect, expectTypeOf, it } from "vitest"
import { Cause, Effect, Exit, Result, Schema } from "effect"
import { HttpApiTest, OpenApi } from "effect/unstable/httpapi"
import { Client } from "@thomasfosterau/effect-jsonapi"
import { Api } from "../api.js"
import { CategoryNotFound, CustomerNotFound, OrderNotFound, ProductNameTaken, ProductNotFound } from "../errors.js"
import {
  alfreds,
  andrew,
  beverages,
  boston,
  chai,
  exotic,
  gumbo,
  janet,
  margaret,
  nancy,
  NorthwindLive,
  order10248,
  order10249,
  seafood,
  speedy,
  united,
  westboro
} from "../handlers.js"
import { Category, Customer, Employee, Order, Product, Shipper, Supplier, Territory } from "../resources.js"

const buildClient = HttpApiTest.groups(Api, [
  "categories",
  "suppliers",
  "shippers",
  "territories",
  "customers",
  "products",
  "employees",
  "orders",
  "search"
])

const run = <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(NorthwindLive)) as Effect.Effect<A, E, never>)

const runExit = <A, E>(effect: Effect.Effect<A, E, any>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(effect.pipe(Effect.scoped, Effect.provide(NorthwindLive)) as Effect.Effect<A, E, never>)

const findFailure = <E>(cause: Cause.Cause<E>): E | undefined => {
  const result = Cause.findError(cause)
  return Result.isSuccess(result) ? result.success : undefined
}

describe("northwind example: fetching", () => {
  it("fetches a product document with a self link", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.products.fetch({ params: { id: Product.Id.make("1") }, query: {} })
      })
    )

    expect(document.data).toMatchObject({ type: "products", id: "1", attributes: { name: "Chai", unitPrice: 18 } })
    expect(document.links?.self).toBe("/products/1")
  })

  it("serves compound documents for ?include=category,supplier", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.products.fetch({
          params: { id: Product.Id.make("1") },
          query: { include: ["category", "supplier"] }
        })
      })
    )

    expect(document.included?.map((resource) => resource.type).sort()).toEqual(["categories", "suppliers"])
  })

  it("narrows `included` to the requested include paths on the client", async () => {
    const include = ["category"] as const
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.products
          .fetch({ params: { id: Product.Id.make("1") }, query: { include } })
          .pipe(Client.narrowIncluded(Product, include))
      })
    )

    // Runtime: only the requested category was included
    expect(document.included?.map((resource) => resource.type)).toEqual(["categories"])
    // Types: `included` is narrowed to Category — its attributes are accessible
    // without discriminating on `type`
    const category = document.included?.[0]
    expect(category?.attributes.name).toBe("Beverages")
    expectTypeOf(category!.attributes.name).toEqualTypeOf<string>()
    expectTypeOf(category!.type).toEqualTypeOf<"categories">()
  })

  it("fetches an employee with its territories included", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.employees.fetch({ params: { id: nancy.id }, query: { include: ["territories"] } })
      })
    )

    expect(document.data?.attributes.lastName).toBe("Davolio")
    // dates decode through the wire format
    expect(document.data?.attributes.hireDate).toBeInstanceOf(Date)
    expect(document.included?.map((resource) => resource.type)).toEqual(["territories", "territories"])
  })

  it("404s with a typed error for unknown products", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.products.fetch({ params: { id: Product.Id.make("nope") }, query: {} })
      })
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = findFailure(exit.cause)
      expect(error).toBeInstanceOf(ProductNotFound)
      expect((error as ProductNotFound).id).toBe("nope")
    }
  })
})

describe("northwind example: listing & filtering", () => {
  it("lists products sorted by price with offset pagination", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.products.list({
          query: { sort: [{ field: "unitPrice", direction: "desc" }], page: { offset: 0, limit: 2 } }
        })
      })
    )

    // most expensive first: Chef Anton's Gumbo Mix (21.35), Chang (19)
    expect(document.data.map((product) => product.attributes.name)).toEqual([gumbo.attributes.name, "Chang"])
    expect(document.meta?.total).toBe(5)
    expect(document.links?.next).toBe("/products?page[offset]=2&page[limit]=2")
  })

  it("serves a category's products via filter[category]", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.products.list({
          query: { filter: { category: beverages.id }, sort: [{ field: "name", direction: "asc" }] }
        })
      })
    )

    expect(document.data.map((product) => product.attributes.name)).toEqual(["Chai", "Chang"])
  })

  it("filters products by a numeric price range (decoded from the query string)", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.products.list({ query: { filter: { minPrice: 10, maxPrice: 19 } } })
      })
    )

    const prices = document.data.map((product) => product.attributes.unitPrice).sort((a, b) => a - b)
    expect(prices).toEqual([10, 18, 19])
  })

  it("filters products by discontinued flag", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.products.list({ query: { filter: { discontinued: "true" } } })
      })
    )

    expect(document.data.map((product) => product.id)).toEqual([gumbo.id])
  })

  it("filters suppliers by country", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.suppliers.list({ query: { filter: { country: "Japan" } } })
      })
    )

    expect(document.data.map((supplier) => supplier.attributes.companyName)).toEqual(["Tokyo Traders"])
  })

  it("lists an employee's direct reports via filter[manager]", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.employees.list({
          query: { filter: { manager: andrew.id }, sort: [{ field: "lastName", direction: "asc" }] }
        })
      })
    )

    // Andrew Fuller's reports, by surname
    expect(document.data.map((employee) => employee.attributes.lastName)).toEqual(["Davolio", "Leverling", "Peacock"])
  })

  it("serves a customer's orders via filter[customer]", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.orders.list({ query: { filter: { customer: alfreds.id } } })
      })
    )

    expect(document.data.map((order) => order.id)).toEqual([order10248.id])
  })

  it("filters orders by shipped status", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.orders.list({ query: { filter: { shipped: "false" } } })
      })
    )

    // only order 10249 has no shipped date
    expect(document.data.map((order) => order.id)).toContain(order10249.id)
    for (const order of document.data) {
      expect(order.attributes.shippedDate).toBeUndefined()
    }
  })
})

describe("northwind example: writing", () => {
  it("adds a product to the catalog (201) and then removes it (204)", async () => {
    await run(
      Effect.gen(function* () {
        const client = yield* buildClient

        const created = yield* client.products.create({
          payload: {
            data: {
              type: "products",
              lid: "temp-1",
              attributes: { name: "Genmaicha", unitPrice: 14.5, unitsInStock: 30, discontinued: false },
              relationships: {
                category: { data: Category.ref(beverages.id) },
                supplier: { data: Supplier.ref(exotic.id) }
              }
            }
          }
        })

        expect(created.data?.attributes.name).toBe("Genmaicha")
        expect(created.data?.relationships?.category.data?.id).toBe(beverages.id)

        yield* client.products.delete({ params: { id: created.data!.id } })
      })
    )
  })

  it("409s when the product name is already taken", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.products.create({
          payload: {
            data: {
              type: "products",
              attributes: { name: chai.attributes.name, unitPrice: 1, unitsInStock: 1, discontinued: false },
              relationships: {
                category: { data: Category.ref(beverages.id) },
                supplier: { data: Supplier.ref(exotic.id) }
              }
            }
          }
        })
      })
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(findFailure(exit.cause)).toBeInstanceOf(ProductNameTaken)
    }
  })

  it("404s when creating a product in a missing category", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.products.create({
          payload: {
            data: {
              type: "products",
              attributes: { name: "Phantom Tea", unitPrice: 1, unitsInStock: 1, discontinued: false },
              relationships: {
                category: { data: Category.ref("does-not-exist") },
                supplier: { data: Supplier.ref(exotic.id) }
              }
            }
          }
        })
      })
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(findFailure(exit.cause)).toBeInstanceOf(CategoryNotFound)
    }
  })

  it("marks a product discontinued with a partial update", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.products.update({
          params: { id: Product.Id.make("2") },
          payload: { data: { type: "products", id: Product.Id.make("2"), attributes: { discontinued: true } } }
        })
      })
    )

    expect(document.data?.attributes.discontinued).toBe(true)
    // other attributes are untouched
    expect(document.data?.attributes.name).toBe("Chang")
  })

  it("opens an order against a customer and employee (201)", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.orders.create({
          payload: {
            data: {
              type: "orders",
              attributes: {
                orderDate: new Date("1996-07-09T00:00:00.000Z"),
                requiredDate: new Date("1996-08-06T00:00:00.000Z"),
                freight: 12.34,
                shipCity: "Berlin",
                shipCountry: "Germany"
              },
              relationships: {
                customer: { data: Customer.ref(alfreds.id) },
                employee: { data: Employee.ref(nancy.id) },
                // an order is opened unshipped
                shipper: { data: null }
              }
            }
          }
        })
      })
    )

    expect(document.data?.attributes.shipCountry).toBe("Germany")
    expect(document.data?.relationships?.customer.data?.id).toBe(alfreds.id)
    // the paginated line-item feed exists as a link, with no inline data
    expect(document.data?.relationships?.lineItems.links?.related).toBe(`/orders/${document.data?.id}/lineItems`)
  })

  it("404s when opening an order for a missing customer", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.orders.create({
          payload: {
            data: {
              type: "orders",
              attributes: {
                orderDate: new Date(),
                requiredDate: new Date(),
                freight: 0,
                shipCountry: "Germany"
              },
              relationships: {
                customer: { data: Customer.ref("ghost") },
                employee: { data: Employee.ref(nancy.id) }
              }
            }
          }
        })
      })
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(findFailure(exit.cause)).toBeInstanceOf(CustomerNotFound)
    }
  })

  it("records an order's shipped date with a partial update", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.orders.update({
          params: { id: order10249.id },
          payload: {
            data: {
              type: "orders",
              id: order10249.id,
              attributes: { shippedDate: new Date("1996-07-10T00:00:00.000Z") }
            }
          }
        })
      })
    )

    expect(document.data?.attributes.shippedDate).toBeInstanceOf(Date)
  })
})

describe("northwind example: related & relationship endpoints", () => {
  it("GET /products/:id/supplier serves the supplying company", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.products.supplier({ params: { id: Product.Id.make("1") }, query: {} })
      })
    )

    expect(document.data).toMatchObject({
      type: "suppliers",
      id: exotic.id,
      attributes: { companyName: "Exotic Liquids" }
    })
    expect(document.links?.self).toBe("/products/1/supplier")
  })

  it("GET /orders/:id/lineItems serves the paginated line-item feed with its products", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.orders.lineItems({ params: { id: order10248.id }, query: { include: ["product"] } })
      })
    )

    expect(document.data).toHaveLength(2)
    expect(document.meta?.total).toBe(2)
    // each line item's product is brought into the compound document
    expect(document.included?.map((resource) => resource.type)).toEqual(["products", "products"])
  })

  it("reassigns a product's category through the relationship endpoint", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        const linkage = yield* client.products.updateCategoryRelationship({
          params: { id: Product.Id.make("4") },
          payload: { data: Category.ref(seafood.id) }
        })
        // the product reflects the reassignment
        const product = yield* client.products.fetch({ params: { id: Product.Id.make("4") }, query: {} })
        expect(product.data?.relationships?.category.data?.id).toBe(seafood.id)
        return linkage
      })
    )

    expect(document.data).toEqual({ type: "categories", id: seafood.id })
  })

  it("assigns and clears an order's shipper (optional to-one)", async () => {
    await run(
      Effect.gen(function* () {
        const client = yield* buildClient

        // initially unshipped → linkage data is null
        const before = yield* client.orders.shipperRelationship({ params: { id: order10249.id }, query: {} })
        expect(before.data).toBeNull()

        // assign a shipper
        const assigned = yield* client.orders.updateShipperRelationship({
          params: { id: order10249.id },
          payload: { data: Shipper.ref(united.id) }
        })
        expect(assigned.data).toEqual({ type: "shippers", id: united.id })

        // clear it again
        const cleared = yield* client.orders.updateShipperRelationship({
          params: { id: order10249.id },
          payload: { data: null }
        })
        expect(cleared.data).toBeNull()
      })
    )
  })

  it("POST assigns territories, DELETE unassigns them, PATCH replaces them", async () => {
    await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        const employeeId = margaret.id // starts with no territories

        // POST: assign two territories
        const assigned = yield* client.employees.addTerritoriesRelationship({
          params: { id: employeeId },
          payload: { data: [Territory.ref(westboro.id), Territory.ref(boston.id)] }
        })
        expect(assigned.data.map((ref) => ref.id).sort()).toEqual([westboro.id, boston.id].sort())

        // assigning an already-present territory is a no-op
        const assignedAgain = yield* client.employees.addTerritoriesRelationship({
          params: { id: employeeId },
          payload: { data: [Territory.ref(westboro.id)] }
        })
        expect(assignedAgain.data).toHaveLength(2)

        // DELETE: unassign one → 204
        yield* client.employees.removeTerritoriesRelationship({
          params: { id: employeeId },
          payload: { data: [Territory.ref(westboro.id)] }
        })
        const afterRemove = yield* client.employees.territoriesRelationship({ params: { id: employeeId }, query: {} })
        expect(afterRemove.data).toEqual([{ type: "territories", id: boston.id }])

        // PATCH: replace the whole set
        const replaced = yield* client.employees.updateTerritoriesRelationship({
          params: { id: employeeId },
          payload: { data: [Territory.ref(westboro.id)] }
        })
        expect(replaced.data).toEqual([{ type: "territories", id: westboro.id }])
      })
    )
  })

  it("404s when assigning a missing territory", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.employees.addTerritoriesRelationship({
          params: { id: janet.id },
          payload: { data: [Territory.ref("99999")] }
        })
      })
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(findFailure(exit.cause)).toBeInstanceOf(Error)
    }
  })
})

describe("northwind example: heterogeneous search", () => {
  it("returns a mixed collection of products, customers and suppliers, discriminated by type", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        // "a" hits all three stores
        return yield* client.search.search({ query: { filter: { q: "a" } } })
      })
    )

    const types = [...new Set(document.data.map((result) => result.type))].sort()
    expect(types).toEqual(["customers", "products", "suppliers"])

    for (const result of document.data) {
      if (result.type === "products") {
        expectTypeOf(result.attributes.unitPrice).toEqualTypeOf<number>()
      } else if (result.type === "customers") {
        expectTypeOf(result.attributes.companyName).toEqualTypeOf<string>()
      } else {
        expectTypeOf(result.attributes.country).toEqualTypeOf<string>()
      }
    }
  })

  it("supports include across the searched resources' graphs", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.search.search({ query: { filter: { q: "chai" }, include: ["category"] } })
      })
    )

    // the matched product's category is included
    expect(document.data.map((result) => result.type)).toEqual(["products"])
    expect(document.included?.map((resource) => resource.type)).toEqual(["categories"])
  })

  it("paginates heterogeneous results with links", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.search.search({ query: { filter: { q: "" }, page: { offset: 0, limit: 2 } } })
      })
    )

    expect(document.data).toHaveLength(2)
    expect(document.meta?.total).toBeGreaterThan(2)
    expect(document.links?.next).toBe("/search?page[offset]=2&page[limit]=2")
  })
})

describe("northwind example: spec compliance on the wire", () => {
  it("error documents are spec-compliant JSON:API", () => {
    const wire = Schema.encodeUnknownSync(ProductNameTaken.wire)(new ProductNameTaken({ name: "Chai" }))
    expect(wire).toEqual({
      errors: [
        {
          status: "409",
          code: "product_name_taken",
          title: "Product name already taken",
          detail: `A product named "Chai" already exists in the catalog`,
          meta: { name: "Chai" }
        }
      ]
    })

    const notFound = Schema.encodeUnknownSync(OrderNotFound.wire)(new OrderNotFound({ id: "10248" }))
    expect(notFound.errors[0]).toMatchObject({ status: "404", code: "order_not_found", meta: { id: "10248" } })
  })

  it("OpenAPI generation reflects the JSON:API media type, statuses and query parameters", () => {
    const spec = OpenApi.fromApi(Api)
    expect(JSON.stringify(spec)).toContain("application/vnd.api+json")

    // create → 201 + 409, remove → 204, fetch errors → 404
    expect(spec.paths["/products"]?.post?.responses).toHaveProperty("201")
    expect(spec.paths["/products"]?.post?.responses).toHaveProperty("409")
    expect(spec.paths["/products/{id}"]?.delete?.responses).toHaveProperty("204")
    expect(spec.paths["/products/{id}"]?.get?.responses).toHaveProperty("404")

    // typed query parameters are documented with their bracket names
    const listParams = spec.paths["/products"]?.get?.parameters?.map((parameter: any) => parameter.name)
    expect(listParams).toContain("sort")
    expect(listParams).toContain("page[offset]")
    expect(listParams).toContain("page[limit]")
    expect(listParams).toContain("filter[category]")
    expect(listParams).toContain("filter[minPrice]")

    // related & relationship endpoints
    expect(spec.paths["/products/{id}/supplier"]?.get).toBeDefined()
    expect(spec.paths["/orders/{id}/lineItems"]?.get).toBeDefined()
    expect(spec.paths["/employees/{id}/relationships/territories"]?.post).toBeDefined()
    expect(spec.paths["/employees/{id}/relationships/territories"]?.delete?.responses).toHaveProperty("204")
    expect(spec.paths["/orders/{id}/relationships/shipper"]?.patch).toBeDefined()
  })

  it("sample resources decode against their own schemas (round-trip)", () => {
    const encoded = Schema.encodeUnknownSync(Order)(order10248)
    expect(encoded.attributes.orderDate).toBe("1996-07-04T00:00:00.000Z")
    const decoded = Schema.decodeUnknownSync(Order)(encoded)
    expect(decoded).toEqual(order10248)

    // the unshipped order encodes a null shipper and no shipped date
    const unshipped = Schema.encodeUnknownSync(Order)(order10249)
    expect(unshipped.relationships?.shipper.data).toBeNull()
    expect(unshipped.attributes.shippedDate).toBeUndefined()

    const product = Schema.encodeUnknownSync(Product)(chai)
    expect(product.relationships?.category.data.id).toBe(beverages.id)
  })

  it("speedy express is reachable as a shipper", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.shippers.fetch({ params: { id: speedy.id }, query: {} })
      })
    )

    expect(document.data?.attributes.companyName).toBe("Speedy Express")
  })
})
