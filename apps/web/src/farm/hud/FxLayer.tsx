import { createEffect, createSignal, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { GameEffect, GameEffectAchievement } from "@vibevalley/protocol";

import { localEffects, rawFarmFrame } from "#/farm/frames.ts";
import { useVillage } from "#/farm/world/load.ts";
import { subscribeLive } from "#/infra/frame.ts";
import { EarnedMedal, noticeTitle, type ToastData, ToastViewport, toasts, ToastType } from "#/ui/pixel/index.ts";

import { clearingLevels } from "./readout";

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
            class="pointer-events-none absolute inset-x-0 top-24 flex justify-center"
            role="status"
            data-testid="level-up"
            data-level={b.level}
            aria-label={t("web.farm.fx.levelUp", { level: b.level })}
          >
            <div class="flex flex-col items-center bg-cream-50 px-7 pt-0 pb-4 shadow-px motion-safe:[animation-name:level-up] motion-safe:[animation-duration:3400ms] motion-safe:[animation-timing-function:cubic-bezier(.2,.9,.2,1)] motion-safe:[animation-fill-mode:forwards]">
              <span class="flex h-5 w-14 items-end justify-center overflow-visible">
                <Show when={loaded().village?.atlas.has("icon-star")}>
                  <img src="/pixel/icon-star.png" alt="" class="-mt-9 mb-0 h-14 w-14 shrink-0 [image-rendering:pixelated]" />
                </Show>
              </span>
              <span class="mt-0.5 text-(length:--text-xs) tracking-[.3px] text-leaf-700">LEVEL UP</span>
              <span class="text-(length:--text-2xl) text-bark-900">{t("web.farm.fx.level", { level: b.level })}</span>
              <Show when={clearingLevels.has(b.level)}>
                <span class="mt-0.5 text-(length:--text-xs) text-bark-600">{t("web.farm.fx.cleared")}</span>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </>
  );
}
