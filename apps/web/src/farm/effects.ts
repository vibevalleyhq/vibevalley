// Effects made on this page, not by the server: the debug console's level-up and achievement, which earn nothing.

import type { GameEffect } from "@vibevalley/protocol";

const listeners = new Set<(e: GameEffect) => void>();

export const localEffects = {
  add: (e: GameEffect) => {
    for (const f of listeners) f(e);
  },
  subscribe: (f: (e: GameEffect) => void) => {
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  },
};
