import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpServerError, HttpServerRequest } from "effect/http";
import { answeredAsDeployed } from "./core.js";

const request = HttpServerRequest.fromWeb(new Request("http://in-process.test/articles/1/moved"));

/** A router that fails the request with `reason`. */
const failingWith = (reason: HttpServerError.HttpServerErrorReason) =>
  Effect.fail(new HttpServerError.HttpServerError({ reason }));

describe("answeredAsDeployed (the in-process transport)", () => {
  it("answers a request no route serves with the router's own empty 404", async () => {
    const exit = await Effect.runPromiseExit(
      answeredAsDeployed(failingWith(new HttpServerError.RouteNotFound({ request }))),
    );
    expect(Exit.isSuccess(exit) && exit.value.status).toBe(404);
  });

  it("does not answer any other router failure: it dies, as it did before #168", async () => {
    // A deployed server's answer to these is not known, so reading one as a
    // 500 (or any status) would put words in the server's mouth.
    const reasons = [
      new HttpServerError.InternalError({ request }),
      new HttpServerError.RequestParseError({ request }),
    ];
    const exits = await Effect.runPromiseExit(
      Effect.forEach(reasons, (reason) => Effect.exit(answeredAsDeployed(failingWith(reason))), {
        concurrency: 1,
      }),
    );
    expect(
      Exit.isSuccess(exits) &&
        exits.value.map((exit) => Exit.isFailure(exit) && Cause.hasDies(exit.cause)),
    ).toEqual([true, true]);
  });
});
