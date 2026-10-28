import type { ManagerLook } from "@vibevalley/protocol";
import { orchestratorWording } from "./words";
// The orchestrators' looks (an orchestrator's profile keeps its own) and the pets the owner can pick (base/prefs.ts
// keeps the choice), and their sprites.

/** The orchestrators' looks: sprite manager-<id>, the plain one is farmer. */
export const orchestratorLooks: readonly { readonly id: ManagerLook; readonly name: string; readonly blurb: string }[] = [
  { id: "farmer", name: orchestratorWording().looks.farmer.name, blurb: orchestratorWording().looks.farmer.blurb },
  { id: "foreman", name: orchestratorWording().looks.foreman.name, blurb: orchestratorWording().looks.foreman.blurb },
  { id: "auntie", name: orchestratorWording().looks.auntie.name, blurb: orchestratorWording().looks.auntie.blurb },
  { id: "grandpa", name: orchestratorWording().looks.grandpa.name, blurb: orchestratorWording().looks.grandpa.blurb },
  { id: "gardener", name: orchestratorWording().looks.gardener.name, blurb: orchestratorWording().looks.gardener.blurb },
  { id: "robot", name: orchestratorWording().looks.robot.name, blurb: orchestratorWording().looks.robot.blurb },
];

/** The young farmer stands in for a look not painted. */
export const orchestratorSprite = (look: string, suffix: string, has: (name: string) => boolean) =>
  has(`manager-${look}${suffix}`) ? `manager-${look}${suffix}` : `manager${suffix}`;

export const lookReady = (look: string, has: (name: string) => boolean) => look === "farmer" || has(`manager-${look}`);

export const petName: Record<string, string> = {
  dog: orchestratorWording().pet.dog,
  ragdoll: orchestratorWording().pet.ragdoll,
  bluecat: orchestratorWording().pet.bluecat,
};
