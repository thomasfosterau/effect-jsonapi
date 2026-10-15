/**
 * An application error declared in a module of its own, as an app's
 * `errors.ts` would: `declaration-emit-group.types.ts` attaches it to
 * generated endpoints without importing `ApiError`, so the `ApiError.Wire`
 * its endpoints' types carry must be nameable without it: through the
 * `./ApiError` subpath (#385), or the deprecated root alias (#348).
 */
import { ApiError } from "@thomasfosterau/effect-jsonapi";

export class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
  status: 404,
  code: "article_not_found",
  title: "Article Not Found",
}) {}
