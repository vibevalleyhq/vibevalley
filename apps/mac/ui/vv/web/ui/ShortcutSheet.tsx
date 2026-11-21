// Ported from VibeValley apps/web/src/ui/ShortcutSheet.tsx: every shortcut,
// by where it works, drawn from base/shortcuts.ts; `?` outside a text field
// opens it.
import { keymap, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { keyCap, shortcutPlaces, shortcuts } from "../base/shortcuts";
import { Dialog } from "./Dialog";
import { Kbd } from "./layout";

export function ShortcutSheet() {
  const open = signal(false);
  keymap.bind("shift+/", () => open.set(true), { when: "notEditing" });
  return (
    <Dialog open={open()} onClose={() => open.set(false)} title={t("web.base.shortcuts.title")} testid="shortcuts">
      <Shortcuts />
    </Dialog>
  );
}

function Shortcuts() {
  return (
    <View class="gap-4">
      <Each of={shortcutPlaces}>
        {(place, index) => (
          <View
            accessibilityLabel={t(`web.base.shortcuts.place.${place()}`)}
            testID="shortcut-place"
            class={`gap-1 ${index() > 0 ? "border-t border-line pt-3.5" : ""}`}
          >
            <Text class="px-1.5 pb-0.5 text-xs font-semibold text-muted">{t(`web.base.shortcuts.place.${place()}`)}</Text>
            <Each of={shortcuts.filter((s) => s.place === place())}>
              {(s) => (
                <View class="min-h-7 flex-row items-center justify-between gap-4 rounded-sm px-1.5 py-1 transition duration-120 ease-out hover:bg-hover">
                  <Text class="min-w-0 flex-1 text-sm text-ink">{t(`web.base.shortcuts.say.${s().id}`)}</Text>
                  <View class="shrink-0 flex-row items-center justify-end gap-1">
                    <Each of={s().keys}>{(key) => <Kbd size="md">{keyCap(key())}</Kbd>}</Each>
                  </View>
                </View>
              )}
            </Each>
          </View>
        )}
      </Each>
    </View>
  );
}
