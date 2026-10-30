// The phone shell end to end on an Android emulator or an iOS simulator, against a sandboxed farm (run under
// scripts/verify-server.ts, which sets VIBEVALLEY_SERVER): the farm opens 连接到本机 and starts a pairing, the app is
// opened with its vibevalley://pair link, the owner lets it in, and the farm then hears from the phone with its key (its
// page loaded through the lan listener). Leaves a screenshot in apps/mobile/.screens/. Build the app first (README.md).
//
//	vpx scripts/verify-server.ts -- vpx apps/mobile/scripts/e2e.ts android
//	vpx scripts/verify-server.ts -- vpx apps/mobile/scripts/e2e.ts ios

import { setTimeout as sleep } from "node:timers/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VibeValleyApi } from "@vibevalley/protocol";

const platform = process.argv[2] === "ios" ? "ios" : "android";
const server = process.env.VIBEVALLEY_SERVER;
if (server === undefined || server === "") throw new Error("VIBEVALLEY_SERVER is not set: run this under scripts/verify-server.ts");
const mobile = join(import.meta.dirname, "..");
const out = join(mobile, ".screens");
mkdirSync(out, { recursive: true });
const run = (cmd: string, ...args: string[]) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
const until = async <T>(get: () => Promise<T | undefined> | T | undefined, what: string, ms = 120_000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    const got = await get();
    if (got !== undefined) return got;
  }
  throw new Error("waited for " + what);
};

interface Device {
  install(): void;
  /** Quits the app and starts it again as the owner would, with no link. */
  restart(): void;
  /** Evaluates expression in the page (awaiting a promise), where the build lets DevTools in; undefined where it cannot. */
  evaluate(expression: string): Promise<unknown>;
  /** Whether a notification saying text is showing. */
  notified(text: string): boolean;
  open(url: string): void;
  screenshot(file: string): void;
}

function android(): Device {
  const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Library/Android/sdk");
  const adb = (...args: string[]) => run(join(sdk, "platform-tools/adb"), ...args);
  const apk = join(mobile, "android/app/build/outputs/apk/release/app-release.apk");
  if (!existsSync(apk)) throw new Error("no built app at " + apk);
  return {
    // A fresh install: no farm kept, nothing cached from an earlier run.
    install: () => {
      try {
        adb("uninstall", "dev.vibevalley.mobile");
      } catch {
        // Not installed.
      }
      adb("install", "-g", apk);
    },
    restart: () => (adb("shell", "am", "force-stop", "dev.vibevalley.mobile"), adb("shell", "am", "start", "-n", "dev.vibevalley.mobile/.MainActivity")),
    open: (url) => adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `'${url}'`, "dev.vibevalley.mobile"),
    screenshot: (file) => writeFileSync(file, execFileSync(join(sdk, "platform-tools/adb"), ["exec-out", "screencap", "-p"])),
    // The WebView's DevTools socket, open in an end-to-end build (EXPO_PUBLIC_VIBEVALLEY_E2E=1, FarmScreen.tsx).
    evaluate: async (expression) => {
      // Every WebView in the emulator has one; the app's is the one showing the farm's page.
      let page: { url: string; webSocketDebuggerUrl: string } | undefined;
      // A port each: a kept-alive connection to one port would still reach the socket it was forwarded to before.
      let port = 9333;
      for (const socket of new Set(adb("shell", "cat", "/proc/net/unix").match(/webview_devtools_remote_\d+/g) ?? [])) {
        adb("forward", `tcp:${++port}`, "localabstract:" + socket);
        const pages = (await (await fetch(`http://127.0.0.1:${port}/json`).catch(() => undefined))?.json().catch(() => [])) as
          | { url: string; webSocketDebuggerUrl: string }[]
          | undefined;
        page = (pages ?? []).find((p) => p.url.startsWith(farmUrl));
        if (page) break;
      }
      if (!page) return undefined;
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));
      const answer = new Promise<unknown>((resolve) =>
        ws.addEventListener("message", (e) => {
          const m = JSON.parse(String(e.data)) as { id?: number; result?: { result?: { value?: unknown } } };
          if (m.id === 1) resolve(m.result?.result?.value);
        }),
      );
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
      const value = await answer;
      ws.close();
      return value;
    },
    // dumpsys can end non-zero after writing what it has: its output is read either way.
    notified: (text) =>
      spawnSync(join(sdk, "platform-tools/adb"), ["shell", "dumpsys", "notification", "--noredact"], { encoding: "utf8", maxBuffer: 64 << 20 }).stdout.includes(
        text,
      ),
  };
}

function ios(): Device {
  // The framework's own simctl: Xcode's wrapper first insists on its first-launch install.
  const simctl = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl";
  const app = join(mobile, "ios/build/Build/Products/Release-iphonesimulator/VibeValley.app");
  if (!existsSync(app)) throw new Error("no built app at " + app);
  const device = process.env.VIBEVALLEY_SIMULATOR ?? "iPhone 17";
  const sim = (...args: string[]) => run(simctl, ...args);
  try {
    sim("boot", device);
  } catch {
    // Booted already.
  }
  sim("bootstatus", device, "-b");
  return {
    install: () => (sim("install", device, app), sim("privacy", device, "grant", "all", "dev.vibevalley.mobile")),
    restart: () => (sim("terminate", device, "dev.vibevalley.mobile"), sim("launch", device, "dev.vibevalley.mobile")),
    // openurl stops at the system's "Open in VibeValley?": an e2e build takes the link as a launch argument (App.tsx).
    open: (url) => void sim("launch", device, "dev.vibevalley.mobile", "-vibevalleyPair", url),
    screenshot: (file) => void sim("io", device, "screenshot", file),
    evaluate: async () => undefined,
    notified: () => false,
  };
}

let farmUrl = "http";
const phone = platform === "ios" ? ios() : android();
const api = new VibeValleyApi(server);
await api.lan.update({ open: true });
try {
  const { pairing } = await api.lan.pairing.start();
  if (!pairing) throw new Error("no pairing: the farm found no address on the network");
  const farm = new URL(pairing.link).origin;
  farmUrl = farm;
  console.log("pairing", pairing.link);
  phone.install();
  phone.open(`vibevalley://pair?u=${encodeURIComponent(farm)}&c=${encodeURIComponent(pairing.code)}`);

  const asking = await until(async () => (await api.lan.get()).pairing?.asking, "the phone asks to pair");
  console.log("asking", asking);
  await api.lan.pairing.answer({ allow: true });
  const paired = await until(async () => (await api.lan.get()).devices.find((d) => d.name === asking), "the phone paired");
  // Its page's requests through the lan listener carry the key: the farm has heard from it since.
  await until(
    async () => ((await api.lan.get()).devices.find((d) => d.id === paired.id)?.lastSeen ?? 0) > paired.pairedAt || undefined,
    "the phone's page reaching the farm",
  );
  console.log("paired and seen", paired.name);
  await sleep(5000);
  const shot = join(out, `${platform}-farm.png`);
  phone.screenshot(shot);
  console.log(shot);

  // The page is the phone's host: it has installed the bridge's receiver, and a notice posted over the bridge is answered
  // and shown by the phone.
  const bridgeNotice = (body: string) =>
    phone.evaluate(`new Promise((resolve) => {
      if (typeof window.vibevalleyFromHost !== "function") return resolve("no host");
      const page = window.vibevalleyFromHost;
      window.vibevalleyFromHost = (m) => {
        if (m.id !== 9001) return page(m);
        window.vibevalleyFromHost = page;
        resolve(m);
      };
      window.ReactNativeWebView.postMessage(JSON.stringify({ id: 9001, call: "notify", notice: { title: "VibeValley", body: ${JSON.stringify(body)} } }));
    })`);
  const bridged = await bridgeNotice("桥通了：端到端");
  if (bridged !== undefined) {
    if (JSON.stringify(bridged) !== JSON.stringify({ id: 9001, ok: true })) throw new Error("the bridge answered " + JSON.stringify(bridged));
    await until(() => phone.notified("桥通了：端到端") || undefined, "the phone's notification", 10_000);
    console.log("bridge: the page's notice shown by the phone");
    await phone.evaluate("setTimeout(() => location.reload(), 0); true");
    await sleep(1000);
    await until(async () => ((await phone.evaluate("typeof window.vibevalleyFromHost")) === "function" ? true : undefined), "the reloaded page's host");
    const reloaded = await bridgeNotice("桥通了：重新加载");
    if (JSON.stringify(reloaded) !== JSON.stringify({ id: 9001, ok: true })) throw new Error("the reloaded bridge answered " + JSON.stringify(reloaded));
    await until(() => phone.notified("桥通了：重新加载") || undefined, "the reloaded page's notification", 10_000);
    console.log("bridge: the reloaded page owns a fresh host");
  } else console.log("bridge: not checked (not an end-to-end build)");

  // Started again with no link: the key from the keychain, straight to the farm, nothing asked.
  const before = (await api.lan.get()).devices.find((d) => d.id === paired.id)!.lastSeen ?? 0;
  await sleep(1100);
  phone.restart();
  await until(
    async () => ((await api.lan.get()).devices.find((d) => d.id === paired.id)?.lastSeen ?? 0) > before || undefined,
    "the phone back on the farm after a restart",
  );
  if ((await api.lan.get()).pairing) throw new Error("it asked to pair again");
  console.log("back after a restart");
} finally {
  for (const d of (await api.lan.get()).devices) await api.lan.device.delete({ id: d.id });
  await api.lan.update({ open: false });
}
