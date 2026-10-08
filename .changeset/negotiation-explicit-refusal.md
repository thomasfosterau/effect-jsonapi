---
"@thomasfosterau/effect-jsonapi": minor
---

`Negotiation.make` takes an opt-in `onExplicitRefusal: "notAcceptable"`: a read on an api path whose `Accept` refuses JSON:API with `q=0` and names no other media type with `q > 0` answers `406` with the new `Negotiation.NOT_ACCEPTABLE_REFUSED`, whose `detail` names the RFC 9110 §12.4.2 rule so it can be told apart from the §6.3.2 media-type-parameter 406. The default, `"fallthrough"`, keeps today's behaviour: the request falls through to the host's own representation.
