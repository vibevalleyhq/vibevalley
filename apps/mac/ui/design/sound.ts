// Named UI and farm sound effects: recipes are synthesized and cached in Rust
// (`apps/mac/src/audio.rs`) and played via `host.playSound`.
import { z } from "zod";

import { hostApi } from "../infra/bridge";
import { defineStored } from "../infra/state/stored";

export const SOUNDS = {
  tap: true,
  nope: true,
  pick: true,
  open: true,
  close: true,
  water: true,
  spray: true,
  weed: true,
  harvest: true,
  shovel: true,
  plant: true,
  ripe: true,
  bug: true,
  coin: true,
  levelUp: true,
  achievement: true,
  arrive: true,
  rustle: true,
  splash: true,
  thud: true,
  woof: true,
  yip: true,
  pant: true,
  meow: true,
  mew: true,
  purr: true,
  voiceOn: true,
  ring: true,
  voiceOff: true,
} as const;

export type SoundName = keyof typeof SOUNDS;

/** Whether the sounds are off, kept on this machine; another tab turning them off turns them off here too. */
const muted = defineStored("farm.muted", z.boolean(), false);

const isMuted = muted.get;

/** Plays a sound unless muted; stays silent when no host is attached. */
export function playSound(name: SoundName) {
  if (isMuted()) return;
  void hostApi.playSound(name).catch(() => {});
}
