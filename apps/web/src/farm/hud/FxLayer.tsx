// The farm's effects over the page: a level-up banner, an achievement toast with its medal,
// and the server's notices (the live stream) as toasts. Rewards and penalties are drawn on the plots (canvas fx.ts,
// Overlay.tsx).

import { useEffect, useRef, useState } from "react";
import type { GameEffect, GameEffectAchievement, StateFrame } from "@vibevalley/protocol";
import { useFrames } from "../../data/frame";
import { useLive } from "../../data/live";
import { EarnedMedal, noticeTitle, type ToastData, ToastViewport, toasts, ToastType } from "../kit";
import { localEffects } from "../effects";
import { useVillage } from "../world/load";
import { clearingLevels } from "./rules";

const bannerMs = 3400;

export function FxLayer() {
  const { frame } = useFrames();
  const { village } = useVillage();
  const [banner, setBanner] = useState<{ id: number; level: number }>();
  const seen = useRef(new WeakSet<StateFrame>());

  const show = (f: GameEffect) => {
    if (f.kind === "levelUp") setBanner({ id: Date.now(), level: Math.round(f.level) });
    if (f.kind === "achievement")
      // The words are the server's (the effect carries them).
      toasts.add({ type: ToastType.achievement, title: f.title, description: `${f.detail} · +${Math.round(f.coins)} 金币`, timeout: 5000, data: f });
  };

  useEffect(() => {
    if (!frame || seen.current.has(frame)) return;
    seen.current.add(frame);
    for (const f of frame.effects) show(f);
  }, [frame]);

  useEffect(() => localEffects.subscribe(show), []);

  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner((b) => (b?.id === banner.id ? undefined : b)), bannerMs);
    return () => clearTimeout(t);
  }, [banner]);

  useLive((e) => {
    if (e.type !== "notice") return;
    toasts.add({ type: e.level, title: noticeTitle[e.level] ?? "提示", description: e.text, timeout: e.level === "error" ? 7000 : 4500 });
  });

  const leading = (toast: ToastData) => {
    const data = toast.data as GameEffectAchievement | undefined;
    if (toast.type !== ToastType.achievement || data?.kind !== "achievement" || !village) return null;
    return <EarnedMedal atlas={village.atlas} achievement={data.achievement} tier={Math.round(data.tier)} oneOff={data.oneOff ?? false} />;
  };

  return (
    <>
      <ToastViewport
        leading={leading}
        kicker={(t) => (t.type === ToastType.achievement ? (t.data as GameEffectAchievement | undefined)?.reached : undefined)}
      />
      {banner && (
        <div className="pointer-events-none absolute inset-x-0 top-24 flex justify-center" role="status" aria-label={`农场升到 Lv.${banner.level}`}>
          <div
            key={banner.id}
            className="flex flex-col items-center bg-cream-50 px-7 pt-0 pb-4 shadow-px motion-safe:animate-[level-up_3.4s_cubic-bezier(0.2,0.9,0.2,1)_forwards]"
          >
            <span className="flex h-5 w-14 items-end justify-center overflow-visible">
              {village?.atlas.has("icon-star") && (
                <img src="/pixel/icon-star.png" alt="" className="mb-[-0px] h-14 w-14 shrink-0 [image-rendering:pixelated]" style={{ marginTop: -36 }} />
              )}
            </span>
            <span className="mt-0.5 text-[12px] tracking-[0.3px] text-leaf-700">LEVEL UP</span>
            <span className="text-[24px] text-bark-900">农场 Lv.{banner.level}</span>
            {clearingLevels.has(banner.level) && <span className="mt-0.5 text-[12px] text-bark-600">开垦了一块新地</span>}
          </div>
        </div>
      )}
    </>
  );
}
