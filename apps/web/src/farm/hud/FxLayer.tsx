// The farm's effects over the page: a level-up banner, an achievement toast with its medal, and the server's notices
// (the live stream) as toasts. Rewards and penalties are drawn on the plots (canvas fx.ts, Overlay.tsx).

import { farmWording } from "../words";
import { createEffect, createSignal, onSettled, Show } from "solid-js";
import type { GameEffect, GameEffectAchievement } from "@vibevalley/protocol";
import { localEffects } from "../effects";
import { clearingLevels } from "./rules";
import { subscribeLive } from "../../data/live";
import { EarnedMedal, noticeTitle, type ToastData, ToastViewport, toasts, ToastType } from "../kit";
import { rawFarmFrame } from "../state";
import { useVillage } from "../support";

const bannerMs = 3400;

export function FxLayer() {
  // The frames as sent: each new frame's effects play once.
  const raw = rawFarmFrame();
  const loaded = useVillage();
  const [banner, setBanner] = createSignal<{ id: number; level: number }>();

  const show = (f: GameEffect) => {
    if (f.kind === "levelUp") setBanner({ id: Date.now(), level: Math.round(f.level) });
    if (f.kind === "achievement")
      // The words are the server's (the effect carries them).
      toasts.add({ type: ToastType.achievement, title: f.title, description: farmWording().fx.coins(f.detail, Math.round(f.coins)), timeout: 5000, data: f });
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
      toasts.add({ type: e.level, title: noticeTitle[e.level] ?? farmWording().fx.notice, description: e.text, timeout: e.level === "error" ? 7000 : 4500 });
    }),
  );

  const leading = (toast: ToastData) => {
    const data = toast.data as GameEffectAchievement | undefined;
    const village = loaded().village;
    if (toast.type !== ToastType.achievement || data?.kind !== "achievement" || !village) return undefined;
    return <EarnedMedal atlas={village.atlas} achievement={data.achievement} tier={Math.round(data.tier)} oneOff={data.oneOff ?? false} />;
  };

  return (
    <>
      <ToastViewport
        leading={leading}
        kicker={(t) => (t.type === ToastType.achievement ? (t.data as GameEffectAchievement | undefined)?.reached : undefined)}
      />
      <Show when={banner()} keyed>
        {(b) => (
          <div class="pointer-events-none absolute inset-x-0 top-24 flex justify-center" role="status" aria-label={farmWording().fx.levelUp(b.level)}>
            <div class="flex flex-col items-center bg-cream-50 px-7 pt-0 pb-4 shadow-px motion-safe:animate-[level-up_3.4s_cubic-bezier(0.2,0.9,0.2,1)_forwards]">
              <span class="flex h-5 w-14 items-end justify-center overflow-visible">
                <Show when={loaded().village?.atlas.has("icon-star")}>
                  <img src="/pixel/icon-star.png" alt="" class="mb-[-0px] h-14 w-14 shrink-0 [image-rendering:pixelated]" style={{ "margin-top": "-36px" }} />
                </Show>
              </span>
              <span class="mt-0.5 text-[12px] tracking-[0.3px] text-leaf-700">LEVEL UP</span>
              <span class="text-[24px] text-bark-900">{farmWording().fx.level(b.level)}</span>
              <Show when={clearingLevels.has(b.level)}>
                <span class="mt-0.5 text-[12px] text-bark-600">{farmWording().fx.cleared}</span>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </>
  );
}
