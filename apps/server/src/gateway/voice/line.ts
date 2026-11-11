import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Cause, Clock, Effect, type Fiber, Schedule, Schema, Semaphore } from "effect";
import { type HttpClient, HttpServerRequest, HttpServerResponse } from "effect/http";

import { t } from "@vibevalley/i18n";

import { errnoOf, messageOf } from "#/base/errors.ts";
import { afterRealTime } from "#/infra/time.ts";
import { chatCompletions } from "#/modules/orchestrator/openai.ts";
import { type Orchestrator } from "#/modules/orchestrator/orchestrator.ts";

import { type CallLine } from "./agora.ts";

/** A new quick tunnel's address takes a while to answer (seen: about 25 s). */
const lineReadyMs = 60_000;
/** So calling again does not wait for a new tunnel. */
const lineLingerMs = 10 * 60_000;

const quickTunnel = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/u;

/** A tunnel's public address and how to close it. */
export interface Tunnel {
  readonly url: string;
  readonly close: () => void;
}

/** Why the voice line cannot be had now; the message is the user's. */
export class LineFailed extends Schema.TaggedError<LineFailed, { readonly brand: unique symbol }>()("LineFailed", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const cloudflared = (port: number) =>
  Effect.callback<Tunnel, LineFailed>((resume) => {
    let child: ChildProcess;
    try {
      child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resume(Effect.fail(LineFailed.make({ message: messageOf(e), cause: e })));
    }
    const close = () => child.kill();
    let settled = false;
    const settle = (e: Effect.Effect<Tunnel, LineFailed>) => {
      if (settled) return;
      settled = true;
      cancel();
      resume(e);
    };
    const failWith = (message: string) => settle(Effect.fail(LineFailed.make({ message })));
    // A real process: its deadline is real time.
    const cancel = afterRealTime(30_000, () => {
      close();
      failWith(t("server.voice.tunnel.timedOut"));
    });
    // cloudflared says its address on either stream; both are read until it exits, so it never blocks on a write.
    const read = (b: Buffer) => {
      const url = quickTunnel.exec(b.toString())?.[0];
      if (url) settle(Effect.succeed({ url, close }));
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", (e) => failWith(errnoOf(e) === "ENOENT" ? t("server.voice.tunnel.missing") : e.message));
    child.on("exit", () => failWith(t("server.voice.tunnel.exited")));
    // Given up on before it said its address: the process goes too.
    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      cancel();
      close();
    });
  });

/** The line refusing a keyless request counts as an answer. Asked over the real network every 2 s. */
export const tunnelAnswers = (client: HttpClient.HttpClient, url: string) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + lineReadyMs;
    const every = 2_000;
    return yield* client.post(url + "/llm/ready/chat/completions").pipe(
      Effect.timeout("5 seconds"),
      Effect.option,
      Effect.map((res) => res._tag === "Some" && res.value.status === 401),
      Effect.repeat(
        Schedule.spaced(every).pipe(
          Schedule.setInputType<boolean>(),
          Schedule.while(({ input, now }) => !input && now + every < deadline),
          Schedule.passthrough,
        ),
      ),
    );
  });

interface VoiceLineEnv {
  readonly port: number;
  readonly url: string;
  readonly tunnel?: ((port: number) => Effect.Effect<Tunnel, LineFailed>) | undefined;
  readonly httpClient: HttpClient.HttpClient;
  readonly answerer: ReturnType<Orchestrator["Service"]["answerer"]>;
  readonly forkHere: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly isStopped: () => boolean;
}

export const makeVoiceLine = (env: VoiceLineEnv) =>
  Effect.gen(function* () {
    const { httpClient, answerer, forkHere, isStopped } = env;
    // The voice line: local only, like the farm; the tunnel is the one way in from outside.
    const keys = new Map<string, string>();
    let line = false;
    let linePort = env.port;
    let lineProblem = "";
    let tunnel: Tunnel | undefined;
    /** What cancels closing the tunnel, lineLingerMs after the last call. */
    let closing: (() => void) | undefined;
    const answer = chatCompletions({ answerer, misheard: t("server.voice.misheard") });
    const route = /^\/llm\/([\w-]+)\/chat\/completions$/u;
    // A call's own key on its own path; anything else is not there or not let in.
    const lineHandler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const m = route.exec(request.url.split("?")[0] ?? "");
      if (request.method !== "POST" || !m?.[1]) return HttpServerResponse.empty({ status: 404 });
      const key = keys.get(m[1]);
      if (!key || request.headers.authorization !== "Bearer " + key)
        return HttpServerResponse.jsonUnsafe({ error: { message: "unauthorized" } }, { status: 401 });
      return yield* answer;
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        () => Effect.succeed(HttpServerResponse.empty({ status: 502 })),
      ),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        keys.clear();
        closing?.();
        tunnel?.close();
        tunnel = undefined;
      }),
    );
    const server = createServer();
    yield* NodeHttpServer.make(() => server, { host: "127.0.0.1", port: linePort }).pipe(
      Effect.matchEffect({
        onFailure: (failure) => {
          lineProblem = t("server.voice.lineDown", { why: messageOf(failure.cause) });
          return Effect.logError(`vibevalley: the voice line cannot listen on 127.0.0.1:${linePort}: ${messageOf(failure.cause)}`);
        },
        onSuccess: (http) =>
          Effect.gen(function* () {
            if (http.address._tag !== "UnixPathAddress") linePort = http.address.port;
            yield* http.serve(lineHandler);
            // Its close waits for every socket: an answer still streaming is cut first.
            yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()));
            line = true;
          }),
      }),
    );

    const openTunnel =
      env.tunnel ??
      ((port: number) =>
        Effect.tap(cloudflared(port), (item) =>
          Effect.flatMap(tunnelAnswers(httpClient, item.url), (answers) =>
            answers ? Effect.void : Effect.logInfo(`vibevalley: the voice line's tunnel ${item.url} does not answer yet; the call goes on`),
          ),
        ));
    // Opening a tunnel waits for it to answer, through this very line: one opening at a time.
    const opening = yield* Semaphore.make(1);
    const lineClosed = () => LineFailed.make({ message: t("server.voice.lineClosed") });
    const base = Effect.suspend(() => {
      if (env.url) return Effect.succeed(env.url.replace(/\/+$/u, ""));
      closing?.();
      closing = undefined;
      return opening.withPermits(1)(
        Effect.gen(function* () {
          if (tunnel) return tunnel.url;
          const item = yield* openTunnel(linePort);
          if (isStopped()) {
            item.close();
            return yield* lineClosed();
          }
          tunnel = item;
          return item.url;
        }),
      );
    });
    const open = Effect.gen(function* () {
      if (isStopped()) return yield* lineClosed();
      if (lineProblem) return yield* LineFailed.make({ message: lineProblem });
      if (!line) return yield* LineFailed.make({ message: t("server.voice.lineNotOpen") });
      const url = yield* base;
      if (isStopped()) return yield* lineClosed();
      const id = randomBytes(8).toString("hex");
      const key = randomBytes(24).toString("base64url");
      keys.set(id, key);
      return { id, key, url: url + "/llm/" + id + "/chat/completions" } satisfies CallLine;
    });
    const close = (id: string) => {
      keys.delete(id);
      if (keys.size > 0 || !tunnel) return;
      closing?.();
      const lingering = forkHere(
        Effect.sleep(lineLingerMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              closing = undefined;
              if (keys.size > 0 || !tunnel) return;
              tunnel.close();
              tunnel = undefined;
            }),
          ),
        ),
      );
      closing = () => lingering.interruptUnsafe();
    };

    return {
      open,
      close,
      lines: () => keys.size,
    };
  });
