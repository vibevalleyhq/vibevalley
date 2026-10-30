// The Esc menu: go on, back to the title, sounds on or off, the other places, and what can be clicked in the yard.

import { For } from "solid-js";

import { t } from "@vibevalley/i18n";

import { useRouter } from "@/base/router";
import { farm } from "@/farm/store";
import { muted } from "@/farm/support";
import { webRoutes, yardPlaces } from "@/farm/world/places";
import { FarmSection, PxButton } from "@/ui/pixel";

const elsewhere = [
  { label: t("web.farm.menu.chat"), to: "/chat" },
  { label: t("web.farm.menu.agents"), to: "/agents" },
  { label: t("web.farm.menu.runtimes"), to: "/runtimes" },
  { label: t("web.farm.menu.skills"), to: "/settings/skills" },
  { label: t("web.farm.menu.connectors"), to: "/settings/chat" },
  { label: t("web.farm.menu.projects"), to: "/projects" },
  { label: t("web.farm.menu.catalog"), to: "/catalog" },
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
      <PxButton tone="primary" data-testid="menu-resume" onClick={close}>
        {t("web.farm.menu.resume")}
      </PxButton>
      <PxButton
        onClick={() => {
          close();
          farm.showTitle();
        }}
      >
        {t("web.farm.menu.home")}
      </PxButton>
      <PxButton onClick={() => setMuted(!isMuted())}>{isMuted() ? t("web.farm.menu.soundOn") : t("web.farm.menu.soundOff")}</PxButton>
      <FarmSection title={t("web.farm.menu.elsewhere")}>
        <div class="flex flex-wrap gap-2">
          <For each={elsewhere.filter((p) => webRoutes.includes(p.to))}>{(p) => <PxButton onClick={() => go(p.to)}>{p.label}</PxButton>}</For>
          <PxButton onClick={() => go("/issues")}>{t("web.farm.menu.issues")}</PxButton>
        </div>
      </FarmSection>
      <FarmSection title={t("web.farm.menu.yard")}>
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
