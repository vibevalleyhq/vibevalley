import { mkdtempSync, rmSync } from "node:fs";
import { createServer, connect as dial, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";
import { afterEach, expect, test } from "vite-plus/test";

import { call, connect, push, serve } from "./index";
import { socketLink } from "./socket";

const contract = {
  open: call({ input: Schema.String, output: Schema.String }),
  opened: push(Schema.String),
};

let server: Server | undefined;
let dir = "";
afterEach(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a call and a push go over a socket, a line each, split across writes or not", async () => {
  dir = mkdtempSync(join(tmpdir(), "bridge-"));
  const path = join(dir, "control.sock");
  const pushed: string[] = [];
  server = createServer((socket) => {
    const served = serve(contract, socketLink(socket), {
      open: (where) => {
        served.push("opened", where);
        return `at ${where}`;
      },
    });
  });
  await new Promise<void>((resolve) => server?.listen(path, resolve));
  const socket = dial(path);
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  const asked = connect(contract, socketLink(socket));
  asked.on("opened", (where) => pushed.push(where));
  expect(await asked.call.open("/issues/12")).toBe("at /issues/12");
  expect(await asked.call.open("/chat")).toBe("at /chat");
  expect(pushed).toEqual(["/issues/12", "/chat"]);
  socket.destroy();
});
