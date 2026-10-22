---
"@thomasfosterau/effect-jsonapi": minor
---

**`Conformance.Options.only` and `skip` match rule-id prefixes by path segment (#367).** An entry now matches the rule whose id it is and every rule whose id continues it with `/`, never one that merely continues the string: `skip: ["spec/status/create-location"]` leaves out that rule alone and keeps `spec/status/create-location-matches-self`, and `only: ["spec/status/create-location"]` runs it alone. A section matches with or without its trailing `/` (`"spec/links"` and `"spec/links/"` alike). **This narrows what some prefixes select:** a partial segment such as `"spec/content-neg"` or `"spec/content-negotiation/accept-weight"`, which used to match by plain string prefix, now matches nothing; name the section (`"spec/content-negotiation"`) or each rule id instead.
