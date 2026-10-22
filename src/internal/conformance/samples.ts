/**
 * The fixture's sample reads: the `/:type/:id` URL each `ids` sample resolves
 * a read endpoint to, and the status that URL answered in the run (#319).
 *
 * A sample that names a resource the server does not hold fails no rule, yet
 * every rule that reads it sees less of the api than the run suggests. The
 * ledger here records the answer as data, so a report can say so without a
 * reader matching a note's wording.
 *
 * @since 0.17.0
 * @internal
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import type { Context, Discovered, ResolvedOptions } from "./core.js";
import { jsonApiAccept } from "./core.js";

/**
 * One `ids` sample's read: the type and id, the URL it resolved the type's
 * `GET /:type/:id` endpoint to, and the status that URL answered — `0` when
 * no answer was obtained (the transport failed, or a redirect was left
 * unfollowed).
 *
 * @internal
 */
export interface SampleRecord {
  readonly type: string;
  readonly id: string;
  readonly url: string;
  readonly status: number;
}

/** `true` for a `2xx` status — a sample that resolved. */
export const resolved = (sample: SampleRecord): boolean =>
  sample.status >= 200 && sample.status < 300;

/**
 * Every `/:type/:id` read the run's `ids` resolve: a `GET` endpoint of the
 * `resource` role with one path parameter and no `paths` override, keyed on
 * its type's sample id, once per URL, in discovery order.
 *
 * @internal
 */
export const targets = (
  endpoints: ReadonlyArray<Discovered>,
  options: ResolvedOptions,
): ReadonlyArray<Omit<SampleRecord, "status">> =>
  Arr.dedupeWith(
    Arr.filterMap(endpoints, (endpoint) => {
      const type = endpoint.segment;
      const id = type === undefined ? undefined : options.ids[type];
      const overridden = options.paths[`${endpoint.group}.${endpoint.name}`] !== undefined;
      if (endpoint.role !== "resource" || endpoint.params.length !== 1 || overridden)
        return Result.failVoid;
      if (type === undefined || id === undefined) return Result.failVoid;
      const url = endpoint.path.replace(`:${endpoint.params[0]}`, encodeURIComponent(id));
      return Result.succeed({ type, id, url });
    }),
    (left, right) => left.url === right.url,
  );

/** A probe that reads a URL plainly: a `GET` with no body and the default `Accept`. */
const plainRead = (probe: Parameters<Context["request"]>[0]): boolean =>
  (probe.method ?? "GET") === "GET" &&
  probe.body === undefined &&
  (probe.headers === undefined ||
    (Rec.keys(probe.headers).length === 1 && probe.headers["accept"] === jsonApiAccept["accept"]));

/**
 * The run's sample ledger: the status the first plain read of each sample URL
 * answered, recorded by {@link recording} and read by {@link snapshot}.
 *
 * @internal
 */
export interface Ledger {
  readonly baseUrl: string;
  readonly targets: ReadonlyArray<Omit<SampleRecord, "status">>;
  readonly answered: MutableHashMap.MutableHashMap<string, number>;
}

/** @internal */
export const ledger = (endpoints: ReadonlyArray<Discovered>, options: ResolvedOptions): Ledger => ({
  baseUrl: options.baseUrl.replace(/\/$/, ""),
  targets: targets(endpoints, options),
  answered: MutableHashMap.empty(),
});

/**
 * `request`, recording in `ledger` the status of the first plain read (see
 * {@link plainRead}) of each sample URL a rule sends — relative, as the rules
 * resolve it, or absolute under the base URL, as a followed link names it.
 *
 * @internal
 */
export const recording =
  (request: Context["request"], ledger: Ledger): Context["request"] =>
  (probe) =>
    Effect.tap(request(probe), (observation) =>
      Effect.sync(() => {
        if (!plainRead(probe)) return;
        const path = probe.url.startsWith(ledger.baseUrl)
          ? probe.url.slice(ledger.baseUrl.length)
          : probe.url;
        const known = ledger.targets.some((sample) => sample.url === path);
        if (!known || MutableHashMap.has(ledger.answered, path)) return;
        MutableHashMap.set(ledger.answered, path, observation.status);
      }),
    );

/**
 * Every sample the run read, with the status it answered, in discovery order.
 * A sample no rule read plainly — the run selected no rule that reads it — is
 * left out rather than read here, so a run sends only the requests its rules
 * send.
 *
 * @internal
 */
export const snapshot = (ledger: Ledger): ReadonlyArray<SampleRecord> =>
  Arr.filterMap(ledger.targets, (sample) =>
    Option.match(MutableHashMap.get(ledger.answered, sample.url), {
      onNone: () => Result.failVoid,
      onSome: (status) => Result.succeed({ ...sample, status }),
    }),
  );
