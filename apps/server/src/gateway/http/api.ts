import { AsyncLocalStorage } from "node:async_hooks";

import { Hono } from "hono";

import { type Clock, isAbort, systemClock } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import { artifactPrefix, attachmentMax, attachmentPath } from "@vibevalley/protocol";
import { ApiError, BizCode, type Endpoint, endpoints, type Handlers, pathOf } from "@vibevalley/protocol/api";
import { artifactId } from "@vibevalley/protocol/schema";

import { bizError, messageOf } from "#/base/errors.ts";
import { problemOf, wireJson } from "#/base/json.ts";
import type { Logger } from "#/infra/log.ts";
import { counter } from "#/infra/metrics.ts";
import type { Artifact } from "#/modules/artifact/artifact.ts";
import { artifactHeaders, artifactPrintHeaders } from "#/modules/artifact/policy.ts";
import { shellThemeOf, withShell } from "#/modules/artifact/shell.ts";
import type { Attachment } from "#/modules/attachment/attachment.ts";

import { empty, fileResponse, notFound, replyError, textUpTo } from "./respond.ts";
import { fromTheFarm } from "./rpc.ts";

/** The request an endpoint's handler is answering, for the few handlers that ask who sent it (user.ts, repo.ts). Unset when
 * a handler is called from anywhere but the HTTP API. */
const current = new AsyncLocalStorage<Headers>();

/** The headers of the request the running handler answers; undefined when it was not called over HTTP. */
export const requestHeaders = (): Headers | undefined => current.getStore();

/** The most a body may be, read before it is decoded: an attachment comes as base64 in JSON, everything else is small. */
const bodyMax = 2 * 1024 * 1024;
const attachmentBodyMax = Math.ceil(attachmentMax / 3) * 4 + 64 * 1024;
const bodyMaxOf = (endpoint: Endpoint) => (endpoint.op === "attachment.create" ? attachmentBodyMax : bodyMax);

/** Each call of an endpoint, by its op and the status it answered. */
const requests = (op: string, status: number) => counter(`vibevalley.http.requests.${op}.${status}`);

const forbidden = () => replyError(bizError(BizCode.Forbidden, "forbidden"));

const okJson = (text: string) => new Response(text, { status: 200, headers: { "content-type": "application/json" } });

async function serve(endpoint: Endpoint, handle: (input: unknown) => Promise<unknown>, request: Request, log: Logger): Promise<Response> {
  if (!fromTheFarm(request.headers)) return forbidden();
  let input: unknown;
  if (endpoint.input) {
    const max = bodyMaxOf(endpoint);
    // A body that says it is too big is refused before it is read; one that grows past the limit on the way stops there.
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > max) return replyError(bizError(BizCode.PayloadTooLarge, `the body is ${length} bytes, at most ${max}`));
    const text = await textUpTo(request, max);
    if (text === undefined) return replyError(bizError(BizCode.PayloadTooLarge, `the body grew past ${max}`));
    let json: unknown;
    try {
      json = JSON.parse(text === "" ? "{}" : text);
    } catch (e) {
      return replyError(bizError(BizCode.InvalidInput, messageOf(e)));
    }
    const decoded = endpoint.input.safeParse(json);
    if (!decoded.success) return replyError(bizError(BizCode.InvalidInput, problemOf(decoded.error)));
    input = decoded.data;
  }
  try {
    const out = await current.run(request.headers, () => handle(input));
    if (!endpoint.result) return okJson(JSON.stringify({ bizCode: 0, message: "ok" }));
    // The same Schema the clients read it back with: a result that does not fit it is the server's bug, a 500.
    return okJson(`{"bizCode":0,"message":"ok","data":${wireJson(endpoint.result)(out)}}`);
  } catch (e) {
    if (e instanceof ApiError) return replyError(e);
    // A handler aborted under it (the farm closing) answers nothing: the caller retries elsewhere.
    if (isAbort(e)) return empty(503);
    log.error(`an endpoint failed: ${endpoint.op}`, e);
    return replyError(bizError(BizCode.InternalError, messageOf(e)));
  }
}

export interface ApiOptions {
  /** Only the endpoints a caller may call (the lan listener's); every one when absent. */
  readonly only?: (e: Endpoint) => boolean;
  readonly log?: Logger;
}

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => quiet };

/** Routes every endpoint, or only those a caller may call. The handlers have their services already. */
export function api(handlers: Handlers, options: ApiOptions = {}): Hono {
  const log = options.log ?? quiet;
  const app = new Hono();
  for (const e of endpoints) {
    if (options.only && !options.only(e)) continue;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- each handler takes its endpoint's input, which serve decodes with e.input
    const handle = handlers[e.op] as (input: unknown) => Promise<unknown>;
    app.post(pathOf(e.op), async (c) => {
      const res = await serve(e, handle, c.req.raw, log);
      requests(e.op, res.status).add();
      return res;
    });
  }
  return app;
}

// The one read that is a GET, since a page's <img src> can only GET. Named by its sha256, a file never changes: cached for good.
const attachmentPrefix = attachmentPath("");
const inline = (type: string) => /^(image|video|audio)\//u.test(type) || type === "application/pdf";

export function attachments(deps: { readonly attachment: Attachment; readonly log: Logger }): Hono {
  const app = new Hono();
  app.get("/api/v1/attachment/:id", async (c) => {
    try {
      const id = new URL(c.req.url).pathname.slice(attachmentPrefix.length);
      if (!/^[0-9a-f]{64}$/u.test(id)) return notFound();
      const found = await deps.attachment.get(id);
      if (!found) return notFound();
      const pdf = found.type === "application/pdf";
      const res = await fileResponse(found.path, {
        contentType: found.type,
        headers: {
          "cache-control": "private, max-age=31536000, immutable",
          // Shown in the page (an image, a video, a sound) or a tab of its own (a PDF), else saved: never run as one of the farm's own pages.
          "content-disposition": `${inline(found.type) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(found.name)}`,
          "x-content-type-options": "nosniff",
          ...(pdf ? {} : { "content-security-policy": "sandbox" }),
        },
      });
      return res ?? notFound();
    } catch (e) {
      deps.log.error("vibevalley: attachment failed", e);
      return new Response(messageOf(e) + "\n", { status: 500 });
    }
  });
  return app;
}

// A GET since an <iframe src> can only GET. a version never changes once made, so it is cached for good.
export function artifactContent(deps: { readonly artifact: Artifact; readonly log: Logger }): Hono {
  const app = new Hono();
  app.get("/api/v1/artifact/:id/:version", async (c) => {
    try {
      const url = new URL(c.req.url);
      const [id = "", version = ""] = url.pathname.slice(artifactPrefix.length).split("/");
      if (!/^[0-9a-f-]{36}$/u.test(id) || !/^[1-9]\d*$/u.test(version)) return notFound();
      const path = await deps.artifact.file(artifactId(id), Number(version));
      if (!path) return notFound();
      const contentType = artifactHeaders["content-type"] ?? "text/html; charset=utf-8";
      const asked = url.searchParams;
      if (asked.get("shell") !== "1") return (await fileResponse(path, { contentType, headers: artifactHeaders })) ?? notFound();
      // The workbench's view: the page with the runtime after it, for how it is shown and in the workbench's theme (artifact/shell.ts).
      const page = await deps.artifact.content(artifactId(id), Number(version));
      const shown = await deps.artifact.get(artifactId(id));
      // ?print=1 is that page opened on its own to be printed: only it may open the print dialog.
      const headers = asked.get("print") === "1" ? artifactPrintHeaders : artifactHeaders;
      return new Response(withShell({ page: page.content, display: shown.display ?? "page", theme: shellThemeOf(asked.get("theme")) }), {
        headers: { ...headers, "content-type": contentType },
      });
    } catch (e) {
      if (e instanceof ApiError && e.kind === "Missing") return notFound();
      deps.log.error("vibevalley: artifact failed", e);
      return new Response(messageOf(e) + "\n", { status: 500 });
    }
  });
  return app;
}

// A client's request key: the same key again gets the first request's result, and the work is done once.

/** As long as a chat message's sendKey may be. */
export const requestKeyMax = 64;

/** Keys remembered per op: a retry comes within seconds, so the newest few hundred are plenty. */
const remembered = 500;
const requestKeyTtlMs = 5 * 60_000;

/** One op's memo, in memory: a restart forgets every key. Duplicates wait for the first write. The work is never handed
 * the caller's signal, so a caller that disconnects mid-write still leaves its result for the retry; a failure forgets
 * the key at once. */
export const requestKeys = <A>(clock: Clock = systemClock) => {
  const seen = new Map<string, { readonly done: Promise<A>; expiresAt: number }>();
  return async (key: string | undefined, work: () => Promise<A>): Promise<A> => {
    if (key === undefined || key === "") return work();
    if (key.length > requestKeyMax) throw bizError(BizCode.RequestKeyTooLong, t("server.base.requestKeyLong", { max: requestKeyMax }));
    const first = seen.get(key);
    if (first !== undefined && first.expiresAt > clock.now()) return first.done;
    const done = Promise.withResolvers<A>();
    // A duplicate that waits handles the rejection itself; nobody waiting is no unhandled rejection.
    done.promise.catch(() => {});
    const mine = { done: done.promise, expiresAt: Number.POSITIVE_INFINITY };
    seen.delete(key);
    seen.set(key, mine);
    // Map keeps insertion order: the first key is the oldest.
    for (const old of seen.keys()) {
      if (seen.size <= remembered) break;
      seen.delete(old);
    }
    try {
      const a = await work();
      mine.expiresAt = clock.now() + requestKeyTtlMs;
      done.resolve(a);
      return a;
    } catch (e) {
      if (seen.get(key) === mine) seen.delete(key);
      done.reject(e);
      throw e;
    }
  };
};
