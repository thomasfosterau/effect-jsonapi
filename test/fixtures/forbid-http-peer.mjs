/**
 * Node module-resolution hooks that make every non-core Effect namespace
 * (`effect/http`, `effect/http-api`, `effect/rpc`, `effect/socket`, ... and the
 * modules under them) unresolvable. Core `effect` and `effect/<Module>` stay
 * resolvable.
 *
 * Registered by `test/entry-points.test.ts` in a child process so the built
 * entry points can be loaded against a dependency set where the HTTP surface
 * simply is not there. That is a stronger statement than reading imports out
 * of the source: it exercises the real `exports` map on the real artifact, so
 * it also catches a graph that only reaches `http-api` through `effect`'s own
 * internals, or an `exports` entry pointing at the wrong file.
 */
import { register } from "node:module";

const NAMESPACES = [
  "ai",
  "cli",
  "cluster",
  "devtools",
  "encoding",
  "eventlog",
  "http",
  "http-api",
  "net",
  "observability",
  "persistence",
  "process",
  "reactivity",
  "rpc",
  "schema",
  "socket",
  "sql",
  "workers",
  "workflow",
];

register(
  `data:text/javascript,
    export async function resolve (specifier, context, next) {
      const namespaces = ${JSON.stringify(NAMESPACES)};
      if (namespaces.some((n) => specifier === "effect/" + n || specifier.startsWith("effect/" + n + "/"))) {
        throw new Error("FORBIDDEN_PEER:" + specifier)
      }
      return next(specifier, context)
    }`,
  import.meta.url,
);
