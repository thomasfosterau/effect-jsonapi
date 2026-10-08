---
"@thomasfosterau/effect-jsonapi": minor
---

A `Conformance` rule that dies no longer loses the whole report. In 0.16.3 a defect in any one rule (a fixture that throws, a transport that falls over) failed `Conformance.verify` / `verifyWith` outright, so every other rule's outcome — and, with this release's write fixture, the `Report.writes` ledger of what the kit created and whether it was removed — went unreported. The rule now gets a new `Errored` outcome (`Conformance.Outcome` gains a fourth member, `{ _tag: "Errored", rule, message, defect }`), every other rule still runs and is reported in the suite's order, and `Report.writes` is still filled. Interruption is not turned into an outcome: it still stops the run.

`format` prints such a rule first in its tier, marked `DIED` with the defect's message, and adds `· N died` to the tier and summary lines when one did (a run in which nothing died prints as before); `summarise` gains an `errored` count. `assert` dies on the first `Errored` outcome — with a `RuleDied` defect naming the rule and the defect's message, the original defect as its `cause` — before looking at failures, so the gate stays as strict as when the defect killed the run.

A `switch` over `Outcome._tag` that relies on exhaustiveness needs an `Errored` case.
