// Named UI and farm sound effects: recipes are synthesized and cached in Rust
// (`apps/mac/src/audio.rs`) and played via `host.playSound`.
import { z } from "zod";

import { t } from "@vibevalley/i18n";

import { hostApi } from "../../infra/bridge";
import { defineStored } from "../../infra/state/stored";

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

export const SOUND_GROUPS: readonly { title: string; names: readonly SoundName[] }[] = [
  { title: t("web.ui.pixel.sound.group.ui"), names: ["tap", "nope", "pick", "open", "close"] },
  { title: t("web.ui.pixel.sound.group.tools"), names: ["water", "spray", "weed", "harvest", "shovel"] },
  { title: t("web.ui.pixel.sound.group.field"), names: ["plant", "arrive", "ripe", "bug"] },
  { title: t("web.ui.pixel.sound.group.yard"), names: ["rustle", "splash", "thud", "woof", "yip", "pant", "meow", "mew", "purr"] },
  { title: t("web.ui.pixel.sound.group.reward"), names: ["coin", "levelUp", "achievement"] },
  { title: t("web.ui.pixel.sound.group.voice"), names: ["voiceOn", "voiceOff", "ring"] },
];

export const SOUND_LABEL: Readonly<Record<SoundName, string>> = {
  tap: t("web.ui.pixel.sound.label.tap"),
  nope: t("web.ui.pixel.sound.label.nope"),
  pick: t("web.ui.pixel.sound.label.pick"),
  open: t("web.ui.pixel.sound.label.open"),
  close: t("web.ui.pixel.sound.label.close"),
  water: t("web.ui.pixel.sound.label.water"),
  spray: t("web.ui.pixel.sound.label.spray"),
  weed: t("web.ui.pixel.sound.label.weed"),
  harvest: t("web.ui.pixel.sound.label.harvest"),
  shovel: t("web.ui.pixel.sound.label.shovel"),
  plant: t("web.ui.pixel.sound.label.plant"),
  ripe: t("web.ui.pixel.sound.label.ripe"),
  bug: t("web.ui.pixel.sound.label.bug"),
  coin: t("web.ui.pixel.sound.label.coin"),
  levelUp: t("web.ui.pixel.sound.label.levelUp"),
  achievement: t("web.ui.pixel.sound.label.achievement"),
  arrive: t("web.ui.pixel.sound.label.arrive"),
  rustle: t("web.ui.pixel.sound.label.rustle"),
  splash: t("web.ui.pixel.sound.label.splash"),
  thud: t("web.ui.pixel.sound.label.thud"),
  woof: t("web.ui.pixel.sound.label.woof"),
  meow: t("web.ui.pixel.sound.label.meow"),
  mew: t("web.ui.pixel.sound.label.mew"),
  purr: t("web.ui.pixel.sound.label.purr"),
  yip: t("web.ui.pixel.sound.label.yip"),
  pant: t("web.ui.pixel.sound.label.pant"),
  voiceOn: t("web.ui.pixel.sound.label.voiceOn"),
  voiceOff: t("web.ui.pixel.sound.label.voiceOff"),
  ring: t("web.ui.pixel.sound.label.ring"),
};

/** Whether the sounds are off, kept on this machine; another tab turning them off turns them off here too. */
const muted = defineStored("farm.muted", z.boolean(), false);

const isMuted = muted.get;

/** Plays a sound unless muted; stays silent when no host is attached. */
export function playSound(name: SoundName) {
  if (isMuted()) return;
  void hostApi.playSound(name).catch(() => {});
}
