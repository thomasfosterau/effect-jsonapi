/**
 * The Northwind Traders API's resources: the classic sample database modelled
 * as JSON:API resources — categories, suppliers, shippers, customers,
 * territories, employees, products, orders and their line items. Each one is
 * defined once and everything else (identifiers, payloads, documents, query
 * parameters, endpoints) derives from these definitions.
 *
 * The relationship graph is deliberately a *DAG* — it exercises all four
 * relationship kinds without ever forming a cycle:
 *
 *   Product ──category───▶ Category   `one`      — required, inline identifier
 *   Product ──supplier───▶ Supplier   `one`      — required, inline identifier
 *   Employee ──territories▶ Territory `many`     — bounded, inline identifiers
 *   OrderItem ──product──▶ Product    `one`
 *   Order ──customer─────▶ Customer   `one`
 *   Order ──employee─────▶ Employee   `one`       — the salesperson
 *   Order ──shipper──────▶ Shipper    `optional`  — null until the order ships
 *   Order ──lineItems────▶ OrderItem  `paginated` — reachable only via the
 *                                       related link (GET /orders/:id/lineItems)
 *
 * The *reverse* directions are intentionally absent: a `Category` does not
 * point back at its products, nor a `Customer` at its orders. JSON:API resource
 * graphs cannot be mutually recursive (TypeScript cannot infer two resource
 * types that reference each other), so — exactly as the library's docs advise —
 * each reverse direction is modelled as a filtered collection endpoint instead:
 *
 *   a category's products  →  GET /products?filter[category]=<id>
 *   a supplier's products  →  GET /products?filter[supplier]=<id>
 *   a customer's orders    →  GET /orders?filter[customer]=<id>
 *   an employee's orders   →  GET /orders?filter[employee]=<id>
 *
 * The same trick models the self-referential "who reports to whom" hierarchy:
 * an employee carries a plain `managerId` attribute, and an employee's direct
 * reports are listed with GET /employees?filter[manager]=<id>.
 */
import { Schema } from "effect"
import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
export const Category = Resource.make("categories", {
  attributes: {
    name: Schema.NonEmptyString,
    description: Schema.optionalKey(Schema.String)
  }
})

export const Supplier = Resource.make("suppliers", {
  attributes: {
    companyName: Schema.NonEmptyString,
    contactName: Schema.optionalKey(Schema.String),
    country: Schema.NonEmptyString,
    city: Schema.optionalKey(Schema.String)
  }
})

export const Shipper = Resource.make("shippers", {
  attributes: {
    companyName: Schema.NonEmptyString,
    phone: Schema.optionalKey(Schema.String)
  }
})

export const Customer = Resource.make("customers", {
  attributes: {
    companyName: Schema.NonEmptyString,
    contactName: Schema.optionalKey(Schema.String),
    country: Schema.NonEmptyString,
    city: Schema.optionalKey(Schema.String)
  }
})

export const Territory = Resource.make("territories", {
  attributes: {
    description: Schema.NonEmptyString,
    region: Schema.NonEmptyString
  }
})

export const Employee = Resource.make("employees", {
  attributes: {
    firstName: Schema.NonEmptyString,
    lastName: Schema.NonEmptyString,
    title: Schema.optionalKey(Schema.String),
    // Wire form is an ISO-8601 string; decoded form is a `Date`.
    hireDate: Schema.DateFromString,
    // The self-referential manager link, denormalised onto the employee as a
    // plain attribute (see the module docs): an employee's reports are listed
    // with GET /employees?filter[manager]=<id>.
    managerId: Schema.optionalKey(Schema.String)
  },
  relationships: {
    // Sales territories are few and bounded: inlined identifiers, managed
    // through the /employees/:id/relationships/territories endpoints.
    territories: Relationship.many(() => Territory)
  }
})

export const Product = Resource.make("products", {
  attributes: {
    name: Schema.NonEmptyString,
    unitPrice: Schema.Number,
    unitsInStock: Schema.Int,
    discontinued: Schema.Boolean
  },
  relationships: {
    // Every product belongs to a category and comes from a supplier: required
    // to-one relationships, present in the create payload and reassignable
    // through the relationship endpoints.
    category: Relationship.one(() => Category),
    supplier: Relationship.one(() => Supplier)
  }
})

export const OrderItem = Resource.make("orderItems", {
  attributes: {
    unitPrice: Schema.Number,
    quantity: Schema.Int,
    // Discount as a fraction in [0, 1].
    discount: Schema.Number
  },
  relationships: {
    product: Relationship.one(() => Product)
  }
})

export const Order = Resource.make("orders", {
  attributes: {
    orderDate: Schema.DateFromString,
    requiredDate: Schema.DateFromString,
    // Null until the order ships.
    shippedDate: Schema.optionalKey(Schema.DateFromString),
    freight: Schema.Number,
    shipCity: Schema.optionalKey(Schema.String),
    shipCountry: Schema.NonEmptyString
  },
  relationships: {
    // An order is always placed by a customer and taken by an employee.
    customer: Relationship.one(() => Customer),
    employee: Relationship.one(() => Employee),
    // ... but is not assigned a shipper until it ships.
    shipper: Relationship.optional(() => Shipper),
    // Line items are unbounded: reachable only through the related link
    // (GET /orders/:id/lineItems), never inlined.
    lineItems: Relationship.paginated(() => OrderItem)
  }
})

export type Category = typeof Category.Type
export type Supplier = typeof Supplier.Type
export type Shipper = typeof Shipper.Type
export type Customer = typeof Customer.Type
export type Territory = typeof Territory.Type
export type Employee = typeof Employee.Type
export type Product = typeof Product.Type
export type OrderItem = typeof OrderItem.Type
export type Order = typeof Order.Type
