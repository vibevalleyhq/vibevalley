import { t } from "@vibevalley/i18n";

import type { IconName } from "#/ui/icons.ts";

export interface Place {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly icon: IconName;
  readonly path: string;
  /** The rail's group it is drawn in: the day's work, setting things up, looking things up. */
  readonly group: "work" | "setup" | "reference";
}

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
  { id: "library", label: t("web.library.title"), hint: t("web.library.hint"), icon: "media", path: "/library", group: "work" },
  { id: "artifacts", label: t("web.artifact.place.label"), hint: t("web.artifact.place.hint"), icon: "artifacts", path: "/artifacts", group: "work" },
  { id: "pkm", label: t("web.pkm.place.label"), hint: t("web.pkm.place.hint"), icon: "notes", path: "/pkm", group: "work" },
  { id: "agents", label: t("web.base.place.agents.label"), hint: t("web.base.place.agents.hint"), icon: "agents", path: "/agents", group: "setup" },
  { id: "runtimes", label: t("web.base.place.runtimes.label"), hint: t("web.base.place.runtimes.hint"), icon: "runtimes", path: "/runtimes", group: "setup" },
  { id: "repos", label: t("web.base.place.repos.label"), hint: t("web.base.place.repos.hint"), icon: "repos", path: "/repos", group: "setup" },
  { id: "catalog", label: t("web.base.place.catalog.label"), hint: t("web.base.place.catalog.hint"), icon: "catalog", path: "/catalog", group: "reference" },
  settingsPlace,
];
