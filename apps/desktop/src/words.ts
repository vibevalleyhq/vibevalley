// What the desktop app says itself: the tray's menu, the island's strip, and why the server could not start. Its language is the farm's:
// the one saved in the home's settings.json (the server's, setting.ts) until the page says the one it speaks
// (host.locale), which it does whenever it loads, so a change the owner makes there reaches the tray and the island.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { localized, setLocale } from "@vibevalley/protocol/words";

export function followSavedLocale(home: string) {
  try {
    setLocale((JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as { locale?: unknown }).locale === "en" ? "en" : "zh");
  } catch {
    // No settings yet: the default language.
  }
}

const zh = {
  open: "打开农场",
  quit: "退出",
  cannotStart: "VibeValley 起不来",
  seeLog: (reason: string, log: string) => `${reason}，日志在 ${log}`,
  noAddress: (seconds: number) => `服务端 ${seconds} 秒内没有发布就绪地址`,
  failed: (why: string) => `服务端启动失败：${why}`,
  exited: (code: number | null) => `服务端退出了（${code}）`,
  /** The island's strip, beside the camera. */
  working: (n: number) => (n > 0 ? `${n} 在干` : "没在干"),
  waiting: (n: number) => `${n} 等你`,
};

const en: typeof zh = {
  open: "Open the farm",
  quit: "Quit",
  cannotStart: "VibeValley cannot start",
  seeLog: (reason, log) => `${reason}; the log is at ${log}`,
  noAddress: (seconds) => `The server gave no ready address within ${seconds} seconds`,
  failed: (why) => `The server failed to start: ${why}`,
  exited: (code) => `The server exited (${code})`,
  working: (n) => (n > 0 ? `${n} working` : "idle"),
  waiting: (n) => `${n} for you`,
};

export const desktopWording = localized({ zh, en });
