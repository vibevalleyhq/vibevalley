import { spawn, type SpawnOptions } from "node:child_process";

/** The exit code of a program run to its end; rejects when it cannot be started. A program ended by a signal answers 128
 * plus the signal's number, as a shell reports it (1 when the number is not known). */
export const exitCodeOf = (command: string, args: readonly string[], options: SpawnOptions = {}): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], options);
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : signalCode(signal))));
  });

const signalCode = (signal: NodeJS.Signals) => {
  const n = signalNumbers[signal];
  return n === undefined ? 1 : 128 + n;
};

const signalNumbers: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
