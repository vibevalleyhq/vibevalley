import { type Accessor, createSignal } from "solid-js";

import { t } from "@vibevalley/i18n";

import { reasonOf } from "#/infra/api.ts";
import { linkIn, useRegistry } from "#/state/atom.ts";

import { toast } from "./toasts";

export interface Act {
  readonly busy: Accessor<boolean>;
  /** The result, or undefined once it was refused and said so. */
  readonly run: <T>(f: () => Promise<T>) => Promise<T | undefined>;
}

/** `say` tells a refusal; the workbench's toast in the error tone unless a skin has its own (ui/pixel's createPixelAct). */
export function createAct(say: (reason: string) => void = (reason) => toast(reason, "bad")): Act {
  const registry = useRegistry();
  // A count, not a flag: of two runs at once, the first to end does not clear the other's busy.
  const [running, setRunning] = createSignal(0);
  return {
    busy: () => running() > 0,
    run: async (f) => {
      if (linkIn(registry) === "lost") {
        say(t("web.base.intent.offline"));
        return undefined;
      }
      setRunning((n) => n + 1);
      try {
        return await f();
      } catch (e) {
        say(reasonOf(e));
        return undefined;
      } finally {
        setRunning((n) => n - 1);
      }
    },
  };
}
