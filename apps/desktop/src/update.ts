// The packaged app updates itself from the repository's GitHub releases. It is not signed, so macOS's own updater
// (Squirrel.Mac, which Electron's autoUpdater uses) cannot install it; this does what it would: read the latest release's
// release.json, download this Mac's build, check its size and SHA-512 against it, unpack it, and once this process has
// quit, put it in place of the running .app (the old one kept beside the download until the next update).
// It is trusted as the first download is: GitHub's HTTPS and the release's files.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { promisify } from "node:util";

import { Schema } from "effect";

import type { UpdateState } from "@vibevalley/protocol/host";

import { reasonOf } from "./lines";
import { type Build, bundleOf, buildFor, newer, placeProblem, plistVersion, Release, startsNewFarm } from "./releases";

/** The latest release's manifest; VIBEVALLEY_UPDATE_FEED points elsewhere (a local copy, to try an update). */
export const defaultFeed = "https://github.com/vibevalleyhq/vibevalley/releases/latest/download/release.json";

/** How often a running app asks again. */
const everyMs = 4 * 60 * 60 * 1000;

const readRelease = Schema.decodeUnknownSync(Release);

const writable = (path: string) => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

// Waits for the app to quit, then moves the running .app beside the download and the new one in its place; if the second
// move fails, the old one goes back. The quarantine a browser would add is taken off, and the app opened again if asked.
const swapScript = `#!/bin/sh
pid="$1"; current="$2"; next="$3"; old="$4"; reopen="$5"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
rm -rf "$old"
if mv "$current" "$old"; then
  if mv "$next" "$current"; then xattr -dr com.apple.quarantine "$current" 2>/dev/null; else mv "$old" "$current"; fi
fi
if [ "$reopen" = 1 ]; then open "$current"; fi
`;

export function updater(o: {
  /** The running app's version (app.getVersion()). */
  readonly version: string;
  readonly arch: string;
  /** The running executable (app.getPath("exe")). */
  readonly exe: string;
  /** The farm's home, whose db.schema says the baseline its database was made from. */
  readonly home: string;
  /** Where downloads go, a folder a version. */
  readonly dir: string;
  readonly feed: string;
  readonly heard: (state: UpdateState) => void;
}) {
  let state: UpdateState = { _tag: "idle", version: o.version };
  let staged: { app: string; newFarm: boolean; bundle: string } | undefined;
  const set = (next: UpdateState) => {
    state = next;
    o.heard(next);
  };

  const download = async (release: Release, build: Build, bundle: string) => {
    const folder = join(o.dir, release.version);
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    const zip = join(folder, build.file);
    const res = await fetch(new URL(build.file, o.feed));
    if (!res.ok || !res.body) throw new Error(`${build.file}: ${res.status}`);
    const hash = createHash("sha512");
    let got = 0;
    let shown = -1;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the same web stream: the DOM's and Node's types name it apart
    const counted = Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>).map((chunk: Buffer) => {
      hash.update(chunk);
      got += chunk.length;
      const percent = Math.floor((got / build.size) * 100);
      if (percent !== shown) set({ _tag: "downloading", version: o.version, next: release.version, percent: (shown = percent) });
      return chunk;
    });
    await pipeline(counted, createWriteStream(zip));
    if (got !== build.size || hash.digest("hex") !== build.sha512) throw new Error(`${build.file}: not the file the release lists`);
    // ditto keeps what a .app holds that unzip would lose (symlinks in the frameworks, extended attributes).
    await promisify(execFile)("ditto", ["-x", "-k", zip, folder]);
    const app = join(folder, bundle.slice(bundle.lastIndexOf("/") + 1));
    const plist = join(app, "Contents", "Info.plist");
    if (!existsSync(plist) || plistVersion(readFileSync(plist, "utf8")) !== release.version)
      throw new Error(`${build.file}: no VibeValley ${release.version} in it`);
    const mark = join(o.home, "db.schema");
    return { app, bundle, newFarm: startsNewFarm(release.schema, existsSync(mark) ? readFileSync(mark, "utf8") : undefined) };
  };

  const check = async () => {
    if (state._tag === "checking" || state._tag === "downloading" || state._tag === "ready") return;
    set({ _tag: "checking", version: o.version });
    try {
      const res = await fetch(o.feed);
      // No release yet.
      if (res.status === 404) return set({ _tag: "idle", version: o.version });
      if (!res.ok) throw new Error(`release.json: ${res.status}`);
      const release = readRelease(await res.json());
      if (!newer(release.version, o.version)) return set({ _tag: "idle", version: o.version });
      const manual = (why: Extract<UpdateState, { _tag: "manual" }>["why"]) =>
        set({ _tag: "manual", version: o.version, next: release.version, why, page: release.page });
      const build = buildFor(release, o.arch);
      if (!build) return manual("noBuild");
      const bundle = bundleOf(o.exe);
      const problem = bundle === undefined ? "readOnly" : placeProblem(bundle, writable(bundle) && writable(dirname(bundle)));
      if (bundle === undefined || problem !== undefined) return manual(problem ?? "readOnly");
      staged = await download(release, build, bundle);
      set({ _tag: "ready", version: o.version, next: release.version, notes: release.notes, newFarm: staged.newFarm });
    } catch (e) {
      set({ _tag: "failed", version: o.version, why: reasonOf(e) });
    }
  };

  /** Hands the staged app to the swap script, which waits for this process to go. */
  const swap = (reopen: boolean) => {
    if (!staged) return false;
    const script = join(o.dir, "swap.sh");
    writeFileSync(script, swapScript, { mode: 0o755 });
    const old = join(o.dir, "previous.app");
    spawn("/bin/sh", [script, String(process.pid), staged.bundle, staged.app, old, reopen ? "1" : "0"], { detached: true, stdio: "ignore" }).unref();
    staged = undefined;
    return true;
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    state: () => state,
    check,
    /** Checks now and every few hours. */
    start: () => {
      void check();
      timer = setInterval(() => void check(), everyMs);
    },
    stop: () => clearInterval(timer),
    /** Restarts into the new version: the caller has stopped the server and quits right after. */
    installNow: () => swap(true),
    /** On the way out: put in place what is ready, unless it starts a new farm, which waits for the owner. */
    installOnQuit: () => staged !== undefined && !staged.newFarm && swap(false),
  };
}

export type Updater = ReturnType<typeof updater>;
