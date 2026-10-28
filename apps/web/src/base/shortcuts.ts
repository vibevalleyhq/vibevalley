// Every keyboard shortcut of the page, in one table: the shortcuts sheet (? anywhere off a text field) is drawn from it,
// and the chords the shell listens for are matched through it, so the sheet and the keys cannot drift apart. Keys handled
// inside one place (a list's arrows, the farm's tools) keep their handlers there; their rows here say what they are.

/** Where a shortcut works, as the sheet groups them. */
export type ShortcutPlace = "everywhere" | "composer" | "lists" | "pictures" | "farm" | "desktop";

export const shortcutPlaces: readonly ShortcutPlace[] = ["everywhere", "composer", "lists", "pictures", "farm", "desktop"];

/** A key as the sheet shows it: mod is ⌘ on a Mac and Ctrl elsewhere. */
export type Key = "mod" | "shift" | "alt" | "enter" | "esc" | "up" | "down" | "left" | "right" | "space" | "tab" | (string & {});

export interface Shortcut {
  readonly id: string;
  readonly place: ShortcutPlace;
  /** Pressed together; alternatives are separate rows. */
  readonly keys: readonly Key[];
}

export const shortcuts = [
  { id: "switcher", place: "everywhere", keys: ["mod", "K"] },
  { id: "sheet", place: "everywhere", keys: ["?"] },
  { id: "close", place: "everywhere", keys: ["esc"] },
  { id: "send", place: "composer", keys: ["enter"] },
  { id: "newline", place: "composer", keys: ["shift", "enter"] },
  { id: "mention", place: "composer", keys: ["@"] },
  { id: "editLast", place: "composer", keys: ["up"] },
  { id: "dropReply", place: "composer", keys: ["esc"] },
  { id: "move", place: "lists", keys: ["up", "down"] },
  { id: "pick", place: "lists", keys: ["enter"] },
  { id: "flip", place: "pictures", keys: ["left", "right"] },
  { id: "tool", place: "farm", keys: ["1…6"] },
  { id: "names", place: "farm", keys: ["alt"] },
  { id: "farmMenu", place: "farm", keys: ["esc"] },
  { id: "debug", place: "farm", keys: ["`"] },
  { id: "voice", place: "desktop", keys: ["alt", "shift", "space"] },
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof shortcuts)[number]["id"];

const mac = () => /Mac|iPhone|iPad/.test(navigator.platform);

const glyphs: Record<string, () => string> = {
  mod: () => (mac() ? "⌘" : "Ctrl"),
  shift: () => "⇧",
  alt: () => (mac() ? "⌥" : "Alt"),
  enter: () => "↵",
  esc: () => "Esc",
  up: () => "↑",
  down: () => "↓",
  left: () => "←",
  right: () => "→",
  space: () => "Space",
  tab: () => "Tab",
};

/** A key's cap on the sheet. */
export const keyCap = (key: Key) => glyphs[key]?.() ?? key;

/** Whether a keydown is one of the shell's chords (mod+K, ?): the rest are each place's own. */
export function pressed(e: KeyboardEvent, id: "switcher" | "sheet") {
  switch (id) {
    case "switcher":
      return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
    case "sheet":
      return e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey;
  }
}
