import { currentLocale } from "@vibevalley/i18n";

export const usersLanguage = () => (currentLocale() === "en" ? "英文（English）" : "中文");
