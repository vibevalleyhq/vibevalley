// The workbench's places, in the rail's order; 设置 sits at the rail's bottom.

import { t } from "@vibevalley/i18n";
import type { IconName } from "@/ui/icons";

export interface Place {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly icon: IconName;
  readonly path: string;
}

export const settingsPlace: Place = {
  id: "settings",
  label: t("web.base.place.settings.label"),
  hint: t("web.base.place.settings.hint"),
  icon: "settings",
  path: "/settings",
};

export const places: readonly Place[] = [
  { id: "chat", label: t("web.base.place.chat.label"), hint: t("web.base.place.chat.hint"), icon: "chat", path: "/chat" },
  { id: "issues", label: t("web.base.place.issues.label"), hint: t("web.base.place.issues.hint"), icon: "issues", path: "/issues" },
  { id: "artifacts", label: t("web.artifact.place.label"), hint: t("web.artifact.place.hint"), icon: "artifacts", path: "/artifacts" },
  { id: "agents", label: t("web.base.place.agents.label"), hint: t("web.base.place.agents.hint"), icon: "agents", path: "/agents" },
  { id: "runtimes", label: t("web.base.place.runtimes.label"), hint: t("web.base.place.runtimes.hint"), icon: "runtimes", path: "/runtimes" },
  { id: "projects", label: t("web.base.place.projects.label"), hint: t("web.base.place.projects.hint"), icon: "projects", path: "/projects" },
  { id: "catalog", label: t("web.base.place.catalog.label"), hint: t("web.base.place.catalog.hint"), icon: "catalog", path: "/catalog" },
  settingsPlace,
];

/** The place a path is in (/orchestrator is the agents' too); undefined for the farm. */
export function placeOf(path: string): Place | undefined {
  if (path.startsWith("/orchestrator")) return places.find((p) => p.id === "agents");
  return places.find((p) => path === p.path || path.startsWith(`${p.path}/`));
}
