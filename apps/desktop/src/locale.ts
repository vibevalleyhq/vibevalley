import { savedLocale } from "@vibevalley/home";
import { setLocale } from "@vibevalley/i18n";

export const followSavedLocale = (home: string) => setLocale(savedLocale(home));
