import type { GameEffect, Issue, Session } from "@vibevalley/protocol";

import { playSound, type SoundName } from "@/ui/pixel/sound";

import type { BedFxKind } from "./tools";
const BED_SOUND = { water: "water", spray: "spray", harvest: "harvest", shovel: "shovel", note: "nope" } as const satisfies Record<BedFxKind, SoundName>;

export type CallPhase = "idle" | "connecting" | "live" | "ending";

export interface FarmSoundInput {
  tool: string;
  bedFx: readonly { id: number; kind: BedFxKind }[];
  open: Readonly<Record<string, boolean>>;
  /** One frame's effects: a new array is new effects, the same array is the ones already heard. */
  effects?: readonly GameEffect[];
  /** Absent until the page has the core state; the first state is the farm as it already was. */
  sessions?: readonly Session[];
  /** Where each issue stands (Issue.attention): its plot ripens or gets bugs as it does. */
  issues?: readonly Pick<Issue, "id" | "attention">[];
  call?: { phase: CallPhase; problem?: string };
}

/** `hold`: good news that takes turns with other good news, holding the floor this many ms. */
export interface Cue {
  name: SoundName;
  hold?: number;
}

export function farmCues(prev: FarmSoundInput, next: FarmSoundInput): Cue[] {
  const cues: Cue[] = [];
  if (next.tool !== prev.tool) cues.push({ name: "pick" });
  const seen = new Set(prev.bedFx.map((f) => f.id));
  for (const f of next.bedFx) if (!seen.has(f.id)) cues.push({ name: BED_SOUND[f.kind] });
  for (const [key, value] of Object.entries(next.open)) {
    if ((prev.open[key] ?? false) !== value) cues.push({ name: value ? "open" : "close" });
  }
  if (next.effects && next.effects !== prev.effects) {
    for (const f of next.effects) {
      switch (f.kind) {
        case "reward":
          cues.push({ name: "coin", hold: 300 });
          break;
        case "levelUp":
          cues.push({ name: "levelUp", hold: 700 });
          break;
        case "achievement":
          cues.push({ name: "achievement", hold: 700 });
          break;
        case "penalty":
          break;
        default:
          f satisfies never;
      }
    }
  }
  if (prev.sessions && next.sessions && next.sessions !== prev.sessions) {
    const before = new Set(prev.sessions.map((s) => s.id));
    for (const s of next.sessions) if (!before.has(s.id)) cues.push({ name: "arrive" });
  }
  // Ripe and bug follow where the issue stands, as its plot does: a round handed back with a conflict or a question is
  // neither.
  if (prev.issues && next.issues && next.issues !== prev.issues) {
    const before = new Map(prev.issues.map((t) => [t.id, t.attention]));
    for (const t of next.issues) {
      const was = before.get(t.id);
      if (!was) continue;
      const now = t.attention;
      if (now.state === "reviewing" && was.state !== "reviewing") cues.push({ name: "ripe", hold: 220 });
      else if (now.state === "stuck" && (now.stuck === "failed" || now.stuck === "conflict") && (was.state !== "stuck" || was.stuck !== now.stuck))
        cues.push({ name: "bug" });
    }
  }
  if (prev.call && next.call) {
    const { phase, problem } = next.call;
    const before = prev.call.phase;
    if (problem !== undefined && problem !== prev.call.problem) cues.push({ name: "nope" });
    else if (phase !== before) {
      if (phase === "live") cues.push({ name: "voiceOn" });
      else if (phase === "idle" && (before === "live" || before === "ending")) cues.push({ name: "voiceOff" });
    }
  }
  return cues;
}

// A finished job ripens, pays and may earn an achievement in the same moment, and played together those are one muddy chord: each waits for the
// one before, then holds the floor.
let floorFree = 0;

export function inTurn(name: SoundName, hold: number) {
  const now = Date.now();
  const at = Math.max(now, floorFree);
  floorFree = at + hold;
  if (at === now) playSound(name);
  else setTimeout(() => playSound(name), at - now);
}
