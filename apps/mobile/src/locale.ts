import { setLocale } from "@vibevalley/i18n";

export const followDevice = () => setLocale(Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh") ? "zh" : "en");
