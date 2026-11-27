/**
 * effect-jsonapi — the flat server skeleton, an opt-in layer over the core.
 *
 * The core (`Resource`, `Query`, `Document`, `Endpoint`, `Handlers`,
 * `Middleware`) is the protocol. The skeleton is one opinionated way to serve
 * it: `ResourceHandlers` turns a storage-shaped implementation (`get`, `list`,
 * `create`, …) into endpoint handlers, with a viewer, a cache, `transact` and
 * hidden writes; `Assemble` builds its documents, with `canEdit` /
 * `canDelete` capability meta and `meta.totalCount`; `Registry` routes a
 * family of resources to their handlers; and `FlatQuery` is the flat
 * list-input grammar the skeleton's `Group.flat` endpoints read.
 *
 * ```ts skip-type-checking
 * import { Assemble, ResourceHandlers } from "@thomasfosterau/effect-jsonapi/skeleton"
 * ```
 *
 * Reach for it when its conventions are yours; an api with its own handler
 * shape builds on the core alone. Each module stays importable through its own
 * subpath (`/Assemble`, `/ResourceHandlers`, …), and from the package root as
 * a deprecated re-export.
 *
 * @since 0.23.0
 */

/**
 * The server-side document assembler over `Handlers`, with the capability
 * hooks and `meta.totalCount`.
 *
 * @since 0.23.0
 */
export * as Assemble from "./Assemble.js";

/**
 * The flat list-input grammar (`FlatQuery.pagination`, `FlatQuery.listInput`,
 * `FlatQuery.SortParam`, `FlatQuery.idList`, `FlatQuery.slug`).
 *
 * @since 0.23.0
 */
export * as FlatQuery from "./FlatQuery.js";

/**
 * The handler registry and router (`Registry.FamilyFor`,
 * `Registry.checkFamily`, `Registry.webHandler`).
 *
 * @since 0.23.0
 */
export * as Registry from "./Registry.js";

/**
 * The server handler factory (`ResourceHandlers.make`,
 * `ResourceHandlers.readOnly`, `ResourceHandlers.related`).
 *
 * @since 0.23.0
 */
export * as ResourceHandlers from "./ResourceHandlers.js";
