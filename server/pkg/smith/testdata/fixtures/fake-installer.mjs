/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone untyped fixture executable. */
// A vendor installer, for planInstaller. The only argument is a JSON state
// file the test writes: { target, mode }. It records that it ran and whether
// it saw a package script marker, then behaves as `mode` says, the ways real
// installers do: "install" puts a runtime executable at target (which
// prints "fake 1.0.0" for --version), "elsewhere" claims success and puts
// nothing where the probe looks, "fail" exits non-zero having installed
// nothing, "fail-after" installs and then exits non-zero (a later step
// failed), "prompt" asks on stdin and installs nothing without an answer,
// "hang" starts a worker that holds the output pipes and never finishes.
import { spawn } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const [stateFile] = process.argv.slice(2);
const state = JSON.parse(readFileSync(stateFile, "utf8"));

function save(changes) {
  writeFileSync(stateFile, JSON.stringify({ ...state, ...changes }));
}

function installRuntime() {
  writeFileSync(state.target, process.platform === "win32" ? "@echo fake 1.0.0\r\n" : "#!/bin/sh\necho 'fake 1.0.0'\n");
  chmodSync(state.target, 0o755);
}

const seen = { ran: true, sawUserAgent: process.env.npm_config_user_agent !== undefined };
save(seen);
if (state.mode === "install") {
  installRuntime();
  process.stdout.write("Installed fake 1.0.0\n");
} else if (state.mode === "elsewhere") {
  process.stdout.write("fake installed successfully!\n");
} else if (state.mode === "fail") {
  process.stderr.write("error: failed to download fake\n");
  process.exitCode = 3;
} else if (state.mode === "fail-after") {
  installRuntime();
  process.stdout.write("Installed fake 1.0.0\n");
  process.stderr.write("error: could not write shell completions\n");
  process.exitCode = 1;
} else if (state.mode === "hang") {
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
  save({ ...seen, workerPid: worker.pid });
  setInterval(() => {}, 1000);
} else {
  process.stdout.write("Install fake now? [y/N] ");
  process.stdin.resume();
  process.stdin.on("end", () => {
    process.stdout.write("\nskipped\n");
  });
}
