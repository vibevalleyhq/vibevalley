/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-argument -- Standalone untyped child-process fixture. */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// Imported by each fake runtime at startup. Record only these test variables,
// including the environment of a tool it spawns, never the host's other values.
const expression = 'JSON.stringify(Object.fromEntries(["OAR_ENV_REMOVE", "OAR_ENV_OVERRIDE", "OAR_ENV_KEEP", "OAR_ENV_EMPTY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"].filter(key => Object.hasOwn(process.env, key)).map(key => [key, process.env[key]])))';
const child = execFileSync(process.execPath, ["-p", expression], { encoding: "utf8" }).trim();
const snapshot = Object.fromEntries(["OAR_ENV_REMOVE", "OAR_ENV_OVERRIDE", "OAR_ENV_KEEP", "OAR_ENV_EMPTY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"].filter(key => Object.hasOwn(process.env, key)).map(key => [key, process.env[key]]));
writeFileSync(process.env.OAR_ENV_CAPTURE_PATH, JSON.stringify({ runtime: snapshot, tool: JSON.parse(child) }));
