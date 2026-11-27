import { t } from "@vibevalley/i18n";
import { VibeValleyApiError } from "@vibevalley/protocol";

import { faultOf, reasonOf } from "./api";
import type { Submission } from "./form";
import { type Accessor, createSignal } from "./solid";
import { linkIn, useRegistry } from "./state/atom";

export interface Act {
  readonly busy: Accessor<boolean>;
  /** The result, or undefined once it was refused and said so. */
  readonly run: <T>(f: () => Promise<T>) => Promise<T | undefined>;
  readonly attempt: <T>(f: () => Promise<T>) => Promise<Submission<T>>;
}

let defaultReporter: (reason: string) => void = () => {};

/** Installs the default refusal reporter (wired to `design/toasts` by `app/DesignHost`). */
export function setDefaultActReporter(reporter: (reason: string) => void): void {
  defaultReporter = reporter;
}

/** `say` tells a refusal; defaults to the installed host reporter unless a caller supplies its own. */
export function createAct(say: (reason: string) => void = (reason) => defaultReporter(reason)): Act {
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
      return error instanceof VibeValleyApiError &&
        ((error.tag !== undefined && error.tag !== "InternalError" && error.tag !== "BadGateway") || [400, 401, 403, 404, 409, 422].includes(error.status))
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
