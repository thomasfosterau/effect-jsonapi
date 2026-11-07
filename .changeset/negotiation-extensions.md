---
"@thomasfosterau/effect-jsonapi": minor
---

`Negotiation.make` checks JSON:API extensions, and a parameterised alternate can win (#566).

- **New `extensions` option.** It lists the extension URIs the api supports (e.g. `[Atomic.EXTENSION_URI]`), as `Middleware`'s `extensions` does. When it is given, a JSON:API instance whose `ext` names a URI outside the list is not clean: a read with no clean instance left answers `406`, and a write answers `415` (JSON:API §5). When it is omitted, `ext` URIs are not checked, as before. Pass `[]` for an api with no extension.
- **Fix:** an alternate's own media-type parameters no longer stop it winning. `Accept: text/markdown;charset=utf-8` on a Markdown alternate's path now negotiates `text/markdown` instead of falling back to the host's representation. The ext/profile-only rule applies to JSON:API instances alone.
