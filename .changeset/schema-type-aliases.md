---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking:** four published schema types are renamed, and their old names now name the decoded value (#436).

| Before (schema type) | After (schema type) | The old name now means |
| --- | --- | --- |
| `Idempotency.Headers` | `Idempotency.HeadersSchema` | `typeof Idempotency.Headers.Type` |
| `Idempotency.HeadersRequired` | `Idempotency.HeadersRequiredSchema` | `typeof Idempotency.HeadersRequired.Type` |
| `Query.FilterWireValue` | `Query.FilterWireValueSchema` | `typeof Query.FilterWireValue.Type` |
| `Query.FilterRest` | `Query.FilterRestSchema` | `typeof Query.FilterRest.Type` |

The values (`Idempotency.Headers`, `Query.FilterRest`, …) are unchanged. Each name's type is now the decoded type, as for every other exported schema constant in the package. The deprecated root alias `IdempotencyHeaders` still names the schema type (now `Idempotency.HeadersSchema`).

**Migration:** where a type annotation names one of these as a _schema_ (`const h: Idempotency.Headers = …`, `Schema.optionalKey<Query.FilterWireValue>`), add the `Schema` suffix. Where it meant the decoded value, which used to be spelled `typeof Query.FilterWireValue.Type`, you can now write the bare name.
