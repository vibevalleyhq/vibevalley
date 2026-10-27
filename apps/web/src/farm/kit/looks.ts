import { farmWording } from "../words";
// The orchestrator's looks and the pets the owner can pick (data/prefs.ts keeps the choice), and their sprites.

/** The orchestrator's looks: sprite orchestrator-<id>, the plain one is farmer. */
export const orchestratorLooks: readonly { readonly id: string; readonly name: string; readonly blurb: string }[] = [
  { id: "farmer", name: farmWording().looks.farmer.name, blurb: farmWording().looks.farmer.blurb },
  { id: "foreman", name: farmWording().looks.foreman.name, blurb: farmWording().looks.foreman.blurb },
  { id: "auntie", name: farmWording().looks.auntie.name, blurb: farmWording().looks.auntie.blurb },
  { id: "grandpa", name: farmWording().looks.grandpa.name, blurb: farmWording().looks.grandpa.blurb },
  { id: "gardener", name: farmWording().looks.gardener.name, blurb: farmWording().looks.gardener.blurb },
  { id: "robot", name: farmWording().looks.robot.name, blurb: farmWording().looks.robot.blurb },
];

/** The young farmer stands in for a look not painted. */
export const orchestratorSprite = (look: string, suffix: string, has: (name: string) => boolean) =>
  has(`manager-${look}${suffix}`) ? `manager-${look}${suffix}` : `manager${suffix}`;

export const lookReady = (look: string, has: (name: string) => boolean) => look === "farmer" || has(`manager-${look}`);

export const petName: Record<string, string> = { dog: farmWording().pet.dog, ragdoll: farmWording().pet.ragdoll, bluecat: farmWording().pet.bluecat };
