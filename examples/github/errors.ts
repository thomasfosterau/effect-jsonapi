/**
 * The GitHub-like API's domain errors: each declaration produces a tagged
 * error class whose wire encoding is a spec-compliant JSON:API error document
 * with the declared HTTP status.
 */
import { Schema } from "effect"
import { ApiError } from "@thomasfosterau/effect-jsonapi"
export class UserNotFound extends ApiError.make<UserNotFound>()("UserNotFound", {
  status: 404,
  code: "user_not_found",
  title: "User not found",
  fields: { id: Schema.String },
  detail: (e) => `User ${e.id} not found`
}) {}

export class RepositoryNotFound extends ApiError.make<RepositoryNotFound>()("RepositoryNotFound", {
  status: 404,
  code: "repository_not_found",
  title: "Repository not found",
  fields: { id: Schema.String },
  detail: (e) => `Repository ${e.id} not found`
}) {}

export class IssueNotFound extends ApiError.make<IssueNotFound>()("IssueNotFound", {
  status: 404,
  code: "issue_not_found",
  title: "Issue not found",
  fields: { id: Schema.String },
  detail: (e) => `Issue ${e.id} not found`
}) {}

export class PullRequestNotFound extends ApiError.make<PullRequestNotFound>()("PullRequestNotFound", {
  status: 404,
  code: "pull_request_not_found",
  title: "Pull request not found",
  fields: { id: Schema.String },
  detail: (e) => `Pull request ${e.id} not found`
}) {}

export class RepositoryNameTaken extends ApiError.make<RepositoryNameTaken>()("RepositoryNameTaken", {
  status: 422,
  code: "name_taken",
  title: "Repository name already taken",
  fields: { name: Schema.String },
  detail: (e) => `A repository named "${e.name}" already exists for this owner`
}) {}

export class IssueLocked extends ApiError.make<IssueLocked>()("IssueLocked", {
  status: 403,
  code: "issue_locked",
  title: "Issue is locked",
  fields: { id: Schema.String },
  detail: (e) => `Issue ${e.id} is locked and cannot be modified`
}) {}
