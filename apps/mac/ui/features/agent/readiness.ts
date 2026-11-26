import { t } from "@vibevalley/i18n";

import { fixOf } from "../../infra/readiness";

export interface LocalizedAgentProblem {
  readonly text: string;
  readonly fixHref?: string | undefined;
}

const DEEPSEEK_KEY_RE = /no\s+deepseek\s+api\s+key\s+is\s+set/iu;
const GENERIC_API_KEY_RE = /no\s+api\s+key\s+is\s+set/iu;

/** Localizes raw English engine readiness errors and attaches the matching settings route when actionable. */
export function localizeAgentProblem(raw: string): LocalizedAgentProblem {
  if (DEEPSEEK_KEY_RE.test(raw)) {
    const fix = fixOf("deepseekKey");
    return { text: fix.words, fixHref: fix.href };
  }
  if (GENERIC_API_KEY_RE.test(raw)) {
    return { text: t("web.agent.missingApiKey"), fixHref: fixOf("deepseekKey").href };
  }
  return { text: raw };
}
