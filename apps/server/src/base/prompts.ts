import { currentLocale } from "@vibevalley/i18n";

export const ownersLanguage = () => (currentLocale() === "en" ? "英文（English）" : "中文");
