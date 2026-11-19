import { t } from "@vibevalley/i18n";

/** A short span: seconds under a minute (at least one), else minutes. */
export const spanText = (ms: number) =>
  ms < 60_000 ? t("shared.seconds", { n: Math.max(1, Math.round(ms / 1000)) }) : t("shared.minutes", { n: Math.round(ms / 60_000) });
