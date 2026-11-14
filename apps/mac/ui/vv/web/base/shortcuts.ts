/** Where a shortcut works, as the sheet groups them. */
type ShortcutPlace = "everywhere" | "composer" | "lists" | "issues" | "pictures" | "library" | "farm" | "desktop";

export const shortcutPlaces: readonly ShortcutPlace[] = ["everywhere", "composer", "lists", "issues", "pictures", "library", "farm", "desktop"];

/** A key as the sheet shows it. */
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
  { id: "command", place: "composer", keys: ["/"] },
  { id: "editLast", place: "composer", keys: ["up"] },
  { id: "dropReply", place: "composer", keys: ["esc"] },
  { id: "move", place: "lists", keys: ["up", "down"] },
  { id: "pick", place: "lists", keys: ["enter"] },
  { id: "newIssue", place: "issues", keys: ["C"] },
  { id: "flip", place: "pictures", keys: ["left", "right"] },
  { id: "libraryMove", place: "library", keys: ["left", "right", "up", "down"] },
  { id: "libraryLook", place: "library", keys: ["space"] },
  { id: "libraryRemove", place: "library", keys: ["Delete"] },
  { id: "tool", place: "farm", keys: ["1…6"] },
  { id: "names", place: "farm", keys: ["alt"] },
  { id: "farmMenu", place: "farm", keys: ["esc"] },
  { id: "debug", place: "farm", keys: ["`"] },
  { id: "voice", place: "desktop", keys: ["alt", "shift", "space"] },
] as const satisfies readonly Shortcut[];

const glyphs: Record<string, string> = {
  mod: "⌘",
  shift: "⇧",
  alt: "⌥",
  enter: "↵",
  esc: "Esc",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  space: "Space",
  tab: "Tab",
};

/** A key's cap on the sheet. */
export const keyCap = (key: Key) => glyphs[key] ?? key;
