import { appWording } from "../app/words";
import { For } from "solid-js";
import { toasts } from "./toasts";
import { createExternal } from "../data/external";

/** Draws the toasts (ui/toasts.ts) at the bottom of the page. */
export function ToastHost() {
  const shown = createExternal(toasts.subscribe, toasts.get);
  return (
    <div class="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2" role="log" aria-label={appWording().toasts}>
      <For each={shown()}>
        {(t) => <div class={["rounded-md px-3 py-1.5 text-sm text-page shadow-float", t.tone === "bad" ? "bg-berry" : "bg-ink"]}>{t.text}</div>}
      </For>
    </div>
  );
}
