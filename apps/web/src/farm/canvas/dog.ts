// The dog by the assistant's door, as the page draws it (it is not the farm's state). It sleeps most of the day and
// stirs now and then (lifts its head and yawns, or gets up to stretch and scratch); it sits up with you while the farm
// is open or the voice is live, and keeps busy there (a wag, a scratch, a yawn, a lie-down, a look around). It answers
// you: pointed at, it lifts its head (awake, it wags); pressed, it ducks; patted, it wakes, and every pat after that
// gets its next trick: a wag, a bark, a jump, rolling over for a belly rub. Three quick pats and it rolls over at once.
// A while after the last pat (with the farm closed) it yawns and lies down again.

import { cadence } from "@vibevalley/engine/pixi";

export type DogPicture =
  | "dog-sleep"
  | "dog-lie"
  | "dog-stretch"
  | "dog-awake"
  | "dog-wag-1"
  | "dog-wag-2"
  | "dog-bark"
  | "dog-scratch"
  | "dog-jump"
  | "dog-belly"
  | "dog-stand"
  | "dog-yawn";

/** What a pat gets. */
export type Trick = "wake" | "wag" | "bark" | "jump" | "belly";

/** What it shows: a picture, how far off the ground (a jump), how much taller with its feet put (a breath, a duck). */
export interface DogLook {
  readonly picture: DogPicture;
  readonly lift: number;
  readonly grow: number;
}

export interface Dog {
  /** What it shows at `t` seconds (the scene's clock). `listening`: the farm is open (its call is live) or the voice is, so it sits up. */
  readonly look: (t: number, listening: boolean) => DogLook;
  /** A pat at `t`: what it does about it. */
  readonly pet: (t: number) => Trick;
  /** The pointer or the keyboard is on it, or not. */
  readonly point: (on: boolean) => void;
  /** Pressed, it ducks until let go. */
  readonly press: (on: boolean) => void;
}

type Act = Trick | "stir" | "stretch" | "scratch" | "settle" | "yawn" | "rest" | "look";

interface Frame {
  readonly picture: DogPicture;
  readonly s: number;
  readonly lift?: number;
  readonly grow?: number;
}

const f = (picture: DogPicture, s: number, more: { lift?: number; grow?: number } = {}): Frame => ({ picture, s, ...more });
/** The tail going side to side for about `s` seconds. */
const wagging = (s: number): Frame[] => Array.from({ length: Math.round(s / 0.12) }, (_, i) => f(i % 2 ? "dog-wag-2" : "dog-wag-1", 0.12));
/** A hind leg at an ear: it jiggles. */
const scratching = (s: number): Frame[] => Array.from({ length: Math.round(s / 0.08) }, (_, i) => f("dog-scratch", 0.08, { grow: i % 2 ? -1 : 0 }));

const ACTS: Record<Act, readonly Frame[]> = {
  wake: [f("dog-lie", 0.35), f("dog-awake", 0.15), ...wagging(1.2)],
  wag: [...wagging(1.4), f("dog-awake", 0.2)],
  bark: [f("dog-awake", 0.05, { grow: -1 }), f("dog-bark", 0.2), f("dog-awake", 0.12), f("dog-bark", 0.25), f("dog-awake", 0.3)],
  jump: [
    f("dog-awake", 0.08, { grow: -1 }),
    ...[2, 4, 5, 5, 4, 2].map((lift) => f("dog-jump", 0.06, { lift })),
    f("dog-awake", 0.08, { grow: -1 }),
    f("dog-awake", 0.3),
  ],
  belly: [
    f("dog-lie", 0.2),
    f("dog-belly", 0.5),
    f("dog-belly", 0.12, { grow: 1 }),
    f("dog-belly", 0.5),
    f("dog-belly", 0.12, { grow: 1 }),
    f("dog-belly", 0.7),
    f("dog-lie", 0.3),
  ],
  stir: [f("dog-lie", 1.2), f("dog-yawn", 0.9), f("dog-lie", 0.9)],
  stretch: [f("dog-lie", 0.4), f("dog-stretch", 1.3), f("dog-awake", 0.4), ...scratching(0.9), f("dog-awake", 0.4), f("dog-lie", 0.6)],
  scratch: [...scratching(1), f("dog-awake", 0.2)],
  settle: [f("dog-yawn", 0.8), f("dog-lie", 1)],
  yawn: [f("dog-yawn", 0.9), f("dog-awake", 0.3)],
  rest: [f("dog-lie", 4)],
  look: [f("dog-stand", 2.4)],
};

/** What it does now and then while it sits up, and how often each, of every ten. */
const SITTING: readonly (readonly [Act, number])[] = [
  ["wag", 4],
  ["scratch", 2],
  ["yawn", 1],
  ["rest", 2],
  ["look", 1],
];

const pick = (r: number): Act => {
  let left = r * 10;
  for (const [act, n] of SITTING) {
    if (left < n) return act;
    left -= n;
  }
  return "wag";
};

/** The tricks a pat gets, in turn, once it is awake. */
const TRICKS: readonly Trick[] = ["wag", "bark", "jump", "belly"];
/** How long it stays up after a pat, seconds. */
const AWAKE_S = 7;
/** Pats this close together count as quick ones; this many and it rolls over. */
const QUICK_S = 2.5;
const QUICK_PATS = 3;

export function villageDog(random: () => number = Math.random): Dog {
  const every = cadence(random);
  let act: { name: Act; at: number } | null = null;
  /** Sitting up: after a pat or with you on a call, until it settles again. */
  let up = false;
  let upUntil = -Infinity;
  let pointed = false;
  let pressed = false;
  let turn = 0;
  const pats: number[] = [];

  const frameOf = (name: Act, since: number): Frame | null => {
    let left = since;
    for (const frame of ACTS[name]) {
      if (left < frame.s) return frame;
      left -= frame.s;
    }
    return null;
  };
  const show = (picture: DogPicture, lift = 0, grow = 0): DogLook => ({ picture, lift, grow: pressed ? -1 : grow });

  return {
    look: (t, listening) => {
      if (act) {
        const frame = frameOf(act.name, t - act.at);
        if (frame) return show(frame.picture, frame.lift, frame.grow);
        act = null;
      }
      if (listening || t < upUntil) {
        up = true;
        if (every.due("awake", 6, t)) act = { name: pick(random()), at: t };
        // Pointed at, it is pleased you are there.
        return pointed ? show(t % 0.24 < 0.12 ? "dog-wag-1" : "dog-wag-2") : show("dog-awake");
      }
      if (up) {
        up = false;
        act = { name: "settle", at: t };
        return show("dog-yawn");
      }
      if (every.due("stir", 40, t)) act = { name: random() < 0.6 ? "stir" : "stretch", at: t };
      // Pointed at, it lifts its head; asleep, it breathes.
      return pointed ? show("dog-lie") : show("dog-sleep", 0, Math.floor(t / 1.6) % 2);
    },
    pet: (t) => {
      pats.push(t);
      while (pats.length && t - (pats[0] ?? t) > QUICK_S) pats.shift();
      const asleep = !up;
      upUntil = t + AWAKE_S;
      up = true;
      const trick: Trick = asleep ? "wake" : pats.length >= QUICK_PATS ? "belly" : (TRICKS[turn++ % TRICKS.length] ?? "wag");
      if (trick === "belly") pats.length = 0;
      act = { name: trick, at: t };
      return trick;
    },
    point: (on) => {
      pointed = on;
    },
    press: (on) => {
      pressed = on;
    },
  };
}
