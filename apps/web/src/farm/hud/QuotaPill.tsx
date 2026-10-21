// How much the runtimes' accounts have left: a bottle at the HUD's top right, filled
// to the lowest of them; open, each runtime's machine, usage windows, today's spend and a stop it is under.

import { useEffect, useRef, useState } from "react";
import type { AccountUsage, RuntimeInfo } from "@vibevalley/protocol";
import { useRuntimes } from "../../data/runtimes";
import { yuan } from "../../rules/chat";
import { useFarmCommands } from "../commands";
import { CardColors, PxButton, SpriteIcon } from "../kit";
import { HudCard } from "./Hud";
import { bottleSprite, machineOf, quotaLevel, quotaOf, resetText, usableRuntimes, windowLabel } from "./rules";

const levelInk = { plenty: "#3f6427", low: "#b8862a", gold: "#b8862a", empty: "#c84a3a", unknown: "#7f5b3b" } as const;

export function RuntimeIcon({ runtime, size }: { runtime: string; size: number }) {
  const machine = machineOf(runtime);
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      {machine ? <SpriteIcon name={machine} size={size} /> : <span className="block h-full w-full bg-cream-200" />}
      <img
        src={`/pixel/logo-${runtime}.png`}
        alt=""
        onError={(e) => (e.currentTarget.style.display = "none")}
        className="absolute -right-1 -bottom-1 [image-rendering:pixelated]"
        style={{ width: Math.round(size * 0.46), height: Math.round(size * 0.46) }}
      />
    </span>
  );
}

function UsageLines({ usage }: { usage: AccountUsage | null }) {
  if (!usage) return <p className="text-[12px] text-bark-400">不报额度</p>;
  switch (usage.status) {
    case "login_required":
      return <p className="text-[12px] text-[#b8682a]">没登录，额度读不到</p>;
    case "unavailable":
      return <p className="text-[12px] text-bark-400">读不到：{usage.reason}</p>;
    case "balance":
      return (
        <p className="text-[12px]" style={{ color: usage.available ? "#2f1f13" : "#c84a3a" }}>
          按量计费 · {usage.provider} 余额{usage.available ? "" : "，不够用了"}
        </p>
      );
    case "ok":
      return (
        <div className="mt-1 flex flex-col gap-1">
          {usage.windows.map((w) => {
            const left = 100 - w.usedPercent;
            return (
              <div key={w.label} className="text-[12px]">
                <div className="flex justify-between gap-2">
                  <span className="truncate">{windowLabel(w.label)}</span>
                  <span style={{ color: levelInk[quotaLevel(left)] }}>{Math.round(left)}%</span>
                </div>
                <span className="block h-1.5 w-full" style={{ background: CardColors.barTrack }}>
                  <span className="block h-full" style={{ width: `${Math.max(0, Math.min(100, left))}%`, background: levelInk[quotaLevel(left)] }} />
                </span>
                {w.resetsAt !== null && <span className="text-[10px] text-bark-400">{resetText(w.resetsAt)}</span>}
              </div>
            );
          })}
        </div>
      );
  }
}

function Machine({ info }: { info: RuntimeInfo }) {
  const quota = quotaOf(info);
  const usage = info.usage;
  return (
    <div className="flex gap-2.5 border-[1.5px] border-cream-200 bg-cream-100 p-2" data-testid="quota-machine">
      <RuntimeIcon runtime={info.id} size={34} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px]">{info.preset.label}</span>
          {usage?.status === "ok" && usage.subscription && <span className="truncate text-[12px] text-bark-500">{usage.subscription}</span>}
        </div>
        <UsageLines usage={usage} />
        {info.spentToday !== undefined && (
          <p className="mt-0.5 text-[12px] text-bark-500">
            今天花了约 {yuan(info.spentToday)}
            {(info.settings.dailyBudget ?? 0) > 0 ? ` / 预算 ${yuan(info.settings.dailyBudget!)}` : ""}
          </p>
        )}
        {info.stop && <p className="mt-0.5 text-[12px] text-berry">{info.stop}</p>}
      </div>
      <div className="flex w-12 flex-col items-center">
        <SpriteIcon name={bottleSprite(quota)} size={40} label={quota.text} />
        <span className="text-[12px]" style={{ color: quota.level === "unknown" ? "#9b7550" : quota.level === "empty" ? "#c84a3a" : "#46301d" }}>
          {quota.short || "—"}
        </span>
      </div>
    </div>
  );
}

export function QuotaPill({ height }: { height: number }) {
  const runtimes = usableRuntimes(useRuntimes().data ?? []);
  const commands = useFarmCommands();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => box.current?.contains(e.target as Node) || setOpen(false);
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);
  if (runtimes.length === 0) return null;
  const lefts = runtimes.flatMap((r) => (r.quota?.left === undefined ? [] : [r.quota.left]));
  const lowest = lefts.length ? Math.min(...lefts) : undefined;
  const shown = lowest === undefined ? undefined : Math.round(lowest);
  return (
    <div ref={box} className="pointer-events-auto relative">
      <button
        type="button"
        aria-label={shown === undefined ? "各 runtime 的剩余额度" : `剩余额度，最少的还剩 ${shown}%`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="cursor-pointer"
      >
        <HudCard height={height} bright={open}>
          <SpriteIcon name={bottleSprite({ level: quotaLevel(lowest), fill: lowest === undefined ? 0 : lowest / 100, short: "", text: "" })} size={28} />
          <span style={{ color: lowest === undefined ? "#2f1f13" : levelInk[quotaLevel(lowest)] }}>{shown === undefined ? "额度" : `${shown}%`}</span>
        </HudCard>
      </button>
      {open && (
        <div className="absolute top-full right-0 z-10 mt-2 w-[352px] bg-cream-50 p-3 shadow-px" role="dialog" aria-label="剩余额度">
          <div className="flex items-center">
            <span className="flex-1 text-[13px]">剩余额度</span>
            <PxButton size="icon" label="现在读一次额度" onClick={() => runtimes.forEach((r) => void commands.refreshRuntime(r.id).catch(() => {}))}>
              <SpriteIcon name="button-refresh" size={14} />
            </PxButton>
          </div>
          <div className="mt-2 flex max-h-[min(512px,70vh)] flex-col gap-3 overflow-y-auto">
            {runtimes.map((r) => (
              <Machine key={r.id} info={r} />
            ))}
          </div>
          <p className="mt-2 text-[12px] text-bark-400">从各家账户读来，几分钟更新一次；帮工干完一轮也会更新。</p>
        </div>
      )}
    </div>
  );
}
