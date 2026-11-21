import { View } from "nsh";

import { RuntimeBadge } from "../domain/RuntimeBadge";
import { usePixelDir } from "./atlas";
import { SpriteIcon } from "./icons";

export function RuntimeIcon(props: { runtime: string; size: number }) {
  const dir = usePixelDir();
  const machine = () => machines[props.runtime];
  return (
    <View class="shrink-0" style={{ width: props.size, height: props.size }}>
      <If when={machine()} else={<View class="h-full w-full bg-cream-200" />}>
        {(m) => (
          <If
            when={dir()}
            else={<View class="h-full w-full rounded-md" style={{ backgroundColor: `${m().color}40`, borderWidth: 2, borderColor: `${m().color}99` }} />}
          >
            <SpriteIcon name={m().sprite} size={props.size} />
          </If>
        )}
      </If>
      <RuntimeBadge runtime={props.runtime} size={Math.max(10, Math.round(props.size * 0.46))} />
    </View>
  );
}

/** Each runtime's farm machine, and the colour its sprite is mostly painted in; the farm's own agent wears the app's sprout. */
const machines: Record<string, { sprite: string; color: string }> = {
  claude: { sprite: "machine-tractor", color: "#d9774f" },
  codex: { sprite: "machine-watercart", color: "#4f86d9" },
  opencode: { sprite: "machine-wheelbarrow", color: "#a08c70" },
  pi: { sprite: "machine-pump", color: "#2f9d8f" },
  cursor: { sprite: "machine-seeder", color: "#5b6470" },
  grok: { sprite: "machine-windmill", color: "#9580e6" },
  kimi: { sprite: "machine-beehive", color: "#f2b53a" },
  antigravity: { sprite: "machine-lantern", color: "#c79a2e" },
  vibevalley: { sprite: "app-sprout", color: "#45bf8c" },
  dsh: { sprite: "machine-dsh", color: "#8a5cc4" },
};
