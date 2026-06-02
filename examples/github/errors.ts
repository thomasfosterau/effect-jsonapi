/**
 * The GitHub-like API's domain errors: each declaration produces a tagged
 * error class whose wire encoding is a spec-compliant JSON:API error document
 * with the declared HTTP status.
 */
import { Schema } from "effect"
import { JsonApi } from "effect-jsonapi"

export class UserNotFound extends JsonApi.Error<UserNotFound>()("UserNotFound", {
  status: 404,
  code: "not_found",
  title: "User not found",
  fields: { id: Schema.String },
  detail: (e) => `User ${e.id} not found`
}) {}

export class RepositoryNotFound extends JsonApi.Error<RepositoryNotFound>()("RepositoryNotFound", {
  status: 404,
  code: "not_found",
  title: "Repository not found",
  fields: { id: Schema.String },
  detail: (e) => `Repository ${e.id} not found`
}) {}

export class IssueNotFound extends JsonApi.Error<IssueNotFound>()("IssueNotFound", {
  status: 404,
  code: "not_found",
  title: "Issue not found",
  fields: { id: Schema.String },
  detail: (e) => `Issue ${e.id} not found`
}) {}

export class PullRequestNotFound extends JsonApi.Error<PullRequestNotFound>()("PullRequestNotFound", {
  status: 404,
  code: "not_found",
  title: "Pull request not found",
  fields: { id: Schema.String },
  detail: (e) => `Pull request ${e.id} not found`
}) {}

export class RepositoryNameTaken extends JsonApi.Error<RepositoryNameTaken>()("RepositoryNameTaken", {
  status: 422,
  code: "name_taken",
  title: "Repository name already taken",
  fields: { name: Schema.String },
  detail: (e) => `A repository named "${e.name}" already exists for this owner`
}) {}

export class IssueLocked extends JsonApi.Error<IssueLocked>()("IssueLocked", {
  status: 403,
  code: "issue_locked",
  title: "Issue is locked",
  fields: { id: Schema.String },
  detail: (e) => `Issue ${e.id} is locked and cannot be modified`
}) {}
