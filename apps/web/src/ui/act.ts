// One mutation that shows nothing before the server has it (an overlay is an intent's, base/intent.ts): busy while it
// runs, however it ends, and a refusal said in the error tone. It sits beside the toasts rather than in base/, which
// comes before ui/ and so cannot say anything.

import { type Accessor, createSignal } from "solid-js";

import { reasonOf } from "@/base/api";

import { toast } from "./toasts";

export interface Act {
  readonly busy: Accessor<boolean>;
  /** The result, or undefined once it was refused and said so. */
  readonly run: <T>(f: () => Promise<T>) => Promise<T | undefined>;
}

export function createAct(): Act {
  const [busy, setBusy] = createSignal(false);
  return {
    busy,
    run: async (f) => {
      setBusy(true);
      try {
        return await f();
      } catch (e) {
        toast(reasonOf(e), "bad");
        return undefined;
      } finally {
        setBusy(false);
      }
    },
  };
}
