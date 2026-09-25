---
"@thomasfosterau/effect-jsonapi": patch
---

Render a schema issue's `detail` with Effect's own formatter. Until now `ServerErrors.schemaIssueToErrors` built it with `String(issue)`, which prints `[object Object]` because Effect Schema issue nodes have no `toString`.

Each error object's `detail` is now Effect's default formatter output (`SchemaIssue.makeFormatterDefault()`), for example `Missing key`, `Expected number` or `Expected "a" | "b"`. A failed check takes its message from the check itself, either its description (`Expected a value with a length of at least 3`) or its `message` annotation. The same formatting applies when a schema issue is passed as one of `ValidationFailure`'s issues. Every other part of each error object is unchanged: `status`, `code`, `source.pointer` and the error count.
