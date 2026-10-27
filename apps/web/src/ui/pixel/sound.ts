// The pixel skins' sounds, synthesized from recipes (no audio files); when the farm plays them is farm/cues.ts.
// Levels come in three steps of loudness: clicks about -28, work on the beds and state changes about -24, rewards about -20. Kept below speech on
// purpose: once voice is on, the microphone sits next to these.

import { farmWording } from "../../farm/words";
import { createSynth, renderRecipe, type Pen, type Recipe, type Synth } from "@vibevalley/engine/audio";

function grains(
  pen: Pen,
  {
    at = 0,
    span,
    count,
    freq,
    gain,
    q = 2,
    filter = "bandpass",
  }: { at?: number; span: number; count: number; freq: number; gain: number; q?: number; filter?: BiquadFilterType },
) {
  for (let i = 0; i < count; i++) {
    // In this order: frequency, start, length, level (the seeded pen depends on it).
    const f = freq * (0.8 + pen.random() * 0.5);
    const start = at + pen.random() * span;
    const dur = 0.03 + pen.random() * 0.05;
    const g = gain * (0.6 + pen.random() * 0.4);
    pen.noise({ filter, freq: f, q, at: start, dur, gain: g });
  }
}

export const SOUNDS = {
  // A click that does something: a soft wooden tock.
  tap: (pen) => {
    pen.tone({ freq: 620, to: 480, type: "triangle", dur: 0.06, gain: 1.9 });
    pen.noise({ filter: "highpass", freq: 3000, dur: 0.025, gain: 0.59 });
  },
  // A click that does nothing: two dull knocks.
  nope: (pen) => {
    pen.tone({ freq: 180, to: 140, dur: 0.09, gain: 0.42 });
    pen.noise({ filter: "lowpass", freq: 500, dur: 0.06, gain: 0.23 });
    pen.tone({ at: 0.11, freq: 150, to: 115, dur: 0.11, gain: 0.38 });
    pen.noise({ at: 0.11, filter: "lowpass", freq: 420, dur: 0.07, gain: 0.19 });
  },
  // Picking up a tool: a wooden clack.
  pick: (pen) => {
    pen.noise({ filter: "bandpass", freq: 1900, q: 5, dur: 0.035, gain: 4.24 });
    pen.tone({ freq: 880, to: 700, dur: 0.05, gain: 1.55 });
    pen.noise({ at: 0.05, filter: "bandpass", freq: 1500, q: 5, dur: 0.03, gain: 1.93 });
  },
  // A panel or a dock opening: a short rising swish.
  open: (pen) => pen.noise({ filter: "bandpass", freq: 700, to: 2600, q: 1.4, dur: 0.22, gain: 0.72, attack: 0.08 }),
  // …and closing: the same swish falling.
  close: (pen) => pen.noise({ filter: "bandpass", freq: 2400, to: 650, q: 1.4, dur: 0.2, gain: 0.62, attack: 0.05 }),
  // 浇水: water pouring, then drops landing on the soil.
  water: (pen) => {
    pen.noise({ filter: "bandpass", freq: 900, to: 1500, q: 1.1, dur: 0.75, gain: 0.53, attack: 0.12 });
    pen.noise({ filter: "highpass", freq: 5000, dur: 0.6, gain: 0.1, attack: 0.1 });
    for (let i = 0; i < 6; i++) {
      const at = 0.15 + pen.random() * 0.6;
      const freq = 1100 + pen.random() * 900;
      pen.tone({ at, freq, to: freq * 0.55, dur: 0.06, gain: 0.23 });
    }
  },
  // 杀虫: two quick pumps of the sprayer.
  spray: (pen) => {
    for (const at of [0, 0.22]) {
      pen.noise({ at, filter: "highpass", freq: 3800, dur: 0.17, gain: 0.23, attack: 0.01 });
      pen.noise({ at, filter: "bandpass", freq: 6500, q: 2, dur: 0.12, gain: 0.1 });
    }
  },
  // 除草: a root pulled out of the ground, and the leaves rustling.
  weed: (pen) => {
    pen.tone({ freq: 210, to: 90, dur: 0.12, gain: 1.61 });
    grains(pen, { at: 0.04, span: 0.22, count: 7, freq: 2600, gain: 0.56 });
  },
  // 收获: a rustle of stalks, then a little chime.
  harvest: (pen) => {
    grains(pen, { span: 0.25, count: 9, freq: 3200, gain: 0.16 });
    pen.bell({ at: 0.18, freq: 1047, dur: 0.6, gain: 0.19 });
    pen.bell({ at: 0.28, freq: 1319, dur: 0.7, gain: 0.16 });
  },
  // 铲除: the shovel biting into soil, and the soil falling back.
  shovel: (pen) => {
    pen.noise({ filter: "lowpass", freq: 450, dur: 0.16, gain: 1.79, attack: 0.004 });
    pen.tone({ freq: 120, to: 55, dur: 0.16, gain: 1.49 });
    grains(pen, { at: 0.1, span: 0.3, count: 8, freq: 900, gain: 0.48, filter: "lowpass" });
  },
  // A seed going in: a soft pop.
  plant: (pen) => {
    pen.tone({ freq: 320, to: 760, dur: 0.09, gain: 1.34 });
    pen.noise({ at: 0.03, filter: "lowpass", freq: 600, dur: 0.06, gain: 0.68 });
  },
  // A bed ripens: a twinkle going up.
  ripe: (pen) => {
    [1568, 2093, 2637].forEach((freq, i) => pen.bell({ at: i * 0.07, freq, dur: 0.45, gain: 0.12 }));
  },
  // Bugs on a bed: a short buzz.
  bug: (pen) => {
    pen.tone({ freq: 190, type: "sawtooth", dur: 0.32, gain: 0.48, attack: 0.02, lowpass: 1100 });
    pen.tone({ freq: 196, type: "sawtooth", dur: 0.32, gain: 0.38, attack: 0.02, lowpass: 1100 });
    pen.tone({ at: 0.36, freq: 210, type: "sawtooth", dur: 0.2, gain: 0.38, attack: 0.02, lowpass: 1000 });
  },
  // Coins: the classic two-step ching, with a bell on top.
  coin: (pen) => {
    pen.tone({ freq: 988, type: "square", dur: 0.08, gain: 0.23, lowpass: 4000 });
    pen.tone({ at: 0.07, freq: 1319, type: "square", dur: 0.25, gain: 0.23, lowpass: 4500 });
    pen.bell({ at: 0.07, freq: 2637, dur: 0.3, gain: 0.11 });
  },
  // Level up: a rising arpeggio landing on a bell chord.
  levelUp: (pen) => {
    [523, 659, 784, 1047].forEach((freq, i) => pen.tone({ at: i * 0.09, freq, type: "triangle", dur: 0.24, gain: 0.23 }));
    pen.bell({ at: 0.38, freq: 1047, dur: 1.1, gain: 0.16 });
    pen.bell({ at: 0.38, freq: 1319, dur: 1.1, gain: 0.12 });
    pen.bell({ at: 0.38, freq: 1568, dur: 1.1, gain: 0.1 });
  },
  // An achievement: two bells and a sparkle.
  achievement: (pen) => {
    pen.bell({ freq: 784, dur: 0.6, gain: 0.21 });
    pen.bell({ at: 0.12, freq: 1175, dur: 0.9, gain: 0.21 });
    grains(pen, { at: 0.15, span: 0.35, count: 6, freq: 7000, gain: 0.064, q: 4 });
  },
  // A helper walks onto the farm: a light little hop.
  arrive: (pen) => {
    pen.tone({ freq: 440, to: 520, type: "triangle", dur: 0.08, gain: 0.48 });
    pen.tone({ at: 0.09, freq: 660, to: 760, type: "triangle", dur: 0.1, gain: 0.43 });
  },
  // A poke at the grass or a bush: a short rustle of leaves.
  rustle: (pen) => {
    grains(pen, { span: 0.18, count: 8, freq: 3000, gain: 0.5 });
    grains(pen, { at: 0.05, span: 0.15, count: 4, freq: 1800, gain: 0.3 });
  },
  // A poke at the pond: a small plop and a couple of drops.
  splash: (pen) => {
    pen.tone({ freq: 720, to: 260, dur: 0.09, gain: 1.1 });
    pen.noise({ filter: "bandpass", freq: 1400, q: 1.2, dur: 0.12, gain: 0.43 });
    pen.tone({ at: 0.12, freq: 1300, to: 800, dur: 0.05, gain: 0.3 });
    pen.tone({ at: 0.19, freq: 1100, to: 700, dur: 0.05, gain: 0.24 });
  },
  // A poke at the dirt: a soft thump and a puff of dust.
  thud: (pen) => {
    pen.tone({ freq: 150, to: 80, dur: 0.09, gain: 1.3 });
    pen.noise({ filter: "lowpass", freq: 700, dur: 0.08, gain: 0.56 });
  },
  // The dog barks, two small happy woofs.
  woof: (pen) => {
    pen.tone({ freq: 560, to: 360, type: "sawtooth", dur: 0.08, gain: 0.44, attack: 0.008, lowpass: 1500 });
    pen.tone({ at: 0.13, freq: 620, to: 380, type: "sawtooth", dur: 0.1, gain: 0.41, attack: 0.008, lowpass: 1500 });
  },
  // The dog jumps: one short, high yip.
  yip: (pen) => pen.tone({ freq: 900, to: 620, type: "sawtooth", dur: 0.09, gain: 1.45, attack: 0.005, lowpass: 2400 }),
  // The dog, pleased: quick soft pants.
  pant: (pen) => {
    [0, 0.12, 0.24].forEach((at, i) => pen.noise({ at, filter: "bandpass", freq: 1500 - i * 120, q: 1.6, dur: 0.08, gain: 1.4 }));
  },
  // A cat (the pet, when it is one): a meow, up and down.
  meow: (pen) => {
    pen.tone({ freq: 620, to: 980, type: "triangle", dur: 0.14, gain: 0.5, attack: 0.02, lowpass: 2600 });
    pen.tone({ at: 0.13, freq: 980, to: 560, type: "triangle", dur: 0.22, gain: 0.45, lowpass: 2400 });
  },
  // …a short, high mew (its jump).
  mew: (pen) => pen.tone({ freq: 1100, to: 1400, type: "triangle", dur: 0.1, gain: 0.5, attack: 0.01, lowpass: 3000 }),
  // …and a purr, pleased: a low, rough rumble.
  purr: (pen) => {
    for (let i = 0; i < 12; i++) pen.noise({ at: i * 0.045, filter: "lowpass", freq: 260, dur: 0.035, gain: 1.6 });
  },
  // The voice call connects: two notes up, like a phone picked up.
  voiceOn: (pen) => {
    pen.bell({ freq: 659, dur: 0.35, gain: 0.19 });
    pen.bell({ at: 0.12, freq: 988, dur: 0.5, gain: 0.19 });
  },
  // The farm phone rings: an old desk phone's double trill, twice.
  ring: (pen) => {
    for (const at of [0, 0.42]) {
      for (let i = 0; i < 8; i++) pen.bell({ at: at + i * 0.04, freq: i % 2 === 1 ? 1320 : 1480, dur: 0.05, gain: 0.07 });
    }
  },
  // …and hangs up: the same two notes down.
  voiceOff: (pen) => {
    pen.bell({ freq: 988, dur: 0.3, gain: 0.19 });
    pen.bell({ at: 0.12, freq: 587, dur: 0.45, gain: 0.19 });
  },
} satisfies Record<string, Recipe>;

export type SoundName = keyof typeof SOUNDS;

export const SOUND_GROUPS: readonly { title: string; names: readonly SoundName[] }[] = [
  { title: farmWording().sound.group.ui, names: ["tap", "nope", "pick", "open", "close"] },
  { title: farmWording().sound.group.tools, names: ["water", "spray", "weed", "harvest", "shovel"] },
  { title: farmWording().sound.group.field, names: ["plant", "arrive", "ripe", "bug"] },
  { title: farmWording().sound.group.yard, names: ["rustle", "splash", "thud", "woof", "yip", "pant", "meow", "mew", "purr"] },
  { title: farmWording().sound.group.reward, names: ["coin", "levelUp", "achievement"] },
  { title: farmWording().sound.group.voice, names: ["voiceOn", "voiceOff", "ring"] },
];

export const SOUND_LABEL: Readonly<Record<SoundName, string>> = {
  tap: farmWording().sound.label.tap,
  nope: farmWording().sound.label.nope,
  pick: farmWording().sound.label.pick,
  open: farmWording().sound.label.open,
  close: farmWording().sound.label.close,
  water: farmWording().water.water,
  spray: farmWording().tool.bug.label,
  weed: farmWording().tool.weed.label,
  harvest: farmWording().tool.harvest.label,
  shovel: farmWording().tool.shovel.label,
  plant: farmWording().aim.sow,
  ripe: farmWording().sound.label.ripe,
  bug: farmWording().sound.label.bug,
  coin: farmWording().sound.label.coin,
  levelUp: farmWording().sound.label.levelUp,
  achievement: farmWording().sound.label.achievement,
  arrive: farmWording().sound.label.arrive,
  rustle: farmWording().sound.label.rustle,
  splash: farmWording().sound.label.splash,
  thud: farmWording().sound.label.thud,
  woof: farmWording().sound.label.woof,
  meow: farmWording().sound.label.meow,
  mew: farmWording().sound.label.mew,
  purr: farmWording().sound.label.purr,
  yip: farmWording().sound.label.yip,
  pant: farmWording().sound.label.pant,
  voiceOn: farmWording().sound.label.voiceOn,
  voiceOff: farmWording().sound.label.voiceOff,
  ring: farmWording().sound.label.ring,
};

/** Offline, for measuring levels. Needs OfflineAudioContext. */
export function renderSound(name: SoundName): Promise<AudioBuffer> {
  return renderRecipe(SOUNDS[name], { seconds: 2, volume: 0.55 });
}

const mutedKey = "vibevalley.farm.muted";
const muteListeners = new Set<() => void>();
let muted: boolean | undefined;

export function isMuted(): boolean {
  if (muted === undefined) {
    try {
      muted = localStorage.getItem(mutedKey) === "true";
    } catch {
      muted = false;
    }
  }
  return muted;
}

export function setMuted(next: boolean) {
  if (next === isMuted()) return;
  muted = next;
  try {
    localStorage.setItem(mutedKey, String(next));
  } catch {
    // No storage: muted for this page only.
  }
  for (const l of muteListeners) l();
}

export function subscribeMuted(listener: () => void) {
  muteListeners.add(listener);
  // Another tab on this machine changed it.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== mutedKey) return;
    muted = e.newValue === "true";
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    muteListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

let synth: Synth | undefined;

export function playSound(name: SoundName) {
  if (isMuted() || typeof AudioContext === "undefined") return;
  try {
    synth ??= createSynth({ volume: 0.55 });
    // Makes the context on first use; before the first gesture it stays suspended and this play is silent.
    synth.unlock();
    synth.play(SOUNDS[name]);
  } catch {
    // No audio device: the farm goes on silently.
  }
}

/** Browsers start audio only after a gesture; call from one. */
export function unlockSound() {
  if (typeof AudioContext === "undefined") return;
  try {
    synth ??= createSynth({ volume: 0.55 });
    synth.unlock();
  } catch {
    // As in playSound.
  }
}
