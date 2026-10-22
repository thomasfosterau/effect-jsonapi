---
"@thomasfosterau/effect-jsonapi": minor
---

`Conformance` checks the client-generated id rules on an atomic `add` (#471). Where the api declares an operations endpoint, a type whose `writes` fixture opts in with `clientId` now also runs `spec/atomic/add-client-id` (with `supported: true`, an `add` under the id answers with its result carrying the resource under that id, a result with no `data`, or 204), `spec/atomic/add-conflict-id` (a second `add` under the same id answers 409) and `spec/atomic/add-client-id-unsupported` (with `supported: false`, an `add` under the id answers 403, and any `source.pointer` lies within the operation under `/atomic:operations`). Each request carries one `add`; whatever a wrong 2xx creates is recorded and handed to `cleanup`.
