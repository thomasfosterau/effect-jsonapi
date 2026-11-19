# effect-jsonapi

Type-safe, spec-compliant [JSON:API v1.1](https://jsonapi.org/format/1.1/) on [Effect](https://effect.website)'s `HttpApi` and `Schema`: define a resource once and derive its documents, payloads, query parameters, endpoints, errors and typed client.

> [!CAUTION]
> Experimental and pre-1.0, largely written with Claude Code. The API may change between minor versions.

## Install

```sh
pnpm add @thomasfosterau/effect-jsonapi effect
```

`effect` (`^4.1.0`) is a peer dependency. Node.js 22 or newer.

## Example

```ts
import { Schema } from "effect";
import { HttpApi } from "effect/http-api";
import { Endpoint, Group, Query, Resource } from "@thomasfosterau/effect-jsonapi";

const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString, body: Schema.String },
});

const Api = HttpApi.make("blog").add(
  Group.make(
    Article,
    Endpoint.get(Article, { include: true }),
    Endpoint.list(Article, { page: Query.Page.Offset }),
  ),
);
```

Implement the group with `HttpApiBuilder` and `Handlers.data` / `Handlers.collection`, and provide `Middleware.layer`.

## Entry points

| Import | What it is |
| --- | --- |
| `@thomasfosterau/effect-jsonapi` | Every module as a namespace (`Resource`, `Endpoint`, `Handlers`, `Client`, …). |
| `@thomasfosterau/effect-jsonapi/schema` | The wire types alone, without Effect's HTTP modules. |
| `@thomasfosterau/effect-jsonapi/<Module>` | One module, e.g. `/Resource`, `/Endpoint`. |

## Documentation

- [Guides](https://github.com/thomasfosterau/effect-jsonapi/blob/trunk/docs/README.md): resources, endpoints, handlers, queries, the client, the conformance kit.
- [Examples](https://github.com/thomasfosterau/effect-jsonapi/tree/trunk/examples) and the doc comment on every export.
- [Contributing](https://github.com/thomasfosterau/effect-jsonapi/blob/trunk/docs/CONTRIBUTING.md), [security](https://github.com/thomasfosterau/effect-jsonapi/blob/trunk/docs/SECURITY.md), [publishing](https://github.com/thomasfosterau/effect-jsonapi/blob/trunk/docs/PUBLISHING.md).

MIT licensed.
