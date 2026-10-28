import { t } from "@vibevalley/i18n";
// Money in words.

export const yuan = (cny: number) => (cny > 0 && cny < 0.01 ? t("server.runtime.lessThanCent") : "¥" + cny.toFixed(2));

export const quotaLow = 15;
