// A runtime drawn as its farm machine, with its maker's badge: the farm's quota bottle and the workbench's runtime lists.

import { Show } from "solid-js";
import { machineOf } from "../../features/runtime/quota";
import { RuntimeBadge } from "../RuntimeBadge";
import { SpriteIcon } from "./icons";

export function RuntimeIcon(props: { runtime: string; size: number }) {
  return (
    <span class="relative inline-block shrink-0" style={{ width: `${props.size}px`, height: `${props.size}px` }}>
      <Show when={machineOf(props.runtime)} fallback={<span class="block h-full w-full bg-cream-200" />}>
        {(machine) => <SpriteIcon name={machine()} size={props.size} />}
      </Show>
      <RuntimeBadge runtime={props.runtime} size={Math.max(10, Math.round(props.size * 0.46))} />
    </span>
  );
}
