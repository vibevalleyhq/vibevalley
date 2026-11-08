import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onSettled } from "solid-js";

import { t } from "@vibevalley/i18n";

import { inField, keyCap, pressed, shortcutPlaces, shortcuts } from "#/base/shortcuts.ts";

import { Dialog } from "./Dialog";

const viewStyles = stylex.create({
  kbdKbd: {
    minWidth: "calc(var(--spacing) * 6)",
    borderRadius: "var(--radius-xs)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-hover)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    textAlign: "center",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    lineHeight: "calc(var(--spacing) * 5)",
    color: "var(--color-ink)",
  },
  shortcutsDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 4)",
  },
  shortcutPlace: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing)",
  },
  shortcutsH3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  shortcutsDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  shortcutsSpan: {
    flex: "1",
  },
  shortcutsSpan2: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    gap: "var(--spacing)",
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
