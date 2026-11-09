import { type Accessor, createSignal } from "solid-js";

import { t } from "@vibevalley/i18n";
import { VibeValleyApiError } from "@vibevalley/protocol";

import { faultOf, reasonOf } from "#/infra/api.ts";
import type { Submission } from "#/infra/form.ts";
import { linkIn, useRegistry } from "#/state/atom.ts";

import { toast } from "./toasts";

export interface Act {
  readonly busy: Accessor<boolean>;
  /** The result, or undefined once it was refused and said so. */
  readonly run: <T>(f: () => Promise<T>) => Promise<T | undefined>;
  readonly attempt: <T>(f: () => Promise<T>) => Promise<Submission<T>>;
}

/** `say` tells a refusal; the workbench's toast in the error tone unless a skin has its own (ui/pixel's createPixelAct). */
export function createAct(say: (reason: string) => void = (reason) => toast(reason, "bad")): Act {
  const registry = useRegistry();
  // A count, not a flag: of two runs at once, the first to end does not clear the other's busy.
  const [running, setRunning] = createSignal(0);
  const attempt = async <T>(f: () => Promise<T>): Promise<Submission<T>> => {
    if (linkIn(registry) === "lost") {
      const message = t("web.base.intent.offline");
      say(message);
      return { kind: "rejected", message };
    }
    setRunning((n) => n + 1);
    try {
      return { kind: "accepted", receipt: await f() };
    } catch (error) {
      const message = reasonOf(error);
      say(message);
      const fault = faultOf(error);
      return error instanceof VibeValleyApiError && (error.error !== undefined || [400, 401, 403, 404, 409, 422].includes(error.status))
        ? { kind: "rejected", message: fault.reason }
        : { kind: "unknown", message: t("web.base.form.deliveryUnknown") };
    } finally {
      setRunning((n) => n - 1);
    }
  };
  return {
    busy: () => running() > 0,
    attempt,
    run: async (f) => {
      const result = await attempt(f);
      return result.kind === "accepted" ? result.receipt : undefined;
    },
  };
}
