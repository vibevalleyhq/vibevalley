// The server for the desktop app (apps/server): started as a child process on a port it picks (VIBEVALLEY_PORT=0), ready
// when it prints its address as one JSON line (--ready-json, ServerReady), stopped with SIGTERM so it saves on the way out.
// It runs on Electron's own Node (ELECTRON_RUN_AS_NODE), unbundled: the migrations, the word lists, PGlite's wasm and the
// coding agents' SDKs are found beside their packages, so the server keeps its node_modules.

import { execFile, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
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
export function loginShellPath(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const sh = env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    // The markers keep out what a profile prints on its own.
    execFile(sh, ["-ilc", 'printf "__VV_PATH__%s__VV_PATH__" "$PATH"'], { timeout: shellPathTimeoutMs, env }, (error, stdout) => {
      const found = /__VV_PATH__(.*?)__VV_PATH__/su.exec(stdout)?.[1];
      resolve(error || !found ? env.PATH : found);
    });
  });
}

export interface ServerFiles {
  /** apps/server: src/main.ts and its node_modules. */
  server: string;
  /** The built page (apps/web/dist), served at / on the server's origin. */
  web: string;
  /** Appended to: the server's stdout and stderr. */
  log: string;
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
export function startServer(files: ServerFiles, env: NodeJS.ProcessEnv, port = 0): Promise<RunningServer> {
  mkdirSync(dirname(files.log), { recursive: true });
  const log = createWriteStream(files.log, { flags: "a" });
  log.write(`--- ${new Date().toISOString()} vibevalley: starting ${files.server}\n`);
  // tsx and the tsconfig (whose paths are the server's @/ imports) are found from the cwd: the server's own.
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", "--ready-json", "--web", files.web], {
    cwd: files.server,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1", VIBEVALLEY_PORT: String(port) },
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

/** The one server the app runs: coming up, running, started again (in development), and stopped before the app quits,
 * a start still under way waited for, so it is stopped rather than left running. */
export function serverKeeper(files: ServerFiles, env: NodeJS.ProcessEnv) {
  let running: RunningServer | undefined;
  let starting: Promise<RunningServer> | undefined;
  return {
    /** Where the running one answers; undefined until it is up. */
    url: () => running?.url,
    start: async () => {
      starting = startServer(files, env);
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
      running = await startServer(files, env, Number(new URL(was.url).port));
      return running.url;
    },
    stop: async () => {
      const it = running ?? (await starting?.catch(() => undefined));
      running = undefined;
      await it?.stop();
    },
  };
}

export type ServerKeeper = ReturnType<typeof serverKeeper>;
