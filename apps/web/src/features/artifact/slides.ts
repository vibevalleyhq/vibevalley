import { Option, Schema, String as Str } from "effect";

/** Where a deck's speaker's window is opened: its own page, outside the workbench's frame. */
export const presenterHref = (deck: { readonly id: string; readonly version: number }) => `/present?artifact=${encodeURIComponent(deck.id)}&v=${deck.version}`;

/** The deck and version a presenter's address names; undefined when it names none. */
export function presenterOf(search: string): { readonly id: string; readonly version: number } | undefined {
  const asked = new URLSearchParams(search);
  const id = asked.get("artifact") ?? "";
  const version = Number(asked.get("v"));
  return id !== "" && Number.isInteger(version) && version > 0 ? { id, version } : undefined;
}

/** The slide one step away, kept within the deck. */
export const stepped = (move: { readonly at: number; readonly step: number; readonly pages: number }) =>
  Math.max(0, Math.min(move.pages - 1, move.at + move.step));

/** Time since the talk started, as m:ss (h:mm:ss past an hour). */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => Str.padStart(2, "0")(String(n));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

// The workbench's tab and the speaker's window show the same deck: whichever moves, the other follows. Same origin, so
// a BroadcastChannel carries it; what comes in is still checked, as any message is.
const SlidePost = Schema.Struct({ page: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })) });
const decodeSlidePost = Schema.decodeUnknownOption(SlidePost);

/** The slide another window of the same deck moved to; undefined for anything else. */
export const slidePostOf = (data: unknown): number | undefined => Option.getOrUndefined(decodeSlidePost(data))?.page;

export const slidesChannelName = (deck: { readonly id: string; readonly version: number }) => `vibevalley-slides:${deck.id}:${deck.version}`;
