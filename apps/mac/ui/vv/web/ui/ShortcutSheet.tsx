// Ported from VibeValley apps/web/src/ui/ShortcutSheet.tsx: every shortcut,
// by where it works, drawn from base/shortcuts.ts; `?` outside a text field
// opens it.
import { keymap, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { keyCap, shortcutPlaces, shortcuts } from "../base/shortcuts";
import { Dialog } from "./Dialog";

export function ShortcutSheet() {
  const open = signal(false);
  keymap.bind("shift+/", () => open.set(true), { when: "notEditing" });
  return (
    <Dialog open={open()} onClose={() => open.set(false)} title={t("web.base.shortcuts.title")} testid="shortcuts">
      <Shortcuts />
    </Dialog>
  );
}

function Kbd(props: { children: string }) {
  return (
    <View class="min-w-6 items-center justify-center rounded-xs border border-line bg-hover px-1.5 py-0.5">
      <Text class="font-mono text-2xs text-ink">{props.children}</Text>
    </View>
  );
}

function Shortcuts() {
  return (
    <Scroll class="max-h-120">
      <View class="gap-4">
        <Each of={shortcutPlaces}>
          {(place) => (
            <View accessibilityLabel={t(`web.base.shortcuts.place.${place()}`)} testID="shortcut-place" class="gap-1">
              <Text class="text-xs font-semibold text-muted">{t(`web.base.shortcuts.place.${place()}`)}</Text>
              <Each of={shortcuts.filter((s) => s.place === place())}>
                {(s) => (
                  <View class="flex-row items-center gap-3 py-0.5">
                    <Text class="flex-1 text-sm text-ink">{t(`web.base.shortcuts.say.${s().id}`)}</Text>
                    <View class="shrink-0 flex-row items-center gap-1">
                      <Each of={s().keys}>{(key) => <Kbd>{keyCap(key())}</Kbd>}</Each>
                    </View>
                  </View>
                )}
              </Each>
            </View>
          )}
        </Each>
      </View>
    </Scroll>
  );
}
