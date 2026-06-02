/**
 * The blog's domain errors: each declaration produces a tagged error class
 * whose wire encoding is a spec-compliant JSON:API error document with the
 * declared HTTP status.
 */
import { Schema } from "effect"
import { JsonApi } from "effect-jsonapi"

export class ArticleNotFound extends JsonApi.Error<ArticleNotFound>()("ArticleNotFound", {
  status: 404,
  code: "not_found",
  title: "Resource not found",
  fields: { id: Schema.String },
  detail: (e) => `Article ${e.id} not found`
}) {}

export class TitleTaken extends JsonApi.Error<TitleTaken>()("TitleTaken", {
  status: 409,
  code: "title_taken",
  title: "Title already taken",
  fields: { title: Schema.String },
  detail: (e) => `An article titled "${e.title}" already exists`
}) {}

/**
 * Fails an atomic operations request: carries the index of the operation that
 * failed (also exposed as a JSON pointer in `detail`) so clients know which
 * one to fix. Per the extension, no operation is applied.
 */
export class OperationFailed extends JsonApi.Error<OperationFailed>()("OperationFailed", {
  status: 422,
  code: "operation_failed",
  title: "Atomic operation failed",
  fields: { operation: Schema.Int, reason: Schema.String },
  detail: (e) => `Operation at ${JsonApi.Atomic.operationPointer(e.operation)} failed: ${e.reason}`
}) {}
