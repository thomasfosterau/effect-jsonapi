---
"@thomasfosterau/effect-jsonapi": minor
---

Add `Document.href`, an accessor that narrows a `Link` (`string | URL | LinkObject`, undefined-safe)
to its wire string. Every link on a resource derived from `Resource.make` decodes to this union so
that relative URI-references (which `URL` cannot represent) still parse absolute ones to a real
`URL`; reading a link as a plain string previously meant re-deriving this narrowing per project.
`Document.href` does it once: `Document.href(resource.links?.self)` — no resource redeclaration
needed to get the string a wire response actually carries.

The permissive `Document.Url` / `Document.Link` union is unchanged and stays the default — this is
purely additive, so nothing that decodes or encodes links today changes behavior.
