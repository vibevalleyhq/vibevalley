import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { RuntimeBadge } from "#/ui/RuntimeBadge.tsx";

import { SpriteIcon } from "./icons";

const viewStyles = stylex.create({
  runtimeIconSpan: {
    position: "relative",
    display: "inline-block",
    flexShrink: "0",
  },
  runtimeIconSpan2: {
    display: "block",
    height: "100%",
    width: "100%",
    backgroundColor: "var(--color-cream-200)",
  },
});

export function RuntimeIcon(props: { runtime: string; size: number }) {
  return (
    <span {...stylex.attrs(viewStyles.runtimeIconSpan)} style={{ width: `${props.size}px`, height: `${props.size}px` }}>
      <Show when={machineOf(props.runtime)} fallback={<span {...stylex.attrs(viewStyles.runtimeIconSpan2)} />}>
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
