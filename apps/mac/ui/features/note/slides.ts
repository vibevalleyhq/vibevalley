export const presenterHref = (note: { readonly id: string; readonly version?: number | undefined }) =>
  `/present?note=${encodeURIComponent(note.id)}${note.version != null && note.version > 0 ? `&v=${note.version}` : ""}`;

export function presenterOf(search: string): { readonly id: string; readonly version: number } | undefined {
  const asked = new URLSearchParams(search);
  const id = asked.get("note") ?? "";
  if (id === "") return undefined;
  const rawV = asked.get("v");
  const version = rawV !== null ? Number(rawV) : 0;
  return { id, version: Number.isInteger(version) && version > 0 ? version : 0 };
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
