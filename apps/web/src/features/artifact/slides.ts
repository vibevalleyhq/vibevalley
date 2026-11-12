import { z } from "zod";

export const presenterHref = (deck: { readonly id: string; readonly version: number }) => `/present?artifact=${encodeURIComponent(deck.id)}&v=${deck.version}`;

export function presenterOf(search: string): { readonly id: string; readonly version: number } | undefined {
  const asked = new URLSearchParams(search);
  const id = asked.get("artifact") ?? "";
  const version = Number(asked.get("v"));
  return id !== "" && Number.isInteger(version) && version > 0 ? { id, version } : undefined;
}

export const stepped = (move: { readonly at: number; readonly step: number; readonly pages: number }) =>
  Math.max(0, Math.min(move.pages - 1, move.at + move.step));

export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

const SlidePost = z.object({ page: z.int().min(0).max(10_000) });

export const slidePostOf = (data: unknown): number | undefined => SlidePost.safeParse(data).data?.page;

export const slidesChannelName = (deck: { readonly id: string; readonly version: number }) => `vibevalley-slides:${deck.id}:${deck.version}`;
