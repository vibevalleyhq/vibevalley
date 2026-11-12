import { systemClock } from "@vibevalley/async";

import type { Io } from "#/base/output.ts";

const stdinText = async (): Promise<string> => {
  const parts: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const got: unknown = chunk;
    parts.push(typeof got === "string" ? Buffer.from(got) : got instanceof Uint8Array ? Buffer.from(got) : Buffer.alloc(0));
  }
  return Buffer.concat(parts).toString("utf8");
};

/** This process's io; Ctrl+C aborts the signal, once. */
export const processIo = (): Io => {
  const stopped = new AbortController();
  process.once("SIGINT", () => stopped.abort());
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    stdin: stdinText,
    stdoutIsTerminal: process.stdout.isTTY === true,
    env: process.env,
    fetch: (input, init) => fetch(input, init),
    clock: systemClock,
    signal: stopped.signal,
  };
};
