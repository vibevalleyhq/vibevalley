import { t } from "@vibevalley/i18n";
import { createSignal, For, onSettled } from "solid-js";
import { keyCap, pressed, shortcutPlaces, shortcuts } from "../base/shortcuts";
import { Dialog } from "./Dialog";

/** Whether the focus is in a field, whose keys are its own: ? there is a question mark. */
const typing = () => {
  const el = document.activeElement;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
};

/** Every shortcut, by where it works, drawn from base/shortcuts.ts: ? off a text field opens it. */
export function ShortcutSheet() {
  const [open, setOpen] = createSignal(false);
  onSettled(() => {
    const key = (e: KeyboardEvent) => {
      if (!pressed(e, "sheet") || typing() || document.querySelector("dialog[open]")) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  return (
    <Dialog open={open()} onClose={() => setOpen(false)} title={t("web.base.shortcuts.title")} testid="shortcuts">
      <div class="flex flex-col gap-4">
        <For each={shortcutPlaces}>
          {(place) => (
            <section aria-label={t(`web.base.shortcuts.place.${place}`)} data-testid="shortcut-place" data-key={place} class="flex flex-col gap-1">
              <h3 class="text-xs font-semibold text-muted">{t(`web.base.shortcuts.place.${place}`)}</h3>
              <For each={shortcuts.filter((s) => s.place === place)}>
                {(s) => (
                  <div class="flex items-center gap-3 py-0.5 text-sm">
                    <span class="flex-1">{t(`web.base.shortcuts.say.${s.id}`)}</span>
                    <span class="flex shrink-0 items-center gap-1">
                      <For each={s.keys}>
                        {(key) => (
                          <kbd class="min-w-6 rounded-xs border border-line bg-hover px-1.5 text-center font-mono text-2xs leading-5 text-ink">
                            {keyCap(key)}
                          </kbd>
                        )}
                      </For>
                    </span>
                  </div>
                )}
              </For>
            </section>
          )}
        </For>
      </div>
    </Dialog>
  );
}
