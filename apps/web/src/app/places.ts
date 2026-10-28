import type { IconName } from "../ui/icons";
import { appWording } from "../base/words";
// The workbench's places, in the rail's order; 设置 sits at the rail's bottom.

export interface Place {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly icon: IconName;
  readonly path: string;
}

export const places: readonly Place[] = [
  { id: "chat", label: appWording().place.chat.label, hint: appWording().place.chat.hint, icon: "chat", path: "/chat" },
  { id: "issues", label: appWording().place.issues.label, hint: appWording().place.issues.hint, icon: "issues", path: "/issues" },
  { id: "docs", label: appWording().place.docs.label, hint: appWording().place.docs.hint, icon: "docs", path: "/docs" },
  { id: "agents", label: appWording().place.agents.label, hint: appWording().place.agents.hint, icon: "agents", path: "/agents" },
  { id: "runtimes", label: appWording().place.runtimes.label, hint: appWording().place.runtimes.hint, icon: "runtimes", path: "/runtimes" },
  { id: "projects", label: appWording().place.projects.label, hint: appWording().place.projects.hint, icon: "projects", path: "/projects" },
  { id: "catalog", label: appWording().place.catalog.label, hint: appWording().place.catalog.hint, icon: "catalog", path: "/catalog" },
  { id: "settings", label: appWording().place.settings.label, hint: appWording().place.settings.hint, icon: "settings", path: "/settings" },
];

/** The place a path is in (/orchestrator is the agents' too); undefined for the farm. */
export function placeOf(path: string): Place | undefined {
  if (path.startsWith("/orchestrator")) return places.find((p) => p.id === "agents");
  return places.find((p) => path === p.path || path.startsWith(`${p.path}/`));
}
