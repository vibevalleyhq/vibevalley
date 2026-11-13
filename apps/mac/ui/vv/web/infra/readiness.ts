import { t } from "@vibevalley/i18n";
import type { Missing } from "@vibevalley/protocol";

/** Where each thing a feature lacks is set up. */
const placeOf: Record<Missing, string> = {
  deepseekKey: "/settings/accounts",
  mossAccount: "/settings/accounts",
  mossKey: "/settings/accounts",
  mossOff: "/settings/accounts",
  binding: "/settings/providers",
  agora: "/settings/accounts",
  dictationUrl: "/settings/dictation",
};

/** What a feature lacks, in words, and the settings page that fixes it (SettingsStatus.readiness says what lacks). */
export const fixOf = (missing: Missing) => ({ words: t(`web.setting.missing.${missing}`), href: placeOf[missing] });
