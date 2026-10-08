---
"@thomasfosterau/effect-jsonapi": patch
---

`Conformance`'s `spec/document/full-linkage` rule reports an orphaned `included` resource whose `type` or `id` is not a string as a finding. It rendered the pair with `String`, which throws on valid JSON such as `{"type":{"toString":1},"id":"2"}`, so the rule came out `Errored` instead of `Failed`. A string `type` or `id` still reads as itself; any other value now reads through `Formatter.format` (`{"toString":1}:2`). `spec/document/no-duplicate-resources` renders the same way, and names a resource identified by `lid` by its `lid` (it read `people:undefined`).

`Conformance.format` keeps a value that spans lines inside its entry: a `WRITES` entry whose `cleanup-failed` detail has more than one line — an `Error("a\nb")` from `cleanup` — hangs the later lines under the entry instead of starting them at the margin, and a finding whose detail has more than one line marks only the first with `·`.
