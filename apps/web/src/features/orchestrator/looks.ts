// The orchestrators' looks (an orchestrator's profile keeps its own) and the pets the owner can pick (base/prefs.ts
// keeps the choice), and their sprites.

import { t } from "@vibevalley/i18n";
import type { OrchestratorLook } from "@vibevalley/protocol";

/** The orchestrators' looks: sprite manager-<id>, the plain one is farmer. */
export const orchestratorLooks: readonly { readonly id: OrchestratorLook; readonly name: string; readonly blurb: string }[] = [
  { id: "farmer", name: t("web.orchestrator.looks.farmer.name"), blurb: t("web.orchestrator.looks.farmer.blurb") },
  { id: "foreman", name: t("web.orchestrator.looks.foreman.name"), blurb: t("web.orchestrator.looks.foreman.blurb") },
  { id: "auntie", name: t("web.orchestrator.looks.auntie.name"), blurb: t("web.orchestrator.looks.auntie.blurb") },
  { id: "grandpa", name: t("web.orchestrator.looks.grandpa.name"), blurb: t("web.orchestrator.looks.grandpa.blurb") },
  { id: "gardener", name: t("web.orchestrator.looks.gardener.name"), blurb: t("web.orchestrator.looks.gardener.blurb") },
  { id: "robot", name: t("web.orchestrator.looks.robot.name"), blurb: t("web.orchestrator.looks.robot.blurb") },
];

/** The young farmer stands in for a look not painted. */
export const orchestratorSprite = (look: string, suffix: string, has: (name: string) => boolean) =>
  has(`manager-${look}${suffix}`) ? `manager-${look}${suffix}` : `manager${suffix}`;

export const lookReady = (look: string, has: (name: string) => boolean) => look === "farmer" || has(`manager-${look}`);

export const petName: Record<string, string> = {
  dog: t("web.orchestrator.pet.dog"),
  ragdoll: t("web.orchestrator.pet.ragdoll"),
  bluecat: t("web.orchestrator.pet.bluecat"),
};
