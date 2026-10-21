// The Esc menu: go on, back to the title, sounds on or off, the other places, and what can be clicked in the yard.

import { For } from "solid-js";
import { farm } from "../store";
import { webRoutes, yardPlaces } from "../world/places";
import { useRouter } from "../../app/router";
import { FarmSection, PxButton } from "../kit";
import { muted } from "../support";

const elsewhere = [
  { label: "田头（频道）", to: "/chat" },
  { label: "帮工名册", to: "/agents" },
  { label: "农具", to: "/runtimes" },
  { label: "技能书", to: "/settings/skills" },
  { label: "连接器", to: "/settings/connectors" },
  { label: "项目", to: "/projects" },
  { label: "图鉴", to: "/catalog" },
];

export function Menu() {
  const [isMuted, setMuted] = muted();
  const router = useRouter();
  const close = () => farm.menu(false);
  const go = (to: string) => {
    close();
    router.navigate(to);
  };
  return (
    <div class="flex flex-col gap-2">
      <PxButton tone="primary" onClick={close}>
        继续
      </PxButton>
      <PxButton
        onClick={() => {
          close();
          farm.showTitle();
        }}
      >
        回到首页
      </PxButton>
      <PxButton onClick={() => setMuted(!isMuted())}>{isMuted() ? "打开音效" : "关闭音效"}</PxButton>
      <FarmSection title="去别处">
        <div class="flex flex-wrap gap-2">
          <For each={elsewhere.filter((p) => webRoutes.includes(p.to))}>{(p) => <PxButton onClick={() => go(p.to)}>{p.label}</PxButton>}</For>
          <PxButton onClick={() => go("/issues")}>工单</PxButton>
        </div>
      </FarmSection>
      <FarmSection title="院子里能点的">
        <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-bark-800">
          <For each={yardPlaces}>
            {(p) => (
              <span>
                <span class="text-bark-900">{p.label}</span>
                <span class="text-bark-500"> · {p.hint}</span>
              </span>
            )}
          </For>
        </div>
      </FarmSection>
    </div>
  );
}
