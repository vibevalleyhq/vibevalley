// The server for the desktop app (apps/server): started as a child process on a port it picks (VIBEVALLEY_PORT=0), ready
// when it prints its address as one JSON line (--ready-json, ServerReady), stopped with SIGTERM so it saves on the way out.
// Packaged, it is the bundle (apps/server's `vp pack`, dist/main.mjs) on Electron's own Node (ELECTRON_RUN_AS_NODE), with
// its dependencies' node_modules beside it; run from the repository, it is the source through vpx, as `vp run start` runs
// it (paths.ts says which).

import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { Schema } from "effect";

import { t } from "@vibevalley/i18n";

import { jsonLines } from "./lines";

/** The first start builds the database. */
const startTimeoutMs = 40_000;
/** How long a stopping server has to save and exit before it is killed. */
const stopTimeoutMs = 8_000;

/** How long the login shell has to say its PATH. */
const shellPathTimeoutMs = 5_000;

/** The PATH a terminal has. An app opened from Finder or at login gets launchd's short one, which has none of pi,
 * claude or codex; the login shell's is the one the owner installed them on. Unanswered, the app's own. */
function loginShellPath(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const sh = env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    // The markers keep out what a profile prints on its own.
    execFile(sh, ["-ilc", 'printf "__VV_PATH__%s__VV_PATH__" "$PATH"'], { timeout: shellPathTimeoutMs, env }, (error, stdout) => {
      const found = /__VV_PATH__(.*?)__VV_PATH__/su.exec(stdout)?.[1];
      resolve(error || !found ? env.PATH : found);
    });
  });
}

/**
 * The PATH to start the server with: the login shell's as it said it last time, kept in `kept`, so the server does not
 * wait on the shell (a profile can take a second or more); the shell is asked again all the same and its answer kept for
 * the next start. With none kept yet (the first start) it waits. A tool installed since is found from the next start.
 */
export async function shellPath(
  kept: string,
  env: NodeJS.ProcessEnv,
  ask = loginShellPath,
): Promise<{ readonly path: string | undefined; readonly refreshed: Promise<unknown> }> {
  let last: string | undefined;
  // None kept is the first start; one that cannot be read is told and the shell asked as on a first start.
  if (existsSync(kept))
    try {
      last = readFileSync(kept, "utf8").trim() || undefined;
    } catch (e) {
      console.error("vibevalley: the kept PATH could not be read; the login shell is waited on:", e);
    }
  const asked = ask(env).then((path) => {
    if (path && path !== last)
      try {
        mkdirSync(dirname(kept), { recursive: true });
        writeFileSync(kept, path);
      } catch (e) {
        // Safe to go on: this start has its PATH; the next one asks the shell again.
        console.error("vibevalley: the login shell's PATH could not be kept:", e);
      }
    return path;
  });
  // refreshed: the shell answered and what it said is kept.
  return last === undefined ? { path: await asked, refreshed: asked } : { path: last, refreshed: asked };
}

export interface ServerFiles {
  /** apps/server, or the packaged app's copy: the folder the server runs in. */
  server: string;
  /** What runs it, before its own flags: the executable and its arguments. */
  command: readonly [string, ...string[]];
  /** The built page (apps/web/dist), served at / on the server's origin. */
  web: string;
  /** Appended to: the server's stdout and stderr. */
  log: string;
  /** Node's compile cache for the server (NODE_COMPILE_CACHE): its modules' compiled code, kept between starts. */
  compileCache: string;
}

export interface RunningServer {
  /** Where the page and the API answer, with no slash at the end. */
  url: string;
  stop(): Promise<void>;
}

/** The line the server prints once it listens (--ready-json). */
const ServerReady = Schema.Struct({ url: Schema.String });

/** port 0 picks a free one; a restart in development (dev.ts) asks for the one it had, so the page keeps its origin and
 * what it stored there. */
function startServer(files: ServerFiles, env: NodeJS.ProcessEnv, port = 0): Promise<RunningServer> {
  mkdirSync(dirname(files.log), { recursive: true });
  const log = createWriteStream(files.log, { flags: "a" });
  log.write(`--- ${new Date().toISOString()} vibevalley: starting ${files.server}\n`);
  const [bin, ...args] = files.command;
  const child = spawn(bin, [...args, "--ready-json", "--web", files.web], {
    cwd: files.server,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1", VIBEVALLEY_PORT: String(port), NODE_COMPILE_CACHE: files.compileCache },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.pipe(log, { end: false });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), stopTimeoutMs);
      await exited;
      clearTimeout(timer);
    }
    log.end();
  };

  return new Promise((resolve, reject) => {
    const fail = (reason: string) => {
      void stop();
      reject(new Error(t("desktop.seeLog", { reason, log: files.log })));
    };
    const timer = setTimeout(() => fail(t("desktop.noAddress", { seconds: startTimeoutMs / 1000 })), startTimeoutMs);
    child.once("error", (e) => {
      clearTimeout(timer);
      fail(t("desktop.failed", { why: e.message }));
    });
    void exited.then((code) => {
      clearTimeout(timer);
      fail(t("desktop.exited", { code: String(code) }));
    });
    let ready = false;
    jsonLines(
      child.stdout,
      ServerReady,
      ({ url }) => {
        if (ready) return;
        ready = true;
        clearTimeout(timer);
        resolve({ url: url.replace(/\/$/u, ""), stop });
      },
      (line) => log.write(line + "\n"),
    );
  });
}

/** stop waits for a start still under way, so that server is stopped rather than left running. */
export function serverKeeper(
  files: ServerFiles,
  env: NodeJS.ProcessEnv,
  start: (files: ServerFiles, env: NodeJS.ProcessEnv, port?: number) => Promise<RunningServer> = startServer,
) {
  let running: RunningServer | undefined;
  let starting: Promise<RunningServer> | undefined;
  return {
    /** Where the running one answers; undefined until it is up. */
    url: () => running?.url,
    start: async () => {
      starting = start(files, env);
      try {
        running = await starting;
        return running.url;
      } finally {
        starting = undefined;
      }
    },
    /** The same port again, so the page keeps its origin and what it stored there. */
    restart: async () => {
      const was = running;
      if (!was) return undefined;
      await was.stop();
      // The old one is gone before the new one starts: a stop now has to reach the start under way, not the stopped server.
      running = undefined;
      starting = start(files, env, Number(new URL(was.url).port));
      try {
        running = await starting;
        return running.url;
      } finally {
        starting = undefined;
      }
    },
    stop: async () => {
      const it = running ?? (await starting?.catch(() => undefined));
      running = undefined;
      await it?.stop();
    },
  };
}

export type ServerKeeper = ReturnType<typeof serverKeeper>;
