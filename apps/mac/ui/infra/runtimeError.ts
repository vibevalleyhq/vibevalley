import { t } from "@vibevalley/i18n";

import { fixOf } from "./readiness";

const missingApiKeyClause = /\bno\s+(?:deepseek\s+)?api\s+key\s+(?:is\s+set(?:\s+for\s+the\s+model)?|configured|found)\b(?:\s*\([^)]*\))?\.?/giu;

interface LocalizedRuntimeError {
  readonly text: string;
  readonly settingsHref?: string;
}

/** Maps raw English runtime API-key errors (e.g. `no API key is set for the model`) into localized copy with a Settings link. */
export function localizeRuntimeError(raw: string): LocalizedRuntimeError {
  missingApiKeyClause.lastIndex = 0;
  if (!missingApiKeyClause.test(raw)) return { text: raw };
  missingApiKeyClause.lastIndex = 0;
  const message = t("web.issue.error.missingApiKey");
  const settingsHref = fixOf("deepseekKey").href;
  const trimmed = raw.trim();
  const replaced = trimmed.replace(missingApiKeyClause, message);
  return { text: replaced, settingsHref };
}
