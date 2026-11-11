import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onSettled } from "solid-js";

import { t } from "@vibevalley/i18n";

import { inField, keyCap, pressed, shortcutPlaces, shortcuts } from "#/base/shortcuts.ts";

import { Dialog } from "./Dialog";

const viewStyles = stylex.create({
  kbdKbd: {
    minWidth: "1.5rem",
    borderRadius: "var(--radius-xs)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-hover)",
    paddingInline: "0.375rem",
    textAlign: "center",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    lineHeight: "1.25rem",
    color: "var(--color-ink)",
  },
  shortcutsDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
  },
  shortcutPlace: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  shortcutsH3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  shortcutsDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    paddingBlock: "0.125rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  shortcutsSpan: {
    flex: "1",
  },
  shortcutsSpan2: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    gap: "0.25rem",
  },
});

/** Every shortcut, by where it works, drawn from base/shortcuts.ts: ? off a text field opens it. */
export function ShortcutSheet() {
  const [open, setOpen] = createSignal(false);
  onSettled(() => {
    const key = (e: KeyboardEvent) => {
      // In a field ? is a question mark.
      if (!pressed(e, "sheet") || inField() || document.querySelector("dialog[open]")) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  return (
    <Dialog open={open()} onClose={() => setOpen(false)} title={t("web.base.shortcuts.title")} testid="shortcuts">
      <Shortcuts />
    </Dialog>
  );
}

export function Kbd(props: { children: string }) {
  return <kbd {...stylex.attrs(viewStyles.kbdKbd)}>{props.children}</kbd>;
}

export function Shortcuts() {
  return (
    <div {...stylex.attrs(viewStyles.shortcutsDiv)}>
      <For each={shortcutPlaces}>
        {(place) => (
          <section
            aria-label={t(`web.base.shortcuts.place.${place}`)}
            data-testid="shortcut-place"
            data-key={place}
            {...stylex.attrs(viewStyles.shortcutPlace)}
          >
            <h3 {...stylex.attrs(viewStyles.shortcutsH3)}>{t(`web.base.shortcuts.place.${place}`)}</h3>
            <For each={shortcuts.filter((s) => s.place === place)}>
              {(s) => (
                <div {...stylex.attrs(viewStyles.shortcutsDiv2)}>
                  <span {...stylex.attrs(viewStyles.shortcutsSpan)}>{t(`web.base.shortcuts.say.${s.id}`)}</span>
                  <span {...stylex.attrs(viewStyles.shortcutsSpan2)}>
                    <For each={s.keys}>{(key) => <Kbd>{keyCap(key)}</Kbd>}</For>
                  </span>
                </div>
              )}
            </For>
          </section>
        )}
      </For>
    </div>
  );
}
