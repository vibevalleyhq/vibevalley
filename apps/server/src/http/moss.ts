// A page's line to MOSS Live (voice/moss.ts relay): a WebSocket at mossLinePath, for the farm's own page only, as the
// RPC socket is (rpc.ts fromTheFarm). The key stays on the server; with none saved the upgrade is refused with why.

import { mossLinePath } from "@vibevalley/protocol";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Voice } from "@/voice/voice.ts";
import { fromTheFarm } from "./rpc.ts";

export const mossLine = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const voice = yield* Voice;
    yield* router.add(
      "GET",
      mossLinePath,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!fromTheFarm(request.headers)) return HttpServerResponse.text("not the farm's page", { status: 403 });
        const problem = voice.mossProblem();
        if (problem) return HttpServerResponse.text(problem, { status: 409 });
        const page = yield* Effect.orDie(request.upgrade);
        yield* voice.mossLine(page);
        return HttpServerResponse.empty();
      }),
    );
  }),
);
