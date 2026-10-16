/* oxlint-disable import/no-nodejs-modules, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-call -- Standalone native wire fixture. */
import { createInterface } from "node:readline";

const scenario = JSON.parse(process.env.FAKE_RESUME_CASE);
let page = 0;
function reply(request) {
  if (request.method === (scenario.errorMethod ?? "session/resume") && scenario.succeed !== true) {
    return { error: scenario.error };
  }
  if (request.method === "initialize") {
    return { result: { protocolVersion: 1, agentCapabilities: {
      loadSession: scenario.capability === "load",
      sessionCapabilities: { ...(scenario.list === false ? {} : { list: {} }), ...(scenario.capability === "load" ? {} : { resume: {} }) },
    } } };
  }
  if (request.method === "session/list") {
    const response = scenario.pages?.[page] ?? { result: { sessions: [], nextCursor: "repeated" } };
    page += 1;
    // oxlint-disable-next-line typescript/no-unsafe-return -- Replay the decoded wire fixture without schema coercion.
    return response;
  }
  return { result: { sessionId: "missing-session" } };
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) { return; }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply(request) })}\n`);
});
