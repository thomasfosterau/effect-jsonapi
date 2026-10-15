---
"@thomasfosterau/effect-jsonapi": patch
---

`Conformance` no longer reads a client that rewrites its requests' URL (`HttpClient.mapRequest` mapping `baseUrl` onto another origin, say) as one that followed a redirect itself. Where a transport ended is now compared with the request after the client's own `mapRequest`, rather than with the URL the kit built, so such a client is read as any other: its rules are decided, and `spec/target/reachable` no longer fails asking for a client that does not follow redirects. A redirect a client follows itself (`HttpClient.followRedirects`) to another origin than the one it sent the request to, or turning the method into a `GET`, is still left unread. This corrects the transport-followed redirect check added in this release, before it shipped.
