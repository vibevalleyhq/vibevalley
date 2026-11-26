import { t } from "@vibevalley/i18n";

import type { IconName } from "../design/icons";

export interface Place {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly icon: IconName;
  readonly path: string;
  /** The rail's group it is drawn in: the day's work, setting things up. */
  readonly group: "work" | "setup";
}

export const runsPlace: Place = {
  id: "runs",
  label: t("web.base.place.runs.label"),
  hint: t("web.base.place.runs.hint"),
  icon: "log",
  path: "/runs",
  group: "work",
};

export const settingsPlace: Place = {
  id: "settings",
  label: t("web.base.place.settings.label"),
  hint: t("web.base.place.settings.hint"),
  icon: "settings",
  path: "/settings",
  group: "setup",
};

export const places: readonly Place[] = [
  { id: "chat", label: t("web.base.place.chat.label"), hint: t("web.base.place.chat.hint"), icon: "chat", path: "/chat", group: "work" },
  { id: "issues", label: t("web.base.place.issues.label"), hint: t("web.base.place.issues.hint"), icon: "issues", path: "/issues", group: "work" },
  { id: "workspace", label: t("web.base.place.workspace.name"), hint: t("web.base.place.workspace.hint"), icon: "terminal", path: "/repos", group: "work" },
  { id: "content", label: t("web.base.place.content.label"), hint: t("web.base.place.content.hint"), icon: "media", path: "/library", group: "work" },
  { id: "runtimes", label: t("web.base.place.runtimes.label"), hint: t("web.base.place.runtimes.hint"), icon: "runtimes", path: "/runtimes", group: "setup" },
  { id: "team", label: t("web.base.place.team.label"), hint: t("web.base.place.team.hint"), icon: "agents", path: "/agents", group: "setup" },
  settingsPlace,
];
