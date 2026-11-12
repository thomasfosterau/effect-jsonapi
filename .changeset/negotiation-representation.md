---
"@thomasfosterau/effect-jsonapi": minor
---

`Negotiation.representation({ extensions, servesPath })` and `Negotiation.toApiError(negotiation)`: the JSON:API half of a media-type-agnostic negotiator such as `@thomasfosterau/effect-ext/Negotiate`'s `negotiateRepresentation` (#577). `representation` is the JSON:API `Representation`, whose `acceptsParameters` is JSON:API §5's rule (only `ext` / `profile`, every `ext` URI in `extensions`, none by default). `toApiError` maps that negotiator's `NotAcceptable` / `UnsupportedMediaType` refusal of the JSON:API representation to `ApiError.NotAcceptable` (406) / `ApiError.UnsupportedMediaType` (415), and anything else to `Option.none()`. Both are typed structurally, so this package does not import effect-ext's `Negotiate` (whose former optional peer on this package was a cycle).
