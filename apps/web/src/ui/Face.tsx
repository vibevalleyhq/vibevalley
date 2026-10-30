import { t } from "@vibevalley/i18n";
// Faces cut from the pixel drawings (public/pixel/sprites.json).

import { Show } from "solid-js";
import type { Look } from "@vibevalley/protocol";
import { castPrefix } from "./cast";
import { orchestratorLookOf } from "@/base/agents";
import { ready, useAgents, useSprites } from "@/base/query";
import { RuntimeBadge } from "./RuntimeBadge";

/** A helper's head: its attention drawing, cropped to the head, on a leaf green ground. */
export function AgentFace(props: { agentId: string; runtime?: string | undefined; look?: Look | undefined; size?: number; muted?: boolean | undefined }) {
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
    <span class="relative inline-block shrink-0" style={{ width: `${size()}px`, height: `${size()}px` }}>
      <span
        class={["relative block h-full w-full overflow-hidden rounded-sm bg-[#b4cb7c99]", { "opacity-60 grayscale": !(props.muted !== true) }]}
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
      <Show when={props.runtime}>{(runtime) => <RuntimeBadge runtime={runtime()} size={Math.max(10, Math.min(24, Math.round(size() * 0.4)))} />}</Show>
    </span>
  );
}

/** The orchestrator's head (orchestrator-<look>-face; the farmer's until looks are picked). */
/** An orchestrator's head (the default one when agent is none), in its profile's look unless look is given. */
export function OrchestratorFace(props: { size?: number; agent?: string | undefined; look?: string }) {
  const sprites = useSprites();
  const agents = useAgents();
  const size = () => props.size ?? 24;
  const cut = () => {
    const all = ready(sprites, undefined);
    if (!all) return undefined;
    const look = props.look ?? orchestratorLookOf(ready(agents, []), props.agent);
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
      {t("web.base.owner")}
    </span>
  );
}
