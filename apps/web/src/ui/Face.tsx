// Faces cut from the pixel drawings (public/pixel/sprites.json).

import { Show } from "solid-js";
import type { Look } from "@vibevalley/protocol";
import { castPrefix } from "../rules/cast";
import { ready, useSprites } from "../data/query";

/** A helper's head: its attention drawing, cropped to the head, on a leaf green ground. */
export function AgentFace(props: { agentId: string; look?: Look; size?: number; muted?: boolean }) {
  const sprites = useSprites();
  const size = () => props.size ?? 24;
  const cut = () => {
    const all = ready(sprites, undefined);
    if (!all) return undefined;
    const name = `${castPrefix(props.look, props.agentId, (n) => n in all)}-down`;
    const sp = all[name] ?? all["bear-farmer-down"]!;
    const k = size() / (sp.h * 0.5);
    const cx = sp.w / 2;
    const cy = sp.h * 0.25 + sp.h * 0.03;
    return { name, left: size() / 2 - cx * k, top: size() / 2 - cy * k, width: sp.w * k, height: sp.h * k };
  };
  return (
    <span
      class={["relative inline-block shrink-0 overflow-hidden rounded-sm bg-[#b4cb7c99]", { "opacity-60 grayscale": !!props.muted }]}
      style={{ width: `${size()}px`, height: `${size()}px` }}
      aria-hidden="true"
    >
      <Show when={cut()}>
        {(c) => (
          <img
            src={`/pixel/${c().name}.png`}
            alt=""
            draggable="false"
            class="absolute max-w-none [image-rendering:pixelated]"
            style={{ left: `${c().left}px`, top: `${c().top}px`, width: `${c().width}px`, height: `${c().height}px` }}
          />
        )}
      </Show>
    </span>
  );
}

/** The orchestrator's head (orchestrator-<look>-face; the farmer's until looks are picked). */
export function OrchestratorFace(props: { size?: number; look?: string }) {
  const sprites = useSprites();
  const size = () => props.size ?? 24;
  const cut = () => {
    const all = ready(sprites, undefined);
    if (!all) return undefined;
    const look = props.look ?? "farmer";
    const name = `manager-${look}-face` in all ? `manager-${look}-face` : "manager-face";
    const sp = all[name]!;
    const k = size() / (sp.w * 0.86);
    return { name, left: (size() - sp.w * k) / 2, top: size() * 0.04, width: sp.w * k, height: sp.h * k };
  };
  return (
    <span
      class="relative inline-block shrink-0 overflow-hidden rounded-sm bg-[#cfe6f5]"
      style={{ width: `${size()}px`, height: `${size()}px` }}
      aria-hidden="true"
    >
      <Show when={cut()}>
        {(c) => (
          <img
            src={`/pixel/${c().name}.png`}
            alt=""
            draggable="false"
            class="absolute max-w-none [image-rendering:pixelated]"
            style={{ left: `${c().left}px`, top: `${c().top}px`, width: `${c().width}px`, height: `${c().height}px` }}
          />
        )}
      </Show>
    </span>
  );
}

/** The owner: 主 in a wheat square. */
export function OwnerFace(props: { size?: number }) {
  return (
    <span
      class="inline-flex shrink-0 items-center justify-center rounded-sm bg-wheat text-xs font-semibold text-ink"
      style={{ width: `${props.size ?? 24}px`, height: `${props.size ?? 24}px` }}
      aria-hidden="true"
    >
      主
    </span>
  );
}
