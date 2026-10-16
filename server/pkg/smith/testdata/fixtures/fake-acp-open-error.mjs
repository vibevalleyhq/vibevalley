/* oxlint-disable import/no-nodejs-modules, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-call -- Standalone native wire fixture. */
import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) { return; }
  const reply = request.method === process.env.FAKE_ERROR_METHOD
    ? { error: JSON.parse(process.env.FAKE_ERROR) }
    : { result: request.method === "initialize"
        ? { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } }
        : { sessionId: "saved-session" } };
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply })}\n`);
});
