import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { type RunningServer, type ServerFiles, serverKeeper, shellPath } from "./server";

const files: ServerFiles = { server: "/server", web: "/web", log: "/tmp/vibevalley-server-test.log", compileCache: "/tmp/vibevalley-compile-cache" };

test("a stop while a restart is starting stops the new server, not the one already gone", async () => {
  const stops: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  let secondStarted: () => void = () => undefined;
  const second = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });
  const start = async (_files: ServerFiles, _env: NodeJS.ProcessEnv, port = 0): Promise<RunningServer> => {
    started++;
    if (started === 2) {
      secondStarted();
      await gate;
    }
    const url = `http://127.0.0.1:${port === 0 ? 4100 : port}`;
    return { url, stop: async () => void stops.push(url) };
  };
  const keeper = serverKeeper(files, {}, start);
  expect(await keeper.start()).toBe("http://127.0.0.1:4100");
  const restarting = keeper.restart();
  await second;
  const stopping = keeper.stop();
  release();
  await Promise.all([restarting, stopping]);
  expect(stops).toEqual(["http://127.0.0.1:4100", "http://127.0.0.1:4100"]);
});

test("the server starts on the PATH the shell said last time, and the shell's new answer is kept for the next start", async () => {
  const kept = join(mkdtempSync(join(tmpdir(), "vv-shell-path-")), "shell-path");
  // None kept: the first start waits for the shell.
  expect((await shellPath(kept, {}, async () => "/first/bin")).path).toBe("/first/bin");
  expect(readFileSync(kept, "utf8")).toBe("/first/bin");
  // Kept: it does not wait on a shell that is slow to answer, and what it answers is kept.
  let answer: (path: string) => void = () => undefined;
  const slow = new Promise<string>((resolve) => {
    answer = resolve;
  });
  const started = await shellPath(kept, {}, () => slow);
  expect(started.path).toBe("/first/bin");
  answer("/second/bin");
  await started.refreshed;
  expect(readFileSync(kept, "utf8")).toBe("/second/bin");
  // A shell that does not answer leaves what was kept.
  writeFileSync(kept, "/kept/bin");
  expect((await shellPath(kept, {}, async () => undefined)).path).toBe("/kept/bin");
  expect(readFileSync(kept, "utf8")).toBe("/kept/bin");
});
