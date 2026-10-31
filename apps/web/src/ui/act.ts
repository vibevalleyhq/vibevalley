// One mutation that shows nothing before the server has it (an overlay is an intent's, base/intent.ts): busy while it
// runs, however it ends, and a refusal said in the error tone. While the state stream is lost it is not sent: what it
// changes would not show, and the owner could not tell whether it went in. It sits beside the toasts rather than in
// base/, which comes before ui/ and so cannot say anything.

import { type Accessor, createSignal } from "solid-js";

import { t } from "@vibevalley/i18n";

import { reasonOf } from "@/base/api";
import { linkIn, useRegistry } from "@/base/atom";

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
