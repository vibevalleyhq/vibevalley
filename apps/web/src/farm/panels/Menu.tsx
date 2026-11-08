import * as stylex from "@stylexjs/stylex";
import { For } from "solid-js";

import { t } from "@vibevalley/i18n";

import { muted } from "#/farm/cues.ts";
import { farm } from "#/farm/store.ts";
import { webRoutes, yardPlaces } from "#/farm/world/world.ts";
import { useRouter } from "#/infra/router.ts";
import { FarmSection, PxButton } from "#/ui/pixel/index.ts";

const viewStyles = stylex.create({
  menuDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
  },
  menuDiv2: {
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 2)",
  },
  menuDiv3: {
    display: "grid",
    gridTemplateColumns: "repeat(2,minmax(0,1fr))",
    columnGap: "calc(var(--spacing) * 3)",
    rowGap: "var(--spacing)",
    fontSize: "12px",
    color: "var(--color-bark-800)",
  },
  menuSpan: {
    color: "var(--color-bark-900)",
  },
  menuSpan2: {
    color: "var(--color-bark-500)",
  },
});

const elsewhere = [
  { label: t("web.farm.menu.chat"), to: "/chat" },
  { label: t("web.farm.menu.agents"), to: "/agents" },
  { label: t("web.farm.menu.runtimes"), to: "/runtimes" },
  { label: t("web.farm.menu.skills"), to: "/settings/skills" },
  { label: t("web.farm.menu.connectors"), to: "/settings/chat" },
  { label: t("web.farm.menu.repos"), to: "/repos" },
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
    <div {...stylex.attrs(viewStyles.menuDiv)}>
      <PxButton tone="primary" data-testid="menu-resume" onClick={close}>
        {t("web.farm.menu.resume")}
      </PxButton>
      <PxButton onClick={() => setMuted(!isMuted())}>{isMuted() ? t("web.farm.menu.soundOn") : t("web.farm.menu.soundOff")}</PxButton>
      <FarmSection title={t("web.farm.menu.elsewhere")}>
        <div {...stylex.attrs(viewStyles.menuDiv2)}>
          <For each={elsewhere.filter((p) => webRoutes.includes(p.to))}>{(p) => <PxButton onClick={() => go(p.to)}>{p.label}</PxButton>}</For>
          <PxButton onClick={() => go("/issues")}>{t("web.farm.menu.issues")}</PxButton>
        </div>
      </FarmSection>
      <FarmSection title={t("web.farm.menu.yard")}>
        <div {...stylex.attrs(viewStyles.menuDiv3)}>
          <For each={yardPlaces}>
            {(p) => (
              <span>
                <span {...stylex.attrs(viewStyles.menuSpan)}>{p.label}</span>
                <span {...stylex.attrs(viewStyles.menuSpan2)}> · {p.hint}</span>
              </span>
            )}
          </For>
        </div>
      </FarmSection>
    </div>
  );
}
