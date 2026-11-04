// The desktop app's language is the farm's: the one saved in the home's settings.json (@vibevalley/home) until the page
// says the one it speaks (host.locale), which it does whenever it loads.

import { savedLocale } from "@vibevalley/home";
import { setLocale } from "@vibevalley/i18n";

export const followSavedLocale = (home: string) => setLocale(savedLocale(home));
