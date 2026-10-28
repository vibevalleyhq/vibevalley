// The desktop app's language is the farm's: the one saved in the home's settings.json (the server's, setting.ts) until
// the page says the one it speaks (host.locale), which it does whenever it loads.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setLocale } from "@vibevalley/i18n";

export function followSavedLocale(home: string) {
  try {
    setLocale((JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as { locale?: unknown }).locale === "en" ? "en" : "zh");
  } catch {
    // No settings yet: the default language.
  }
}
