import { z } from "zod";

import { systemClock } from "@vibevalley/async";

import type { Io } from "#/base/output.ts";
import { run } from "#/main.ts";

/** The failure stderr ends with (output.ts's printFailure). */
const FailureLine = z.object({
  error: z.object({
    bizCode: z.exactOptional(z.number().int()),
    tag: z.string(),
    message: z.string(),
    status: z.exactOptional(z.number().int()),
    next: z.exactOptional(z.array(z.object({ say: z.string(), run: z.exactOptional(z.array(z.string())) }))),
  }),
});

const failureOf = (line: string) => {
  try {
    const got = FailureLine.safeParse(JSON.parse(line));
    return got.success ? got.data.error : undefined;
  } catch {
    // Not a failure line: the run did not fail, or said something else last.
    return undefined;
  }
};

/** One run, with io of its own and no environment: its exit code, what it put on stdout and on stderr, and the failure
 * stderr ends with. signal stands for Ctrl+C. */
export const cli = async (args: string[], stdin = "", env: Record<string, string> = {}, signal: AbortSignal = new AbortController().signal) => {
  let out = "";
  let err = "";
  const io: Io = {
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
    stdin: () => Promise.resolve(stdin),
    stdoutIsTerminal: false,
    env,
    fetch: (input, init) => fetch(input, init),
    clock: systemClock,
    signal,
  };
  const code = await run(args, io);
  [out, err] = [out.replace(/\n$/u, ""), err.replace(/\n$/u, "")];
  const failure = failureOf(err.split("\n").at(-1) ?? "");
  return { code, out, err, failure };
};
