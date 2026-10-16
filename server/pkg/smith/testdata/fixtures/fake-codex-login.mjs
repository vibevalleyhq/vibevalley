/* oxlint-disable eslint/max-statements, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone untyped fixture executable. */
// `codex login status` and the app-server's device code login as codex
// 0.160.0 answers them, for the login driver, and `codex logout` as 0.160.1
// does, for the logout driver. The first argument is a JSON state file:
// { version, email, loggedIn, status, mode, logoutMode }. Every invocation is
// appended to `invocations`, so a test can tell `codex login` never ran.
// Modes for account/login/start: "success", "failure" (codex reports the
// code expired), "start_error" (the start request is refused), "crash" (the
// app-server exits mid-login, with a stderr tail), "unverified" (success,
// then no account), "read_error" (success, then account/read fails), "early"
// (the completion arrives before the start reply), "hang" (starts a worker in
// its process group and never completes). `readDelayMs` delays account/read.
// Modes for `codex logout`: "ok" (the default: `Successfully logged out`, or
// `Not logged in` when signed out already), "error" (`Error logging out:`,
// still signed in), "keeps" (succeeds, yet the status still reads logged in,
// as from a source it does not remove), "hang" (starts a worker in its
// process group and never finishes).
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [stateFile, ...args] = process.argv.slice(2);
const state = JSON.parse(readFileSync(stateFile, "utf8"));

function save(changes) {
  Object.assign(state, changes);
  writeFileSync(stateFile, JSON.stringify(state));
}

save({ invocations: [...(state.invocations ?? []), args.join(" ")] });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function loginStart(id, params) {
  save({ startParams: params, pid: process.pid });
  if (state.mode === "start_error") {
    send({ id, error: { code: -32_600, message: "device code login is not enabled for this workspace" } });
    return;
  }
  if (state.mode === "hang") {
    // Reported before the reply, so a test that stops the login on the device code finds the worker.
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    save({ workerPid: worker.pid });
  }
  const reply = { id, result: { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" } };
  if (state.mode === "early") {
    save({ loggedIn: true });
    send({ method: "account/login/completed", params: { loginId: "login-1", success: true, error: null } });
    send(reply);
    return;
  }
  send(reply);
  if (state.mode === "hang") {
    return;
  }
  setTimeout(() => {
    if (state.mode === "crash") {
      process.stderr.write("fatal: device auth poller panicked\n");
      process.exit(3);
    }
    const success = state.mode !== "failure";
    if (state.mode === "success" || state.mode === "read_error") {
      save({ loggedIn: true });
    }
    send({ method: "account/login/completed", params: { loginId: "login-1", success, error: success ? null : "device code expired" } });
  }, 100);
}

const command = args.join(" ");
if (command === "--version") {
  process.stdout.write(`codex-cli ${state.version}\n`);
} else if (command === "app-server --help") {
  // oar's installation probe, so `OAR_CODEX_BIN=<this> oar login codex` drives the fake end to end.
  process.stdout.write("Usage: codex app-server [OPTIONS]\n");
} else if (command === "login status") {
  if (state.status === "broken") {
    process.stderr.write("Error loading configuration: invalid TOML\n");
    process.exitCode = 1;
  } else if (state.loggedIn === true) {
    process.stderr.write("Logged in using ChatGPT\n");
  } else {
    process.stderr.write("Not logged in\n");
    process.exitCode = 1;
  }
} else if (command === "app-server --listen stdio://") {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) {
      return;
    }
    if (message.method === "initialize") {
      send({ id: message.id, result: { userAgent: "fake-codex" } });
    } else if (message.method === "account/login/start") {
      loginStart(message.id, message.params);
    } else if (message.method === "account/read" && state.mode === "read_error") {
      send({ id: message.id, error: { code: -32_603, message: "failed to read the credential store" } });
    } else if (message.method === "account/read") {
      const account = state.loggedIn === true ? { type: "chatgpt", email: state.email, planType: "plus" } : null;
      setTimeout(() => {
        send({ id: message.id, result: { account, requiresOpenaiAuth: true } });
      }, state.readDelayMs ?? 0);
    } else {
      send({ id: message.id, error: { code: -32_601, message: `method not found: ${message.method}` } });
    }
  });
} else if (command === "logout") {
  if (state.logoutMode === "hang") {
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    save({ workerPid: worker.pid, pid: process.pid });
    setInterval(() => {}, 1000);
  } else if (state.logoutMode === "error") {
    process.stderr.write("Error logging out: failed to delete /home/user/.codex/auth.json: Permission denied (os error 13)\n");
    process.exitCode = 1;
  } else if (state.logoutMode === "keeps") {
    process.stderr.write("Successfully logged out\n");
  } else {
    process.stderr.write(state.loggedIn === true ? "Successfully logged out\n" : "Not logged in\n");
    save({ loggedIn: false });
  }
} else {
  process.stderr.write(`unexpected arguments: ${command}\n`);
  process.exitCode = 64;
}
