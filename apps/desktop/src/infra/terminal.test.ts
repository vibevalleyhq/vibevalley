import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { startTerminals } from "./terminal";

function fakePtyHelper(dir: string): string {
  const script = join(dir, "fake-pty.mjs");
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";
let cwd = "";
createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (req.op === "spawn") {
    cwd = req.cwd;
    process.stdout.write(JSON.stringify({ event: "spawned", id: req.id, reqId: req.reqId, pid: 4242 }) + "\\n");
  } else if (req.op === "write") {
    process.stdout.write(JSON.stringify({ event: "data", id: req.id, data: req.data }) + "\\n");
  } else if (req.op === "inspect") {
    process.stdout.write(JSON.stringify({ event: "inspected", id: req.id, reqId: req.reqId, cwd, command: "claude" }) + "\\n");
  } else if (req.op === "kill") {
    process.stdout.write(JSON.stringify({ event: "exit", id: req.id, code: 0 }) + "\\n");
  }
});
`,
  );
  chmodSync(script, 0o755);
  return script;
}

test("spawns inside allowed roots, streams base64 bytes, inspects foreground command, and rejects outside roots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vv-pty-test-"));
  const binary = fakePtyHelper(dir);
  const chunks: string[] = [];
  let exited: { id: string; code: number } | undefined;
  let resolveExit: () => void = () => undefined;
  const sawExit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  let resolveData: () => void = () => undefined;
  const sawData = new Promise<void>((resolve) => {
    resolveData = resolve;
  });

  const terminals = startTerminals({
    binary,
    env: () => process.env,
    roots: () => [dir],
    onData: (ev) => {
      chunks.push(Buffer.from(ev.data, "base64").toString("utf8"));
      resolveData();
    },
    onExit: (ev) => {
      exited = ev;
      resolveExit();
    },
  });

  try {
    await expect(terminals.spawn({ id: "bad", cwd: "/etc", cols: 80, rows: 24 })).rejects.toThrow("outside allowed roots");

    const spawned = await terminals.spawn({ id: "t1", cwd: dir, cols: 100, rows: 30 });
    expect(spawned).toEqual({ pid: 4242 });

    terminals.write({ id: "t1", data: Buffer.from("echo 你好\n", "utf8").toString("base64") });
    await sawData;
    expect(chunks.join("")).toBe("echo 你好\n");

    expect(await terminals.inspect("t1")).toEqual({ cwd: dir, command: "claude" });

    terminals.kill("t1");
    await sawExit;
    expect(exited).toEqual({ id: "t1", code: 0 });
  } finally {
    terminals.stop();
  }
});
