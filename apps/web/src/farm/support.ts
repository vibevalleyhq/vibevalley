// The farm page's wiring that is not drawn: the village's pictures, the keys, the phone's calls and pad, the sounds.
// The rules are framework-free in farm/*.ts; these connect them to the page.

import { type FarmSoundInput, farmCues, inTurn } from "./cues";
import { type Accessor, createEffect, createSignal, onSettled } from "solid-js";
import type { StateFrame } from "@vibevalley/protocol";
import { phoneCalls } from "./phone/calls";
import { type PadButton, type PadHandler, padKeys, typingIn } from "./phone/pad";
import { isMuted, playSound, setMuted, subscribeMuted, unlockSound } from "../ui/pixel/sound";
import { farm, farmState, subscribeFarm } from "./store";
import { farmKey, typing } from "./tools";
import { loadVillage, type Village } from "./world/load";
import { createExternal } from "../base/external";

/** The level and the atlas: undefined while loading; `error` when they could not be loaded. */
export function useVillage(): Accessor<{ village?: Village; error?: string }> {
  const [got, setGot] = createSignal<{ village?: Village; error?: string }>({});
  onSettled(() => {
    let live = true;
    loadVillage().then(
      (village) => live && setGot({ village }),
      (e: unknown) => live && setGot({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  });
  return got;
}

/** The farm's keys while it is on screen: the tools by number, Esc's menu, Alt for every name. */
export function farmKeys() {
  onSettled(() => {
    const on = (down: boolean) => (e: KeyboardEvent) => {
      const s = farmState();
      if (s.titleOpen) return;
      const key = farmKey({ key: e.key, down, meta: e.metaKey, control: e.ctrlKey, alt: e.altKey }, typing(), s.overlays.length > 0, s.tool);
      switch (key?.kind) {
        case undefined:
          return;
        case "reveal":
          farm.revealNames(key.down);
          return;
        case "closeTool":
          farm.hold("hand");
          break;
        case "openMenu":
          farm.menu(true);
          break;
        case "pick":
          farm.hold(key.tool);
          break;
      }
      e.preventDefault();
    };
    const down = on(true);
    const up = on(false);
    const blur = () => farm.revealNames(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  });
}

export const phoneState = () => createExternal(phoneCalls.subscribe, phoneCalls.get);

/** Feeds the inbox to the phone while the farm is on screen; putting the phone away stops a ring. */
export function feedPhoneCalls(raw: Accessor<StateFrame | undefined>) {
  onSettled(() => {
    phoneCalls.resume();
    let open = farmState().phoneOpen;
    const off = subscribeFarm(() => {
      const now = farmState().phoneOpen;
      if (open && !now) phoneCalls.putAway();
      open = now;
    });
    return () => {
      off();
      phoneCalls.pause();
    };
  });
  // Each frame brings a new inbox.
  createEffect(
    () => raw()?.inbox,
    (inbox) => {
      if (inbox) phoneCalls.calls(inbox);
    },
  );
}

/** Whether the sounds are off, kept on this machine and followed across tabs. */
export const muted = (): [Accessor<boolean>, (on: boolean) => void] => [createExternal(subscribeMuted, isMuted), setMuted];

/** Plays what changed between one input and the next (ui/pixel/sound.ts farmCues); the first input is the farm as it was. */
export function farmSounds(input: Accessor<FarmSoundInput>) {
  createEffect(input, (next, before) => {
    if (before === undefined || before === next) return;
    for (const cue of farmCues(before, next)) {
      if (cue.hold === undefined) playSound(cue.name);
      else inTurn(cue.name, cue.hold);
    }
  });
  onSettled(() => {
    window.addEventListener("pointerdown", unlockSound, { once: true });
    window.addEventListener("keydown", unlockSound, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlockSound);
      window.removeEventListener("keydown", unlockSound);
    };
  });
}

// The phone's pad: which game has it, and its keys while it does.
let current: PadHandler | undefined;
const padListeners = new Set<() => void>();
const tellPad = () => padListeners.forEach((l) => l());

export const pressPad = (button: PadButton, down: boolean) => current?.(button, down);

/** Whether a game has the pad: the keys under the screen dim when none does. */
export const padListening = () =>
  createExternal(
    (l) => (padListeners.add(l), () => void padListeners.delete(l)),
    () => current !== undefined,
  );

/** Hands the pad and its keys to `handler` while the calling game is mounted. */
export function usePad(handler: PadHandler) {
  onSettled(() => {
    current = handler;
    tellPad();
    const key = (down: boolean) => (e: KeyboardEvent) => {
      const button = padKeys[e.key];
      if (!button || typingIn(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      // A held A, B or up does not repeat (a jump, a slam, a turn per press); held arrows the other ways do.
      if (down && e.repeat && (button === "a" || button === "b" || button === "up")) return;
      handler(button, down);
    };
    const onDown = key(true);
    const onUp = key(false);
    window.addEventListener("keydown", onDown, { capture: true });
    window.addEventListener("keyup", onUp, { capture: true });
    return () => {
      if (current === handler) {
        current = undefined;
        tellPad();
      }
      window.removeEventListener("keydown", onDown, { capture: true });
      window.removeEventListener("keyup", onUp, { capture: true });
    };
  });
}

/** Runs `tick(ms)` every animation frame while `on`, with the milliseconds since the last. */
export function useTicks(on: Accessor<boolean>, tick: (ms: number) => void) {
  createEffect(on, (running) => {
    if (!running) return;
    let last = performance.now();
    let id = requestAnimationFrame(function frame(now) {
      tick(now - last);
      last = now;
      id = requestAnimationFrame(frame);
    });
    return () => cancelAnimationFrame(id);
  });
}

/** A value kept for this page's life: a game in progress and the best score survive putting the phone away. */
export function kept<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  const set = (next: T) => {
    value = next;
    subs.forEach((l) => l());
  };
  const get = () => value;
  const use = (): [Accessor<T>, (next: T) => void] => [createExternal((l) => (subs.add(l), () => void subs.delete(l)), get, { always: true }), set];
  return { get, set, use };
}
