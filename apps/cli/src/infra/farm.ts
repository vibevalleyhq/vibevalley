import { connect as dial, type Socket } from "node:net";

import { connect } from "@vibevalley/bridge";
import { socketLink } from "@vibevalley/bridge/socket";
import { controlSocketOf, homeOf, signedIn } from "@vibevalley/home";
import { t } from "@vibevalley/i18n";
import { type Preview, VibeValleyApi, VibeValleyApiError } from "@vibevalley/protocol";
import { ApiErrorEnvelope, type ApiErrorKind, bizCodeMeta } from "@vibevalley/protocol/api";
import { desktopControl } from "@vibevalley/protocol/host";

import { type Ctx, show } from "#/base/format.ts";
import { exit, Failure, type Io } from "#/base/output.ts";

import { sseData } from "./sse.ts";

/** The server a URL is on, as a sign-in is kept: its origin, whatever path or trailing slash it was given with. */
export const serverOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    // Not a URL: kept as it was given, and compared as such.
    return url;
  }
};

/** The farm's home as the command line's environment says (VIBEVALLEY_HOME, the launcher sets it per channel); a
 * test gives its own environment. */
export const farmHome = (io: Io) => io.env.VIBEVALLEY_HOME || homeOf({});

/** The app the launcher was started from, to open when it is not running; none from the repository. */
export const launchedFrom = (io: Io) => io.env.VIBEVALLEY_APP ?? "";

/** The key to send to base: the home's sign-in's, when base is the server signed in to; none for any other. */
const keyIn = (home: string, base: string): string | undefined => {
  const saved = signedIn(home);
  return saved !== undefined && serverOf(saved.server) === serverOf(base) ? saved.key : undefined;
};

const codeOf: Readonly<Record<ApiErrorKind, number>> = {
  InvalidInput: exit.usage,
  Unauthorized: exit.refused,
  Forbidden: exit.refused,
  Missing: exit.missing,
  Refused: exit.refused,
  VoiceUnavailable: exit.refused,
  VoiceCallFailed: exit.other,
  InternalError: exit.other,
  BadGateway: exit.other,
  ServiceUnavailable: exit.refused,
};

/** The innermost reason a request did not leave: fetch's "fetch failed" hides ECONNREFUSED in its cause. */
function innermost(e: unknown): string {
  let at: unknown = e;
  while (at instanceof Error && at.cause instanceof Error) at = at.cause;
  return at instanceof Error ? at.message : String(e);
}

const unreachable = (base: string, e: unknown) =>
  new Failure({
    code: exit.unreachable,
    tag: "Unreachable",
    text: t("cli.failure.unreachable", { base, why: innermost(e) }),
    next: [{ say: t("cli.next.openApp"), run: ["app", "open"] }, { say: t("cli.next.startServer") }],
  });

const apiErrorOf = (text: string) => {
  try {
    const got = ApiErrorEnvelope.safeParse(JSON.parse(text));
    return got.success ? got.data : undefined;
  } catch {
    // Not JSON: an answer that is no envelope, said as it came.
    return undefined;
  }
};

const failureOf = (status: number, text: string): Failure => {
  const env = apiErrorOf(text);
  if (env === undefined)
    return new Failure({ code: status === 404 ? exit.missing : status === 400 ? exit.usage : exit.other, tag: "Server", text: text.trim(), status });
  const meta = bizCodeMeta[env.bizCode];
  return new Failure({
    code: codeOf[meta.kind],
    tag: meta.kind,
    text: env.message,
    bizCode: env.bizCode,
    status,
    ...(env.error?.next ? { next: env.error.next } : {}),
  });
};

/** /api/v1/state SSE frames (or another SSE path's) as they come: each event's data. Returning early lets go of the
 * connection. */
export async function* frames(io: Io, base: string, path: string, signal: AbortSignal = io.signal): AsyncGenerator<string> {
  const key = keyIn(farmHome(io), base);
  const held = new AbortController();
  const stop = () => held.abort(signal.reason);
  if (signal.aborted) stop();
  signal.addEventListener("abort", stop, { once: true });
  try {
    let res: Response;
    try {
      res = await io.fetch(base + path, {
        headers: { accept: "text/event-stream", ...(key === undefined ? {} : { authorization: `Bearer ${key}` }) },
        signal: held.signal,
      });
    } catch (e) {
      throw unreachable(base, e);
    }
    if (res.status !== 200) {
      let body: string;
      try {
        body = await res.text();
      } catch (e) {
        throw unreachable(base, e);
      }
      throw failureOf(res.status, body);
    }
    if (res.body === null) return;
    try {
      yield* sseData(res.body, held.signal);
    } catch (e) {
      if (e instanceof Failure) throw e;
      throw unreachable(base, e);
    }
  } finally {
    signal.removeEventListener("abort", stop);
    held.abort();
  }
}

function failureFrom(base: string, e: unknown): Failure {
  if (e instanceof Failure) return e;
  if (!(e instanceof VibeValleyApiError)) return unreachable(base, e);
  const code = e.tag ? codeOf[e.tag] : e.status === 404 ? exit.missing : e.status === 400 ? exit.usage : exit.other;
  return new Failure({
    code,
    tag: e.tag ?? "Server",
    text: e.reason,
    ...(e.bizCode !== undefined ? { bizCode: e.bizCode } : {}),
    status: e.status,
    next: e.error?.next ?? [],
  });
}

/** One question to the farm at base, typed by the endpoint it calls; with the key when base is the server signed in to.
 * Every request of it lets go when the run is stopped. */
export const askAt =
  (io: Io, base: string) =>
  async <A>(use: (api: VibeValleyApi) => Promise<A>): Promise<A> => {
    const fetcher = (url: string, init: RequestInit) => io.fetch(url, { ...init, signal: init.signal ?? io.signal });
    try {
      return await use(new VibeValleyApi(base, fetcher, keyIn(farmHome(io), base)));
    } catch (e) {
      throw failureFrom(base, e);
    }
  };

/** One question to the farm at --server. */
export const ask = <A>(ctx: Ctx, use: (api: VibeValleyApi) => Promise<A>) => askAt(ctx, ctx.flags.server)(use);

/** A change, or with --dry-run what it would do: by the endpoint's own dry run where it has one; a change with none is
 * refused rather than made. */
export const change = async <A>(
  ctx: Ctx,
  o: {
    readonly name: string;
    readonly preview?: (api: VibeValleyApi) => Promise<Preview>;
    readonly does: (api: VibeValleyApi) => Promise<A>;
    readonly said: (done: A) => string;
    readonly as?: (done: A) => unknown;
  },
): Promise<void> => {
  if (ctx.flags.dryRun) {
    if (!o.preview) throw new Failure({ code: exit.usage, tag: "NoDryRun", text: t("cli.failure.noDryRun", { command: o.name }) });
    const answer = await ask(ctx, o.preview);
    return show(ctx, answer, (p) => p.does.join("\n"));
  }
  const done = await ask(ctx, o.does);
  show(ctx, o.as ? o.as(done) : done, () => o.said(done));
};

type AppCalls = ReturnType<typeof connect<typeof desktopControl>>["call"];

export const notOpen = (home: string, why: string) =>
  new Failure({
    code: exit.unreachable,
    tag: "AppNotOpen",
    text: t("cli.failure.appNotOpen", { home, why }),
    next: [{ say: t("cli.next.openApp"), run: ["app", "open"] }],
  });

const dialed = (home: string) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = dial(controlSocketOf(home));
    socket.once("connect", () => resolve(socket));
    socket.once("error", (e) => {
      socket.destroy();
      reject(notOpen(home, e.message));
    });
  });

/** One question to the desktop app, on a connection of its own. */
export const askApp = async <A>(io: Io, use: (calls: AppCalls) => Promise<A>): Promise<A> => {
  const socket = await dialed(farmHome(io));
  try {
    const asked = connect(desktopControl, socketLink(socket));
    try {
      return await use(asked.call);
    } catch (e) {
      throw new Failure({ code: exit.refused, tag: "AppRefused", text: e instanceof Error ? e.message : String(e) });
    }
  } finally {
    socket.destroy();
  }
};

/** Which app answers on this farm's socket; fails AppNotOpen when none does (doctor reads it too). */
export const appStatus = (io: Io) => askApp(io, (c) => c.status());
