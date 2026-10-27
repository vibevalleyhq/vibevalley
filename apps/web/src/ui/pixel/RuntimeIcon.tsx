// A runtime drawn as its farm machine, with its maker's badge: the farm's quota bottle and the workbench's runtime lists.

import { Show } from "solid-js";
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

/** Each runtime's farm machine; the farm's own agent wears the app's sprout. */
const machines: Record<string, string> = {
  claude: "machine-tractor",
  codex: "machine-watercart",
  opencode: "machine-wheelbarrow",
  pi: "machine-pump",
  cursor: "machine-seeder",
  grok: "machine-windmill",
  kimi: "machine-beehive",
  antigravity: "machine-lantern",
  vibevalley: "app-sprout",
  dsh: "machine-dsh",
};

const machineOf = (runtime: string): string | undefined => machines[runtime];
