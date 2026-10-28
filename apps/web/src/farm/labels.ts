import { t } from "@vibevalley/i18n";

import type { IssueAct } from "@vibevalley/protocol";

/** The farm's words for an issue's acts where they are its own: completing a change is a harvest here. */
export const farmActWords: Partial<Record<IssueAct, string>> = { complete: t("web.farm.tool.harvest.label") };
