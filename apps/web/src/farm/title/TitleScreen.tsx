// The title screen over the farm: the farm at the hour it is, slowly moving; the
// game's name; the menu: 开始游戏, 继续游戏 (when there is a farm to go back to), 设置. Arrow keys and Enter work as in a
// game; leaving it, it does not show again on this machine. Without the manager's key 开始游戏 says so in place: the
// workbench pages have no toasts to carry it there.

import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../data/api";
import { useCore } from "../../data/frame";
import { cx } from "../kit";
import { playSound } from "../sound";
import { farm } from "../store";
import { hasFarm, managerReady } from "./rules";
import { startScene } from "./scene";
import { TitleStage } from "./TitleStage";

type Item = "start" | "continue" | "settings";

// Text shadows go inline: the pixel skin turns a class with "shadow" in it into a box's drop.
const deep = { textShadow: "4px 4px 0 #3a2a18" };
const soft = { textShadow: "2px 2px 0 #3a2a18" };

export function TitleScreen() {
  const navigate = useNavigate();
  const canContinue = hasFarm(useCore());
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.setting.load() }).data;
  const items: { id: Item; label: string; enabled: boolean }[] = [
    { id: "start", label: "开始游戏", enabled: true },
    { id: "continue", label: "继续游戏", enabled: canContinue },
    { id: "settings", label: "设置", enabled: true },
  ];
  const [picked, setPicked] = useState<Item>();
  const [note, setNote] = useState<string>();
  const at = picked ?? (canContinue ? "continue" : "start");

  const leaveFor = (path: string) => {
    farm.closeTitle();
    void navigate(path);
  };
  const choose = (item: Item) => {
    playSound("tap");
    switch (item) {
      case "start":
        // The manager cannot think without DeepSeek's key: say so under the menu, where 设置 is.
        if (!managerReady(settings)) return setNote("先填钥匙：管家要 DeepSeek 的 API Key 才能干活，在设置里填上。");
        farm.closeTitle();
        return void api.manager.open().catch(() => {});
      case "continue":
        return canContinue ? farm.closeTitle() : undefined;
      case "settings":
        return leaveFor("/settings");
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const open = items.filter((i) => i.enabled);
      const here = open.findIndex((i) => i.id === at);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = open[(here + (e.key === "ArrowDown" ? 1 : open.length - 1)) % open.length];
        if (next) setPicked(next.id);
        playSound("pick");
      } else if (e.key === "Enter") {
        e.preventDefault();
        choose(at);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="absolute inset-0 z-[60] overflow-hidden bg-[#2a1d2e] font-pixel" role="dialog" aria-label="码农场物语 首页">
      <TitleStage scene={startScene()} />
      <div className="absolute inset-y-0 left-0 w-[min(46rem,70vw)] bg-gradient-to-r from-[#1e1424]/75 via-[#1e1424]/35 to-transparent" />
      <div className="relative flex h-full flex-col justify-center gap-8 overflow-y-auto px-[6vw] py-8 sm:gap-10">
        <header className="title-float">
          <h1 className="text-[clamp(40px,6vw,72px)] leading-none text-cream-50" style={deep}>
            码农场物语
          </h1>
          <p className="mt-3 text-[24px] text-cream-100" style={soft}>
            一群写代码的小动物，等你来派活
          </p>
        </header>
        <nav className="flex w-56 flex-col gap-3" aria-label="开始">
          {items.map((item, i) => {
            const on = at === item.id && item.enabled;
            return (
              <button
                key={item.id}
                type="button"
                disabled={!item.enabled}
                onMouseEnter={() => item.enabled && setPicked(item.id)}
                onClick={() => choose(item.id)}
                style={{ "--delay": `${i * 90}ms`, boxShadow: "2px 2px 0 0 #3a2a1899" } as CSSProperties}
                className={cx(
                  "title-in flex cursor-pointer items-center gap-2 border-2 border-[#3a2a18] px-4 py-2.5 text-left text-[24px] leading-[1.4] text-bark-900 transition-transform duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45",
                  on ? "translate-x-2 bg-[#ffe9a8]" : "bg-[#f3e2b8]",
                )}
              >
                <PickedMark shown={on} />
                {item.label}
              </button>
            );
          })}
          {note && (
            <p role="status" className="bg-[#ffe9a8] px-2 py-1 text-[12px] text-bark-900">
              {note}
            </p>
          )}
          {!canContinue && (
            <p className="px-1 text-[12px] text-cream-100" style={soft}>
              还没有农场可以继续：先开始游戏。
            </p>
          )}
        </nav>
      </div>
    </div>
  );
}

/** The arrow at the picked item: a pixel triangle in berry. */
function PickedMark({ shown }: { shown: boolean }) {
  return (
    <svg width={12} height={18} viewBox="0 0 4 6" shapeRendering="crispEdges" aria-hidden className={cx("mr-1 shrink-0", !shown && "invisible")}>
      <rect x={0} y={0} width={1} height={6} fill="#c84a3a" />
      <rect x={1} y={1} width={1} height={4} fill="#c84a3a" />
      <rect x={2} y={2} width={1} height={2} fill="#c84a3a" />
    </svg>
  );
}
