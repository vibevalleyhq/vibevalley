import { expect, test } from "vite-plus/test";

import { type RunningServer, type ServerFiles, serverKeeper } from "./server";

const files: ServerFiles = { server: "/server", web: "/web", log: "/tmp/vibevalley-server-test.log" };

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
