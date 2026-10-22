/**
 * The blog's domain errors: each declaration produces a tagged error class
 * whose wire encoding is a spec-compliant JSON:API error document with the
 * declared HTTP status.
 */
import { Schema } from "effect";
import { ApiError, Atomic } from "@thomasfosterau/effect-jsonapi";
export class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
  status: 404,
  code: "not_found",
  title: "Resource not found",
  fields: { id: Schema.String },
  detail: (e) => `Article ${e.id} not found`,
}) {}

/**
 * A write naming a person the store does not hold. `pointer`, when set, is the
 * JSON pointer to the offending linkage in the request document (e.g. inside
 * `atomic:operations`) and becomes the error's `source.pointer`.
 */
export class PersonNotFound extends ApiError.make<PersonNotFound>()("PersonNotFound", {
  status: 404,
  code: "person_not_found",
  title: "Person not found",
  fields: { id: Schema.String, pointer: Schema.optionalKey(Schema.String) },
  detail: (e) => `Person ${e.id} not found`,
  source: (e) => (e.pointer === undefined ? undefined : { pointer: e.pointer }),
}) {}

/** A write naming a comment the store does not hold; `pointer` as on {@link PersonNotFound}. */
export class CommentNotFound extends ApiError.make<CommentNotFound>()("CommentNotFound", {
  status: 404,
  code: "comment_not_found",
  title: "Comment not found",
  fields: { id: Schema.String, pointer: Schema.optionalKey(Schema.String) },
  detail: (e) => `Comment ${e.id} not found`,
  source: (e) => (e.pointer === undefined ? undefined : { pointer: e.pointer }),
}) {}

/** A write naming a tag the store does not hold; `pointer` as on {@link PersonNotFound}. */
export class TagNotFound extends ApiError.make<TagNotFound>()("TagNotFound", {
  status: 404,
  code: "tag_not_found",
  title: "Tag not found",
  fields: { id: Schema.String, pointer: Schema.optionalKey(Schema.String) },
  detail: (e) => `Tag ${e.id} not found`,
  source: (e) => (e.pointer === undefined ? undefined : { pointer: e.pointer }),
}) {}

export class TitleTaken extends ApiError.make<TitleTaken>()("TitleTaken", {
  status: 409,
  code: "title_taken",
  title: "Title already taken",
  fields: { title: Schema.String },
  detail: (e) => `An article titled "${e.title}" already exists`,
}) {}

/**
 * Fails an atomic operations request: carries the index of the operation that
 * failed (also exposed as a JSON pointer in `detail`) so clients know which
 * one to fix. Per the extension, no operation is applied.
 */
export class OperationFailed extends ApiError.make<OperationFailed>()("OperationFailed", {
  status: 422,
  code: "operation_failed",
  title: "Atomic operation failed",
  fields: { operation: Schema.Int, reason: Schema.String },
  detail: (e) => `Operation at ${Atomic.operationPointer(e.operation)} failed: ${e.reason}`,
}) {}
