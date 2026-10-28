// The phone's own words follow the phone's language; the page it opens follows the farm's.

import { setLocale } from "@vibevalley/i18n";

export const followDevice = () => setLocale(Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh") ? "zh" : "en");
