/**
 * The workbench's design tokens as its classes may name them (docs/style/design.md): what a class string writes off the
 * ladders. scripts/oxlint-plugin.ts's design-tokens rule reports each; the pixel skin and the avatars are drawn and keep
 * their own values (vite.config.ts says where the rule runs).
 */

/** A token kind, as the rule's message names what to use instead. */
export type TokenKind = "radius" | "type" | "motion" | "layer" | "disabled" | "shadow";

/** The durations on the ladder: 120 under the pointer, 180 the default, 280 a panel or a dialog; 0 is none. */
const durations = new Set([0, 120, 180, 280]);
/** The layers: 10 lies on content, 20 a panel over a page, 30 a menu, a popover or a tip, 40 a toast. */
const layers = new Set([0, 10, 20, 30, 40]);

// A class starts the string, follows a space, or follows a variant (hover:, md:, aria-[…]:).
const start = String.raw`(?:^|[\s:])`;
const checks: readonly { readonly kind: TokenKind; readonly pattern: RegExp; readonly off?: (m: RegExpExecArray) => boolean }[] = [
  { kind: "radius", pattern: new RegExp(`${start}rounded(?:-[a-z]+)?-\\[`, "g") },
  { kind: "type", pattern: new RegExp(`${start}text-\\[\\d`, "g") },
  { kind: "motion", pattern: new RegExp(`${start}(?:ease|duration|delay)-\\[`, "g") },
  { kind: "motion", pattern: new RegExp(`${start}duration-(\\d+)\\b`, "g"), off: (m) => !durations.has(Number(m[1])) },
  { kind: "layer", pattern: new RegExp(`${start}-?z-(\\d+)\\b`, "g"), off: (m) => !layers.has(Number(m[1])) },
  { kind: "layer", pattern: new RegExp(`${start}z-\\[`, "g") },
  { kind: "disabled", pattern: new RegExp(`${start}disabled:opacity-(\\d+)\\b`, "g"), off: (m) => m[1] !== "50" },
  // A shadow of its own is drawn with the palette's variables (an inset accent line), never a colour written in.
  { kind: "shadow", pattern: new RegExp(`${start}shadow-\\[([^\\]]*)\\]`, "g"), off: (m) => !m[1]!.includes("var(") },
];

/** Each token a class string writes off its ladder, in order. */
export function offTokens(classes: string): TokenKind[] {
  const found: { at: number; kind: TokenKind }[] = [];
  for (const c of checks) {
    c.pattern.lastIndex = 0;
    for (let m = c.pattern.exec(classes); m; m = c.pattern.exec(classes)) if (!c.off || c.off(m)) found.push({ at: m.index, kind: c.kind });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.kind);
}

/** What to write instead, by kind. */
export const tokenAdvice: Record<TokenKind, string> = {
  radius: "a corner on the ladder: rounded-xs (a mark in a line), rounded-md (a control), rounded-lg (a card, a panel, a dialog), rounded-xl, rounded-full",
  type: "a size on the ladder: text-2xs (counts, badges, key caps), text-xs, text-sm, text-base, text-lg, text-xl",
  motion: "the motion tokens: duration-120 (hover, press), the default 180, duration-280 (panels, dialogs); ease-out, ease-in, ease-in-out, ease-spring",
  layer: "a layer: z-10 (on content), z-20 (a panel over the page), z-30 (a menu, a popover, a tip), z-40 (a toast)",
  disabled: "disabled:opacity-50, the one disabled look",
  shadow: "shadow-raise (on its surface) or shadow-float (over the page); a shadow of its own uses the palette's variables",
};

/** A colour written into a class anywhere inside its brackets (bg-[#e3efd2], shadow-[0_1px_2px_#2f1f1326]). */
export const hexClass = /-\[[^\]]*#[0-9a-fA-F]{3,8}\b[^\]]*\]/;
