// The Esc menu: go on, back to the title, sounds on or off, the other places, and what can be clicked in the yard.

import { farmWording } from "../words";
import { For } from "solid-js";
import { farm } from "../store";
import { webRoutes, yardPlaces } from "../world/places";
import { useRouter } from "../../base/router";
import { FarmSection, PxButton } from "../kit";
import { muted } from "../support";

const elsewhere = [
  { label: farmWording().menu.chat, to: "/chat" },
  { label: farmWording().menu.agents, to: "/agents" },
  { label: farmWording().menu.runtimes, to: "/runtimes" },
  { label: farmWording().menu.skills, to: "/settings/skills" },
  { label: farmWording().menu.connectors, to: "/settings/connectors" },
  { label: farmWording().menu.projects, to: "/projects" },
  { label: farmWording().menu.catalog, to: "/catalog" },
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
        {farmWording().menu.resume}
      </PxButton>
      <PxButton
        onClick={() => {
          close();
          farm.showTitle();
        }}
      >
        {farmWording().menu.home}
      </PxButton>
      <PxButton onClick={() => setMuted(!isMuted())}>{isMuted() ? farmWording().menu.soundOn : farmWording().menu.soundOff}</PxButton>
      <FarmSection title={farmWording().menu.elsewhere}>
        <div class="flex flex-wrap gap-2">
          <For each={elsewhere.filter((p) => webRoutes.includes(p.to))}>{(p) => <PxButton onClick={() => go(p.to)}>{p.label}</PxButton>}</For>
          <PxButton onClick={() => go("/issues")}>{farmWording().menu.issues}</PxButton>
        </div>
      </FarmSection>
      <FarmSection title={farmWording().menu.yard}>
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
