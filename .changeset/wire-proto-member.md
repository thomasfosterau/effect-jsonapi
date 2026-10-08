---
"@thomasfosterau/effect-jsonapi": patch
---

A member keyed `__proto__` now survives the response path as data. A value from `JSON.parse` or a database driver can carry `__proto__` as an ordinary own key; `Assemble.toWireSafeResource` used to drop it from the copy (and make its value the copy's prototype), and so did a sparse fieldset that requested it (`Handlers.project`, which the `Assemble` builders' `fields` option applies). Both now write every member as an own property, so the wire form matches `JSON.stringify` of the input.
