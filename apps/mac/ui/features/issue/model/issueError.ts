import { t } from "@vibevalley/i18n";

import { fixOf } from "../../../infra/readiness";

const missingApiKeyClause = /\bno\s+(?:deepseek\s+)?api\s+key\s+(?:is\s+set(?:\s+for\s+the\s+model)?|configured|found)\b(?:\s*\([^)]*\))?\.?/iu;

export interface LocalizedIssueError {
  readonly text: string;
  readonly settingsHref?: string;
}

/**
 * Maps raw English runtime API-key errors (e.g. `no API key is set for the model`) into localized copy
 * and attaches the Settings route so users can configure credentials in one click.
 */
export function localizeIssueError(raw: string): LocalizedIssueError {
  if (!missingApiKeyClause.test(raw)) return { text: raw };
  const message = t("web.issue.error.missingApiKey");
  const settingsHref = fixOf("deepseekKey").href;
  const trimmed = raw.trim();
  const replaced = trimmed.replace(missingApiKeyClause, message);
  return { text: replaced, settingsHref };
}
