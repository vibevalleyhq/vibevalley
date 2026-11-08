import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  buildEvidence,
  evidenceFailures,
  fileEvidence,
  graphPaths,
  inputFailures,
  list,
  playwrightFailures,
  readJson,
  record,
  type FileEvidence,
  type MigrationReceipt,
  type ScenarioReceipt,
} from "./style-migration-evidence";
import { migrationInputs, migrationOutput, migrationRoot, type MigrationInputs } from "./style-migration-inputs";
import { hostScenarios } from "./style-migration-scenes";

const root = migrationRoot;
const executable = join(root, "node_modules/.bin/vpx");
const output = join(migrationOutput, "host");
const androidPackage = "dev.vibevalley.mobile";
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|CERTIFICATE|PASSWORD|^AGORA_|^VIBEVALLEY_|^GIT_CONFIG_/u.test(key)),
);

interface OwnedProcess {
  child: ChildProcess;
  exited: Promise<number>;
  directory: string;
  error?: string;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const requireFile = (path: string, instruction: string) => {
  if (!existsSync(path)) throw new Error(`Missing ${path}. ${instruction}`);
};
const files = (directory: string): string[] =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted((a, b) => a.localeCompare(b));

function alive(process: OwnedProcess): boolean {
  if (process.child.pid === undefined) return false;
  try {
    globalThis.process.kill(-process.child.pid, 0);
    return true;
  } catch (error) {
    if (record(error).code === "ESRCH") return false;
    throw error;
  }
}

function signal(process: OwnedProcess, name: NodeJS.Signals): void {
  if (process.child.pid === undefined) return;
  try {
    globalThis.process.kill(-process.child.pid, name);
  } catch (error) {
    if (record(error).code !== "ESRCH") throw error;
  }
}

async function settled(process: OwnedProcess, milliseconds: number): Promise<boolean> {
  const end = Date.now() + milliseconds;
  while (alive(process) && Date.now() < end) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- process-group termination is polled within a deadline
    await sleep(100);
  }
  return !alive(process);
}

async function stop(process: OwnedProcess): Promise<void> {
  if (!alive(process)) return;
  signal(process, "SIGTERM");
  if (!(await settled(process, 35_000))) {
    signal(process, "SIGKILL");
    if (!(await settled(process, 5_000))) throw new Error(`Owned process group ${process.child.pid} survived SIGKILL`);
  }
}

const owned = new Set<OwnedProcess>();
function launch(name: string, command: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string): OwnedProcess {
  const directory = join(output, name);
  mkdirSync(directory, { recursive: true });
  const stdout = openSync(join(directory, "stdout.log"), "w");
  const stderr = openSync(join(directory, "stderr.log"), "w");
  let child: ChildProcess;
  try {
    child = spawn(command[0]!, command.slice(1), { cwd, env, detached: true, stdio: [input === undefined ? "ignore" : "pipe", stdout, stderr] });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  const exited = new Promise<number>((resolve) => {
    child.once("error", (error) => {
      process.error = errorText(error);
      resolve(1);
    });
    child.once("close", (code) => resolve(code ?? 1));
  });
  const process: OwnedProcess = { child, directory, exited };
  child.stdin?.on("error", (error) => {
    process.error = errorText(error);
  });
  child.stdin?.end(input);
  owned.add(process);
  return process;
}

async function run(name: string, command: string[], cwd = root, env: NodeJS.ProcessEnv = environment, timeout = 360_000, input?: string): Promise<string> {
  const process = launch(name, command, cwd, env, input);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    signal(process, "SIGTERM");
  }, timeout);
  const hardTimer = setTimeout(() => signal(process, "SIGKILL"), timeout + 40_000);
  let code = 1;
  let clean = false;
  const errors: unknown[] = [];
  let stopped = false;
  try {
    code = await process.exited;
    clean = await settled(process, 2_000);
  } catch (error) {
    errors.push(error);
  } finally {
    clearTimeout(timer);
    clearTimeout(hardTimer);
    try {
      await stop(process);
      stopped = !alive(process);
      if (stopped) owned.delete(process);
    } catch (error) {
      errors.push(error);
    }
  }
  if (code !== 0 || timedOut || !clean || process.error)
    errors.unshift(new Error(`${name} failed (code ${code}, timeout ${timedOut}, clean ${clean}): ${process.error ?? process.directory}`));
  try {
    json(join(process.directory, "result.json"), {
      command,
      cwd,
      pid: process.child.pid,
      code,
      timedOut,
      stopped,
      unexpectedDescendants: !clean,
      error: errors.length > 0 ? errors.map(errorText).join("; ") : process.error,
    });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, errors.map(errorText).join("; "));
  return readFileSync(join(process.directory, "stdout.log"), "utf8");
}

function assertCurrentBuilds(inputs: MigrationInputs): void {
  for (const path of graphPaths) {
    const graph = record(readJson(path));
    const failures = inputFailures(graph.inputs, inputs);
    if (graph.complete !== true) failures.push("incomplete build");
    const artifacts = list(graph.artifacts);
    if (artifacts.length === 0) failures.push("missing built artifacts");
    for (const artifact of artifacts) failures.push(...evidenceFailures(artifact));
    if (failures.length > 0) throw new Error(`${path}: ${failures.join("; ")}. Rebuild all canonical production graphs first.`);
  }
}

async function desktop(temp: string, inputs: MigrationInputs): Promise<FileEvidence[]> {
  const cwd = join(root, "apps/desktop");
  const env = { ...environment, TMPDIR: temp };
  await run("desktop/build", [executable, "scripts/build.ts"], cwd, env);
  const artifacts = [
    "apps/desktop/build/main.cjs",
    "apps/desktop/build/preload.cjs",
    ...(process.platform === "darwin" ? ["apps/island/.build/release/VibeValleyIsland"] : []),
  ].map(fileEvidence);
  json(join(output, "desktop/native-build.json"), { inputs, artifacts, command: [executable, "scripts/build.ts"] });
  const discovery = join(output, "desktop/discovery.json");
  const results = join(output, "desktop/playwright.json");
  const args = [
    executable,
    "playwright",
    "test",
    "test/app.spec.ts",
    "--config=playwright.config.ts",
    "--reporter=json",
    "--workers=1",
    "--retries=0",
    "--forbid-only",
  ];
  await run("desktop/discover", [...args, "--list"], cwd, { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: discovery });
  await run("desktop/exercise", [...args, `--output=${join(output, "desktop/screens")}`], cwd, { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: results });
  const failures = playwrightFailures(readJson(discovery), readJson(results));
  const screenshots = files(join(output, "desktop/screens"));
  for (const name of ["desktop.png", "desktop-farm.png", "opening-failure.png"])
    if (!screenshots.some((file) => file.endsWith("/" + name))) failures.push(`Missing Electron screenshot ${name}`);
  if (failures.length > 0) throw new Error(failures.join("; "));
  return artifacts;
}

async function mobile(temp: string, inputs: MigrationInputs): Promise<FileEvidence[]> {
  const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Library/Android/sdk");
  const adb = join(sdk, "platform-tools/adb");
  const emulator = join(sdk, "emulator/emulator");
  const manager = join(sdk, "cmdline-tools/latest/bin/avdmanager");
  const architecture = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
  const image = process.env.STYLE_MIGRATION_ANDROID_IMAGE ?? `system-images;android-35;google_apis;${architecture}`;
  const port = Number(process.env.STYLE_MIGRATION_EMULATOR_PORT ?? "5580");
  if (!Number.isInteger(port) || port < 5554 || port > 5682 || port % 2 !== 0)
    throw new Error("STYLE_MIGRATION_EMULATOR_PORT must be an even emulator console port between 5554 and 5682");
  const serial = `emulator-${port}`;
  const android = join(root, "apps/mobile/android");
  for (const binary of [adb, emulator, manager]) requireFile(binary, "Install Android SDK platform-tools, emulator and cmdline-tools/latest.");
  requireFile(join(sdk, ...image.split(";"), "package.xml"), `Install SDK package ${image}.`);
  requireFile(join(android, "gradlew"), "From apps/mobile run CI=1 vp exec expo prebuild -p android --no-install before the canonical graph builds.");
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin/java") : "java";
  await run("mobile/java", [java, "-version"]);
  const version = readFileSync(join(output, "mobile/java/stderr.log"), "utf8") + readFileSync(join(output, "mobile/java/stdout.log"), "utf8");
  if (!/version "17[."]/u.test(version)) throw new Error("Android acceptance requires JDK 17. Set JAVA_HOME to the installed JDK 17.");
  const env = { ...environment, ANDROID_HOME: sdk, ANDROID_SERIAL: serial, EXPO_PUBLIC_VIBEVALLEY_E2E: "1" };
  await run(
    "mobile/build",
    [join(android, "gradlew"), "--no-daemon", "assembleRelease", "--rerun-tasks", `-PreactNativeArchitectures=${architecture}`],
    android,
    env,
    1_800_000,
  );
  const apk = join(android, "app/build/outputs/apk/release/app-release.apk");
  json(join(output, "mobile/native-build.json"), { inputs, artifacts: [fileEvidence(apk)], image, architecture, e2e: env.EXPO_PUBLIC_VIBEVALLEY_E2E });
  const devices = await run("mobile/devices-before", [adb, "devices", "-l"]);
  if (devices.split("\n").some((line) => line.startsWith(serial + " ") || line.startsWith(serial + "\t")))
    throw new Error(`${serial} is already in use; choose an unused STYLE_MIGRATION_EMULATOR_PORT. Existing devices will not be touched.`);
  const existingForwards = await run("mobile/forwards-before", [adb, "forward", "--list"], root, env);
  if (existingForwards.split("\n").some((line) => Number(/^\S+\s+tcp:(\d+)/u.exec(line)?.[1]) >= 9334))
    throw new Error("Existing ADB forwards occupy the mobile suite's DevTools port range (9334+); refusing to replace another device's forwarding.");
  const avds = join(temp, "avds");
  mkdirSync(avds, { recursive: true });
  const emulatorEnv = { ...env, ANDROID_AVD_HOME: avds, ANDROID_USER_HOME: join(temp, "android-user") };
  const avd = `style-migration-${process.pid}`;
  await run(
    "mobile/create-avd",
    [manager, "create", "avd", "--name", avd, "--package", image, "--path", join(avds, avd + ".avd")],
    root,
    emulatorEnv,
    120_000,
    "no\n",
  );
  const device = launch(
    "mobile/emulator",
    [emulator, "-avd", avd, "-port", String(port), "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot", "-wipe-data"],
    root,
    emulatorEnv,
  );
  let stopped = false;
  let identified = false;
  let sandbox: string | undefined;
  const errors: unknown[] = [];
  try {
    const deadline = Date.now() + 180_000;
    let booted = false;
    while (Date.now() < deadline && alive(device)) {
      const boot = spawnSync(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], { env, encoding: "utf8", timeout: 5_000 });
      if (boot.status === 0 && boot.stdout.trim() === "1") {
        booted = true;
        break;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- the isolated emulator must finish booting before install
      await sleep(1_000);
    }
    if (!booted) throw new Error(`Android emulator did not boot: ${device.directory}`);
    const deviceName = await run("mobile/avd-identity", [adb, "-s", serial, "emu", "avd", "name"], root, env, 15_000);
    if (deviceName.split(/\r?\n/u)[0] !== avd) throw new Error(`Refusing to exercise ${serial}: it is not the owned temporary AVD ${avd}`);
    identified = true;
    await run("mobile/device", [adb, "-s", serial, "shell", "getprop"], root, env);
    const screenshot = join(root, "apps/mobile/.screens/android-farm.png");
    const started = Date.now();
    try {
      await run("mobile/exercise", [executable, "scripts/verify-server.ts", "--", executable, "apps/mobile/scripts/e2e.ts", "android"], root, env);
    } finally {
      const log = readFileSync(join(output, "mobile/exercise/stdout.log"), "utf8") + readFileSync(join(output, "mobile/exercise/stderr.log"), "utf8");
      sandbox = /(?:verification evidence|evidence): ([^\r\n]+)/u.exec(log)?.[1];
      if (sandbox && existsSync(sandbox)) {
        const logs = join(output, "mobile/sandbox");
        mkdirSync(logs, { recursive: true });
        for (const name of [
          "result.json",
          "ready.json",
          "health.json",
          "failure.txt",
          "command.stdout.log",
          "command.stderr.log",
          "server.stdout.log",
          "server.stderr.log",
        ]) {
          if (existsSync(join(sandbox, name))) copyFileSync(join(sandbox, name), join(logs, name));
        }
      }
    }
    if (!sandbox) throw new Error("Mobile sandbox did not publish an evidence directory");
    const result = record(readJson(join(output, "mobile/sandbox/result.json")));
    if (result.code !== 0 || result.stopped !== true || !Array.isArray(result.cleanupErrors) || result.cleanupErrors.length !== 0)
      throw new Error("Mobile sandbox failed or left owned processes running");
    const ready = record(readJson(join(output, "mobile/sandbox/ready.json")));
    if (typeof ready.pid !== "number" || !Number.isInteger(ready.pid) || ready.pid <= 0) throw new Error("Sandbox did not publish its owned server PID");
    try {
      process.kill(-ready.pid, 0);
      throw new Error(`Sandbox server process group ${ready.pid} survived cleanup`);
    } catch (error) {
      if (record(error).code !== "ESRCH") throw error;
    }
    json(join(output, "mobile/server-cleanup.json"), { pid: ready.pid, stopped: true });
    const log = readFileSync(join(output, "mobile/sandbox/command.stdout.log"), "utf8");
    for (const message of [
      "paired and seen",
      "bridge: the page's notice shown by the phone",
      "bridge: the reloaded page owns a fresh host",
      "back after a restart",
    ])
      if (!log.includes(message)) throw new Error(`Missing real Android assertion: ${message}`);
    if (log.includes("bridge: not checked")) throw new Error("Android bridge was not exercised; rebuild with EXPO_PUBLIC_VIBEVALLEY_E2E=1");
    if (!log.includes(screenshot)) throw new Error(`Mobile exercise did not publish ${screenshot}`);
    requireFile(screenshot, "The real mobile suite must capture its WebView.");
    copyFileSync(screenshot, join(output, "mobile/android-farm.png"));
    json(join(output, "mobile/exercise-provenance.json"), {
      startedAt: new Date(started).toISOString(),
      serial,
      sandbox,
      screenshot: fileEvidence(join(output, "mobile/android-farm.png")),
    });
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      if (alive(device) && identified) {
        await run("mobile/force-stop", [adb, "-s", serial, "shell", "am", "force-stop", androidPackage], root, env, 15_000);
        const application = spawnSync(adb, ["-s", serial, "shell", "pidof", androidPackage], { env, encoding: "utf8", timeout: 5_000 });
        json(join(output, "mobile/application-process.json"), {
          serial,
          code: application.status,
          stdout: application.stdout,
          stderr: application.stderr,
          error: application.error?.message,
        });
        if (application.error || application.stdout.trim() !== "" || application.status !== 1)
          errors.push(new Error("Mobile application process remained after force-stop or could not be checked"));
        const forwards = await run("mobile/forwards-after", [adb, "forward", "--list"], root, env, 15_000);
        for (const line of forwards.split("\n")) {
          const [deviceSerial, local] = line.trim().split(/\s+/u);
          if (deviceSerial === serial && local) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- remove only this emulator's forwarding, never the shared ADB server's other devices
            await run(`mobile/remove-forward-${local.replaceAll(":", "-")}`, [adb, "-s", serial, "forward", "--remove", local], root, env, 15_000);
          }
        }
        await run("mobile/shutdown", [adb, "-s", serial, "emu", "kill"], root, env, 15_000);
        stopped = await settled(device, 20_000);
      }
    } catch (error) {
      errors.push(error);
    } finally {
      let terminated = false;
      try {
        await stop(device);
        terminated = !alive(device);
        if (terminated) owned.delete(device);
      } catch (error) {
        errors.push(error);
      }
      try {
        json(join(output, "mobile/cleanup.json"), { serial, sandbox, gracefulShutdown: stopped, stopped: terminated });
      } catch (error) {
        errors.push(error);
      }
    }
    if (!stopped) errors.push(new Error("Android emulator did not shut down cleanly; forced cleanup recorded"));
  }
  if (errors.length > 0) throw new AggregateError(errors, errors.map(errorText).join("; "));
  return [fileEvidence(apk)];
}

async function main(): Promise<void> {
  mkdirSync(output, { recursive: true });
  const receiptPath = join(migrationOutput, "host.json");
  const errors: string[] = [];
  const executed: ScenarioReceipt[] = [];
  let inputs: MigrationInputs | undefined;
  let builds: MigrationReceipt["builds"] = [];
  let temp: string | undefined;
  const interrupted = () => {
    errors.push("Host acceptance interrupted");
    for (const process of owned) signal(process, "SIGTERM");
  };
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  try {
    if (process.platform === "win32") throw new Error("Host acceptance requires Unix process groups");
    inputs = migrationInputs();
    builds = buildEvidence();
    assertCurrentBuilds(inputs);
    for (const name of ["desktop", "mobile"]) rmSync(join(output, name), { recursive: true, force: true });
    // Keep nested desktop socket paths below macOS's 104-byte limit.
    temp = mkdtempSync("/tmp/vv-style-host-");
    for (const [id, exercise] of [
      ["desktop-host", desktop],
      ["mobile-host", mobile],
    ] as const) {
      const scenario: ScenarioReceipt = { id, status: "failed", evidence: [] };
      executed.push(scenario);
      try {
        if (errors.includes("Host acceptance interrupted")) throw new Error("Host acceptance interrupted");
        // oxlint-disable-next-line eslint/no-await-in-loop -- native suites share build outputs and must not overlap
        scenario.evidence = await exercise(temp, inputs);
        if (migrationInputs().digest !== inputs.digest) throw new Error("Source changed during host acceptance; rebuild and rerun from stable inputs");
        scenario.status = "passed";
      } catch (error) {
        scenario.error = errorText(error);
        errors.push(`${id}: ${scenario.error}`);
      }
      const directory = join(output, id === "desktop-host" ? "desktop" : "mobile");
      mkdirSync(directory, { recursive: true });
      json(join(directory, "scenario.json"), { id, status: scenario.status, error: scenario.error });
      scenario.evidence.push(...files(directory).map(fileEvidence));
    }
  } catch (error) {
    errors.push(errorText(error));
  } finally {
    for (const process of owned) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each owned group must stop before temporary data can be deleted
        await stop(process);
      } catch (error) {
        errors.push(errorText(error));
      }
    }
    const stopped = [...owned].every((process) => !alive(process));
    if (temp && stopped) {
      try {
        rmSync(temp, { recursive: true, force: true });
      } catch (error) {
        errors.push(errorText(error));
      }
    }
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    const cleanup = join(output, "cleanup.json");
    json(cleanup, { stopped, temporaryDirectory: temp, removed: temp === undefined || !existsSync(temp), errors });
    for (const id of hostScenarios) {
      let scenario = executed.find((scenario) => scenario.id === id);
      if (!scenario) {
        scenario = { id, status: "failed", error: errors.join("; "), evidence: [] };
        executed.push(scenario);
      }
      scenario.evidence.push(fileEvidence(cleanup));
      if (!stopped) scenario.status = "failed";
    }
    const receipt = {
      schemaVersion: 1,
      kind: "host",
      createdAt: new Date().toISOString(),
      status: errors.length === 0 && executed.every((scenario) => scenario.status === "passed") ? "passed" : "failed",
      inputs: inputs ?? null,
      builds,
      expected: hostScenarios,
      executed,
      skipped: [],
      errors,
    } satisfies Omit<MigrationReceipt, "inputs"> & { inputs: MigrationInputs | null };
    json(receiptPath, receipt);
    console.log(`host evidence: ${receiptPath}`);
    if (receipt.status !== "passed") {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    }
  }
}

if (import.meta.main) await main();
