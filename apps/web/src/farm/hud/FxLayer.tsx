import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { GameEffect, GameEffectAchievement } from "@vibevalley/protocol";

import { localEffects, rawFarmFrame } from "#/farm/frames.ts";
import { useVillage } from "#/farm/world/load.ts";
import { subscribeLive } from "#/infra/frame.ts";
import { EarnedMedal, noticeTitle, type ToastData, ToastViewport, toasts, ToastType } from "#/ui/pixel/index.ts";

import { clearingLevels } from "./readout";

const viewStyles = stylex.create({
  levelUp: {
    pointerEvents: "none",
    position: "absolute",
    insetInline: "0",
    top: "calc(var(--spacing) * 24)",
    display: "flex",
    justifyContent: "center",
  },
  fxLayerSpan: {
    display: "flex",
    height: "calc(var(--spacing) * 5)",
    width: "calc(var(--spacing) * 14)",
    alignItems: "flex-end",
    justifyContent: "center",
    overflow: "visible",
  },
  fxLayerImg: {
    marginBottom: "0",
    height: "calc(var(--spacing) * 14)",
    width: "calc(var(--spacing) * 14)",
    flexShrink: "0",
    imageRendering: "pixelated",
  },
  fxLayerSpan2: {
    marginTop: "calc(var(--spacing) * .5)",
    fontSize: "12px",
    letterSpacing: ".3px",
    color: "var(--color-leaf-700)",
  },
  fxLayerSpan3: {
    fontSize: "24px",
    color: "var(--color-bark-900)",
  },
  fxLayerSpan4: {
    marginTop: "calc(var(--spacing) * .5)",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
});

const bannerMs = 3400;

export function FxLayer() {
  // The frames as sent: each new frame's effects play once.
  const raw = rawFarmFrame();
  const loaded = useVillage();
  const [banner, setBanner] = createSignal<{ id: number; level: number }>();

  const earned = new Map<number, GameEffectAchievement>();
  const show = (f: GameEffect) => {
    if (f.kind === "levelUp") setBanner({ id: Date.now(), level: Math.round(f.level) });
    if (f.kind === "achievement")
      // The words are the server's (the effect carries them).
      earned.set(
        toasts.add({
          type: ToastType.achievement,
          title: f.title,
          description: t("web.farm.fx.coins", { detail: f.detail, coins: Math.round(f.coins) }),
          timeout: 5000,
        }),
        f,
      );
  };

  createEffect(raw, (frame) => {
    if (frame) for (const f of frame.effects) show(f);
  });

  onSettled(() => localEffects.subscribe(show));

  createEffect(banner, (b) => {
    if (!b) return;
    const t = setTimeout(() => setBanner((now) => (now?.id === b.id ? undefined : now)), bannerMs);
    return () => clearTimeout(t);
  });

  onSettled(() =>
    subscribeLive((e) => {
      if (e.type !== "notice") return;
      toasts.add({ type: e.level, title: noticeTitle[e.level] ?? t("web.farm.fx.notice"), description: e.text, timeout: e.level === "error" ? 7000 : 4500 });
    }),
  );

  const leading = (toast: ToastData) => {
    const data = earned.get(toast.id);
    const village = loaded().village;
    if (!data || !village) return undefined;
    return <EarnedMedal atlas={village.atlas} achievement={data.achievement} tier={Math.round(data.tier)} oneOff={data.oneOff} />;
  };

  return (
    <>
      <ToastViewport leading={leading} kicker={(t) => earned.get(t.id)?.reached} />
      <Show when={banner()} keyed>
        {(b) => (
          <div
            {...stylex.attrs(viewStyles.levelUp)}
            role="status"
            data-testid="level-up"
            data-level={b.level}
            aria-label={t("web.farm.fx.levelUp", { level: b.level })}
          >
            <div class="flex flex-col items-center bg-cream-50 px-7 pt-0 pb-4 shadow-px motion-safe:animate-[level-up_3.4s_cubic-bezier(0.2,0.9,0.2,1)_forwards]">
              <span {...stylex.attrs(viewStyles.fxLayerSpan)}>
                <Show when={loaded().village?.atlas.has("icon-star")}>
                  <img src="/pixel/icon-star.png" alt="" {...stylex.attrs(viewStyles.fxLayerImg)} style={{ "margin-top": "-36px" }} />
                </Show>
              </span>
              <span {...stylex.attrs(viewStyles.fxLayerSpan2)}>LEVEL UP</span>
              <span {...stylex.attrs(viewStyles.fxLayerSpan3)}>{t("web.farm.fx.level", { level: b.level })}</span>
              <Show when={clearingLevels.has(b.level)}>
                <span {...stylex.attrs(viewStyles.fxLayerSpan4)}>{t("web.farm.fx.cleared")}</span>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </>
  );
}
