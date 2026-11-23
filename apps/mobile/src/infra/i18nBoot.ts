import { locale } from "nsh";

import { setLocale, type Locale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";

function resolveMobileLocale(tag: string): Locale {
  return tag.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function syncMobileLocale(): Locale {
  const next = resolveMobileLocale(locale());
  setLocale(next);
  return next;
}

syncMobileLocale();
