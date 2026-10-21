// Faces cut from the pixel drawings (public/pixel/sprites.json): a helper's head from its standing drawing, the manager's
// from its own.

import { useQuery } from "@tanstack/react-query";
import { type Look, SpeciesValues } from "@vibevalley/protocol";

type Manifest = Record<string, { w: number; h: number; ax?: number; ay?: number }>;

export function useSprites() {
  return useQuery({
    queryKey: ["sprites"],
    queryFn: async () => (await (await fetch("/pixel/sprites.json")).json()) as Manifest,
    staleTime: Infinity,
  });
}

// JavaScript's charCodeAt over the code points, as the server picks an animal for a profile without one (and
// rules/cast.ts): they must agree.
function hash(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/** The sprite prefix of a profile's animal and outfit, as far as the drawings go. */
export function castPrefix(look: Look | undefined, agentId: string, has: (name: string) => boolean) {
  const species = look?.species ?? SpeciesValues[hash(agentId) % SpeciesValues.length]!;
  const outfit = look?.outfit ?? "farmer";
  return [`${species}-${outfit}`, `${species}-farmer`, "bear-farmer"].find((p) => has(`${p}-down`)) ?? "bear-farmer";
}

/** A helper's head: its standing drawing, cropped to the head, on a leaf green ground. */
export function AgentFace({ agentId, look, size = 24, muted = false }: { agentId: string; look?: Look; size?: number; muted?: boolean }) {
  const sprites = useSprites().data;
  if (!sprites) return <span className="inline-block shrink-0" style={{ width: size, height: size }} />;
  const name = `${castPrefix(look, agentId, (n) => n in sprites)}-down`;
  const sp = sprites[name] ?? sprites["bear-farmer-down"]!;
  const k = size / (sp.h * 0.5);
  const cx = sp.w / 2;
  const cy = sp.h * 0.25 + sp.h * 0.03;
  return (
    <span
      className={`relative inline-block shrink-0 overflow-hidden rounded-sm bg-[#b4cb7c99] ${muted ? "opacity-60 grayscale" : ""}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <img
        src={`/pixel/${name}.png`}
        alt=""
        draggable={false}
        className="absolute max-w-none [image-rendering:pixelated]"
        style={{ left: size / 2 - cx * k, top: size / 2 - cy * k, width: sp.w * k, height: sp.h * k }}
      />
    </span>
  );
}

/** The manager's head (manager-<look>-face; the farmer's until looks are picked here). */
export function ManagerFace({ size = 24, look = "farmer" }: { size?: number; look?: string }) {
  const sprites = useSprites().data;
  if (!sprites) return <span className="inline-block shrink-0" style={{ width: size, height: size }} />;
  const name = `manager-${look}-face` in sprites ? `manager-${look}-face` : "manager-face";
  const sp = sprites[name]!;
  const k = size / (sp.w * 0.86);
  return (
    <span className="relative inline-block shrink-0 overflow-hidden rounded-sm bg-[#cfe6f5]" style={{ width: size, height: size }} aria-hidden>
      <img
        src={`/pixel/${name}.png`}
        alt=""
        draggable={false}
        className="absolute max-w-none [image-rendering:pixelated]"
        style={{ left: (size - sp.w * k) / 2, top: size * 0.04, width: sp.w * k, height: sp.h * k }}
      />
    </span>
  );
}

/** The owner: 主 in a wheat square. */
export function OwnerFace({ size = 24 }: { size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-sm bg-wheat text-xs font-semibold text-ink"
      style={{ width: size, height: size }}
      aria-hidden
    >
      主
    </span>
  );
}
