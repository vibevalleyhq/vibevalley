/* oxlint-disable eslint/max-statements, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone untyped fixture executable. */
// `claude auth login` and `claude auth status --json` as claude 2.1.288
// prints them, for the login driver, and `claude auth logout` as 2.1.292
// does, for the logout driver. The first argument is a JSON state file:
// { version, code, email, loggedIn, envKey, mode, logoutMode }. `auth login` prints the URL as an
// OSC 8 hyperlink and the paste prompt with no newline, then reads stdin
// lines: a line without `#` is an invalid code (retryable), `code` signs in.
// Modes for a pasted line: "paste" (the default), "reject" (fails, echoing the
// pasted line, as a careless error message could), "verifier" (fails with
// `Login failed: Invalid code verifier`), "own_words" (fails with a message
// of its own, then a blank line), "unverified" (reports success without
// signing in), "linger" (signs in, then keeps running, as claude does while
// it flushes telemetry). Without a pasted line: "browser" (the localhost
// callback signs in by itself), "hang" (starts a worker in its process group
// and never finishes).
// `envKey` is `ANTHROPIC_API_KEY` in claude's environment: the status reads
// logged in through it, and a logout leaves it. Modes for `auth logout`: "ok"
// (the default: signs out, also when signed out already), "stdin" (the same,
// once its stdin has ended), "fail" (`Logout failed:`, still signed in),
// "fail_after_clear" (signs out, then fails writing its config), "crash"
// (exit 3 with a token in its last words), "hang" (starts a worker in its
// process group and never finishes).
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [stateFile, ...args] = process.argv.slice(2);
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const ESC = "\u001B";
const BEL = "\u0007";
const URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=fixture&state=fixture-state";

function save(changes) {
  Object.assign(state, changes);
  writeFileSync(stateFile, JSON.stringify(state));
}

const command = args.join(" ");
if (command === "--version") {
  process.stdout.write(`${state.version} (Claude Code)\n`);
} else if (command === "auth status --json") {
  if (state.statusBroken === true) {
    process.stdout.write("not json\n");
    process.exitCode = 2;
  } else if (state.loggedIn === true) {
    process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: state.email, subscriptionType: "pro" }, null, 2)}\n`);
  } else if (state.envKey === true) {
    process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" }, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }, null, 2)}\n`);
    process.exitCode = 1;
  }
} else if (command === "auth login") {
  save({ loginStarted: true, sawClaudeCode: process.env.CLAUDECODE !== undefined, received: [] });
  if (state.mode === "hang") {
    // Reported before any output, so a test that stops the login on its first prompt finds the worker.
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    save({ workerPid: worker.pid, pid: process.pid });
    setInterval(() => {}, 1000);
  }
  process.stdout.write(`${ESC}[2mOpening browser to sign in…${ESC}[22m\n`);
  process.stdout.write(`If the browser didn't open, visit: ${ESC}]8;;${URL}${BEL}${ESC}[4m${URL}${ESC}[24m${ESC}]8;;${BEL}\n`);
  process.stdout.write("Paste code here if prompted > ");
  if (state.mode === "browser") {
    setTimeout(() => {
      save({ loggedIn: true });
      process.stdout.write("Login successful.\n");
      process.exit(0);
    }, 200);
  }
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (input) => {
    const line = String(input);
    save({ received: [...state.received, line] });
    if (state.mode === "reject") {
      process.stderr.write(`Login failed: invalid_grant for code ${line}\n`);
      process.exit(1);
    }
    if (state.mode === "verifier") {
      process.stderr.write("Login failed: Invalid code verifier\n");
      process.exit(1);
    }
    if (state.mode === "own_words") {
      process.stderr.write("This organization does not allow logging in to Claude Code.\n\n");
      process.exit(1);
    }
    if (!line.includes("#")) {
      process.stderr.write("Invalid code. Please make sure the full code was copied.\n");
      return;
    }
    if (line !== state.code) {
      process.stderr.write("Login failed: Request failed with status code 400\n");
      process.exit(1);
    }
    if (state.mode !== "unverified") {
      save({ loggedIn: true });
    }
    // No newline came before: claude's output continues the prompt's line.
    process.stdout.write("Login successful.\n");
    if (state.mode === "linger") {
      save({ pid: process.pid });
      setInterval(() => {}, 1000);
      return;
    }
    process.exit(0);
  });
} else if (command === "auth logout") {
  save({ logoutStarted: true, sawClaudeCode: process.env.CLAUDECODE !== undefined });
  const signedOut = () => {
    save({ loggedIn: false });
    process.stdout.write("Successfully logged out from your Anthropic account.\n");
  };
  if (state.logoutMode === "hang") {
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    save({ workerPid: worker.pid, pid: process.pid });
    setInterval(() => {}, 1000);
  } else if (state.logoutMode === "stdin") {
    process.stdin.resume();
    process.stdin.on("end", signedOut);
  } else if (state.logoutMode === "fail") {
    process.stderr.write("Logout failed: EACCES: permission denied, unlink '/home/user/.claude/.credentials.json'\n");
    process.exitCode = 1;
  } else if (state.logoutMode === "fail_after_clear") {
    save({ loggedIn: false });
    process.stderr.write("Logout failed: EPERM: operation not permitted, open '/home/user/.claude.json'\n");
    process.exitCode = 1;
  } else if (state.logoutMode === "crash") {
    process.stderr.write("Unexpected error\n");
    process.stderr.write("TypeError: cannot read token sk-ant-oat01-abcdefghijklmnopqrstuvwxyz\n");
    process.exitCode = 3;
  } else {
    signedOut();
  }
} else {
  process.stderr.write(`unexpected arguments: ${command}\n`);
  process.exitCode = 64;
}
