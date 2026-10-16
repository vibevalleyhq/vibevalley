// A scripted ACP agent for the runtimes' one-shot readers (model listing,
// account usage): the Go port's stand-in for the TS tests' vi.mock of
// startAcpProcess. SCRIPTED_ACP holds JSON:
//   { "log": "<file>", "methods": { "<method>": <step> | [<step>, ...] } }
// A step is { "result": any } | { "error": { code, message, data? } }, with
// an optional "delayMs" before the answer. A list answers its calls in
// order, repeating the last. A method the script does not name is
// -32601 "Method not found". Every start ({start, cwd, pid}) and request
// ({method, params}) is appended to the log as one JSON line.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const script = JSON.parse(process.env.SCRIPTED_ACP ?? "{}");
const methods = script.methods ?? {};
const calls = new Map();

function log(entry) {
  if (typeof script.log === "string") {
    appendFileSync(script.log, `${JSON.stringify(entry)}\n`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

log({ start: process.argv.slice(2), cwd: process.cwd(), pid: process.pid });

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message.method !== "string" || message.id === undefined) {
    return;
  }
  log({ method: message.method, params: message.params });
  const steps = methods[message.method];
  const count = calls.get(message.method) ?? 0;
  calls.set(message.method, count + 1);
  const step = Array.isArray(steps) ? steps[Math.min(count, steps.length - 1)] : steps;
  const answer = () => {
    if (step === undefined || step === null) {
      send({ id: message.id, error: { code: -32601, message: "Method not found" } });
    } else if (step.error !== undefined) {
      send({ id: message.id, error: step.error });
    } else {
      send({ id: message.id, result: step.result ?? null });
    }
  };
  const delay = step?.delayMs ?? 0;
  if (delay > 0) {
    setTimeout(answer, delay);
  } else {
    answer();
  }
});
