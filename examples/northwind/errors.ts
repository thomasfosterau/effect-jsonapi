/**
 * The Northwind Traders API's domain errors: each declaration produces a tagged
 * error class whose wire encoding is a spec-compliant JSON:API error document
 * with the declared HTTP status.
 */
import { Schema } from "effect"
import { JsonApi } from "@thomasfosterau/effect-jsonapi"

export class CategoryNotFound extends JsonApi.Error<CategoryNotFound>()("CategoryNotFound", {
  status: 404,
  code: "category_not_found",
  title: "Category not found",
  fields: { id: Schema.String },
  detail: (e) => `Category ${e.id} not found`
}) {}

export class SupplierNotFound extends JsonApi.Error<SupplierNotFound>()("SupplierNotFound", {
  status: 404,
  code: "supplier_not_found",
  title: "Supplier not found",
  fields: { id: Schema.String },
  detail: (e) => `Supplier ${e.id} not found`
}) {}

export class ShipperNotFound extends JsonApi.Error<ShipperNotFound>()("ShipperNotFound", {
  status: 404,
  code: "shipper_not_found",
  title: "Shipper not found",
  fields: { id: Schema.String },
  detail: (e) => `Shipper ${e.id} not found`
}) {}

export class CustomerNotFound extends JsonApi.Error<CustomerNotFound>()("CustomerNotFound", {
  status: 404,
  code: "customer_not_found",
  title: "Customer not found",
  fields: { id: Schema.String },
  detail: (e) => `Customer ${e.id} not found`
}) {}

export class EmployeeNotFound extends JsonApi.Error<EmployeeNotFound>()("EmployeeNotFound", {
  status: 404,
  code: "employee_not_found",
  title: "Employee not found",
  fields: { id: Schema.String },
  detail: (e) => `Employee ${e.id} not found`
}) {}

export class TerritoryNotFound extends JsonApi.Error<TerritoryNotFound>()("TerritoryNotFound", {
  status: 404,
  code: "territory_not_found",
  title: "Territory not found",
  fields: { id: Schema.String },
  detail: (e) => `Territory ${e.id} not found`
}) {}

export class ProductNotFound extends JsonApi.Error<ProductNotFound>()("ProductNotFound", {
  status: 404,
  code: "product_not_found",
  title: "Product not found",
  fields: { id: Schema.String },
  detail: (e) => `Product ${e.id} not found`
}) {}

export class OrderNotFound extends JsonApi.Error<OrderNotFound>()("OrderNotFound", {
  status: 404,
  code: "order_not_found",
  title: "Order not found",
  fields: { id: Schema.String },
  detail: (e) => `Order ${e.id} not found`
}) {}

export class ProductNameTaken extends JsonApi.Error<ProductNameTaken>()("ProductNameTaken", {
  status: 409,
  code: "product_name_taken",
  title: "Product name already taken",
  fields: { name: Schema.String },
  detail: (e) => `A product named "${e.name}" already exists in the catalog`
}) {}
