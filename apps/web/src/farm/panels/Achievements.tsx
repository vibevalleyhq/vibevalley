// 任务与成就: the farm's level, coins and worn title, the starter tasks, the beds
// cleared by level, each wall of achievements with its medals and how far along it is, and the secrets found. The
// catalogue is the server's (game.achievements), the standings come with the frame (view.achievements).

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Achievement, AchievementCategory, AchievementStanding, Progress } from "@vibevalley/protocol";
import { api } from "../../data/api";
import { useCore, useFrames } from "../../data/frame";
import { numberText, SpriteIcon } from "../kit";
import { fire, useFarmCommands } from "../commands";
import { beds } from "../world/plots";
import { thousands } from "../hud/rules";
import { tint, Tinted } from "./bits";

const walls: AchievementCategory[] = ["harvest", "craft", "thrift", "team"];

const tierText: Record<number, string> = { 1: "铜", 2: "银", 3: "金" };

const categoryText: Record<AchievementCategory, string> = {
  starter: "新手任务",
  harvest: "收成",
  craft: "手艺",
  thrift: "精打细算",
  team: "协作",
  secret: "彩蛋",
};

const pip: Record<number, string> = { 1: "#c07a43", 2: "#a9b4bf", 3: "#e5a93c" };

const emptyProgress: Progress = { coins: 0, streak: 0, bestStreak: 0, counts: {}, unlocked: [] };

const day = (at: number) => {
  const d = new Date(Math.round(at));
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};

/** The tier's name; the achievement's own before the first. */
const tierTitle = (a: Achievement, tier: number) => (tier >= 1 && tier <= a.tiers.length ? a.tiers[tier - 1]!.title : a.title);

const reachedAt = (p: Progress, id: string, tier: number) => p.unlocked.find((u) => u.id === id && u.tier === tier)?.at;

type Standings = (a: Achievement) => { tier: number; count: number; next?: number };

const standingsOf = (list: readonly AchievementStanding[]): Standings => {
  const by = new Map(list.map((s) => [s.id, s]));
  return (a) => {
    const s = by.get(a.id);
    return { tier: Math.round(s?.tier ?? 0), count: Math.round(s?.count ?? 0), next: s?.next === undefined ? undefined : Math.round(s.next) };
  };
};

/** An emblem in its frame: wood before the first tier, then bronze, silver, gold (one tier alone is gold). */
export function Medal({ a, tier, size }: { a: Achievement; tier: number; size: number }) {
  const earned = tier > 0;
  const frameTier = a.tiers.length === 1 ? 3 : tier;
  const frame = !earned ? "medal-wood" : frameTier === 1 ? "medal-bronze" : frameTier === 2 ? "medal-silver" : "medal-gold";
  // Where each frame's empty disc is, as a share of the square: high on the ribbon frames, all of the wooden one.
  const [top, share] = earned ? [0.409, 0.44] : [0.5, 0.5];
  const e = size * share;
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      <SpriteIcon name={frame} size={size} className="absolute inset-0" />
      <img
        src={`/pixel/emblem-${a.id}.png`}
        onError={(ev) => (ev.currentTarget.src = "/pixel/emblem-wreath.png")}
        alt=""
        className={`absolute object-contain [image-rendering:pixelated] ${earned ? "" : "opacity-50 grayscale"}`}
        style={{ left: (size - e) / 2, top: size * top - e / 2, width: e, height: e }}
      />
    </span>
  );
}

function Bar({ value, max, height = 8, label }: { value: number; max: number; height?: number; label?: string }) {
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemax={Math.round(max)}
      className="block border border-cream-300 bg-cream-200"
      style={{ height }}
    >
      <span className="block h-full bg-leaf-500" style={{ width: `${max <= 0 ? 0 : Math.min(1, Math.max(0, value / max)) * 100}%` }} />
    </span>
  );
}

function Heading({ text, aside }: { text: string; aside?: string }) {
  return (
    <p className="mb-1.5 text-[12px] text-bark-600">
      {text}
      {aside && `  ${aside}`}
    </p>
  );
}

export function Achievements() {
  const core = useCore();
  const { frame } = useFrames();
  const catalog = useQuery({ queryKey: ["achievements"], queryFn: () => api.game.achievements(), staleTime: Infinity }).data ?? [];
  const p = core?.progress ?? emptyProgress;
  const level = Math.round(frame?.view.level.level ?? 1);
  const st = standingsOf(frame?.view.achievements ?? []);
  const of = (c: AchievementCategory) => catalog.filter((a) => a.category === c);
  return (
    <div className="flex flex-col gap-5">
      <Standing catalog={catalog} />
      <Starter list={of("starter")} st={st} />
      <div>
        <Heading text="开垦" />
        <div className="flex flex-wrap gap-2">
          {beds
            .filter((b) => b.unlockLevel !== undefined)
            .map((b) => {
              const done = level >= b.unlockLevel!;
              return (
                <span
                  key={b.index}
                  className="flex items-center gap-1 px-3 py-1 text-[12px]"
                  style={{ background: done ? tint("#b4cb7c", 0.7) : "#e2c995", color: done ? "#2f1f13" : "#67482d" }}
                >
                  Lv.{b.unlockLevel} 开垦一块地
                  {done && <SpriteIcon name="mark-check" size={12} />}
                </span>
              );
            })}
        </div>
      </div>
      {walls.map((c) => {
        const list = of(c);
        return (
          <div key={c}>
            <Heading text={`${categoryText[c]} ${list.filter((a) => st(a).tier > 0).length}/${list.length}`} />
            <div className="grid gap-2 sm:grid-cols-2">
              {list.map((a) => (
                <Card key={a.id} a={a} p={p} st={st} />
              ))}
            </div>
          </div>
        );
      })}
      <Secrets list={of("secret")} p={p} st={st} />
    </div>
  );
}

function Standing({ catalog }: { catalog: readonly Achievement[] }) {
  const core = useCore();
  const { frame } = useFrames();
  const p = core?.progress ?? emptyProgress;
  const lv = frame?.view.level ?? { level: 1, xp: 0, need: 10 };
  const commits = core?.commits?.total ?? 0;
  const level = Math.round(lv.level);
  const need = Math.round(lv.need);
  return (
    <Tinted className="flex flex-wrap items-center gap-x-6 gap-y-3 p-3">
      <div className="flex min-w-[160px] max-w-[280px] flex-col">
        <div className="flex flex-wrap items-end gap-2">
          <span className="text-[20px] text-leaf-700">Lv.{level}</span>
          <span className="text-[12px] text-bark-600">
            再 {need - Math.round(lv.xp)} 个 commit 升级 · 共 {Math.round(commits)} 个
          </span>
        </div>
        <span className="mt-1.5">
          <Bar value={lv.xp} max={need} label="到下一级的 commit" />
        </span>
      </div>
      <div className="flex items-center gap-2">
        <SpriteIcon name="coins-stack" size={40} />
        <div>
          <p className="text-[20px]">{thousands(Math.round(p.coins))}</p>
          <p className="text-[12px] text-bark-600">
            {p.streak > 1 ? `连胜 ${Math.round(p.streak)} · 收成金币 ×${(p.multiplier ?? 1).toFixed(1)}` : "收进主分支才给金币"}
          </p>
        </div>
      </div>
      <TitlePicker p={p} catalog={catalog} />
    </Tinted>
  );
}

/** Any tier reached can be worn, not a starter task's. */
function TitlePicker({ p, catalog }: { p: Progress; catalog: readonly Achievement[] }) {
  const commands = useFarmCommands();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => box.current?.contains(e.target as Node) || setOpen(false);
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);
  const title = p.title;
  const worn = title ? catalog.find((a) => a.id === title.id) : undefined;
  const earned = catalog
    .filter((a) => a.wearable)
    .flatMap((a) => a.tiers.flatMap((_, i) => (p.unlocked.some((u) => u.id === a.id && u.tier === i + 1) ? [{ a, tier: i + 1 }] : [])));
  return (
    <div ref={box} className="relative ml-auto">
      <button
        type="button"
        disabled={earned.length === 0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 border-2 border-cream-300 bg-cream-50 py-1.5 pr-3 pl-1.5 text-left enabled:cursor-pointer enabled:hover:bg-cream-200 disabled:opacity-60"
      >
        {worn && title ? <Medal a={worn} tier={Math.round(title.tier)} size={32} /> : <SpriteIcon name="banner-title" size={48} />}
        <span>
          <span className="block text-[12px] text-bark-600">称号</span>
          <span className="block text-[13px]">{worn && title ? tierTitle(worn, Math.round(title.tier)) : earned.length ? "挑一个" : "拿到成就就有"}</span>
        </span>
      </button>
      {open && (
        <div
          className="absolute top-full right-0 z-10 mt-2 max-h-80 w-64 overflow-y-auto bg-cream-50 p-1.5 shadow-px"
          role="menu"
          aria-label="挂在农场卡上的称号"
        >
          <p className="px-2 pt-1 pb-1.5 text-[12px] text-bark-600">挂在农场卡上的称号</p>
          {earned.map(({ a, tier }) => {
            const on = title?.id === a.id && title?.tier === tier;
            return (
              <button
                key={`${a.id}:${tier}`}
                type="button"
                role="menuitem"
                onClick={() => {
                  fire(commands.chooseTitle(a.id, tier));
                  setOpen(false);
                }}
                className="flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-left hover:bg-cream-100"
              >
                <Medal a={a} tier={tier} size={28} />
                <span className={`flex-1 text-[13px] ${on ? "text-leaf-700" : ""}`}>{tierTitle(a, tier)}</span>
                {on && <SpriteIcon name="mark-check" size={14} label="挂着" />}
              </button>
            );
          })}
          {title && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                fire(commands.chooseTitle());
                setOpen(false);
              }}
              className="w-full cursor-pointer px-2 py-1.5 text-left text-[13px] text-bark-600 hover:bg-cream-100"
            >
              不挂称号
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Starter({ list, st }: { list: readonly Achievement[]; st: Standings }) {
  const done = list.filter((a) => st(a).tier > 0).length;
  if (list.length > 0 && done === list.length)
    return (
      <Tinted color={tint("#b4cb7c", 0.4)} className="flex items-center gap-2">
        <SpriteIcon name="emblem-starter" size={28} />
        <span className="text-[13px] text-bark-800">新手任务都做完了。</span>
      </Tinted>
    );
  return (
    <div>
      <Heading text={`新手任务 ${done}/${list.length}`} aside={list[0] ? `每做完一个 +${Math.round(list[0].tiers[0]?.coins ?? 0)} 金币` : undefined} />
      <div className="grid gap-1.5 sm:grid-cols-2">
        {list.map((a) => {
          const ok = st(a).tier > 0;
          return (
            <div key={a.id} className="flex items-center gap-2.5 px-2.5 py-2" style={{ background: ok ? tint("#b4cb7c", 0.35) : "#eedcb2" }}>
              <span className="relative h-9 w-9 shrink-0">
                <img
                  src={`/pixel/emblem-${a.id}.png`}
                  onError={(ev) => (ev.currentTarget.src = "/pixel/emblem-wreath.png")}
                  alt=""
                  className={`h-9 w-9 object-contain [image-rendering:pixelated] ${ok ? "" : "opacity-60"}`}
                />
                {ok && <SpriteIcon name="stamp-done" size={20} label="做完了" className="absolute -right-1.5 -bottom-1" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-[13px] ${ok ? "text-bark-800" : "text-bark-900"}`}>{a.title}</span>
                <span className="block truncate text-[12px] text-bark-600" title={a.detail}>
                  {a.detail}
                </span>
              </span>
              {!ok && (
                <span className="flex items-center text-[12px] text-bark-600">
                  <SpriteIcon name="icon-coin" size={16} />+{Math.round(a.tiers[0]?.coins ?? 0)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Card({ a, p, st }: { a: Achievement; p: Progress; st: Standings }) {
  const { tier, count, next } = st(a);
  const at = tier > 0 ? reachedAt(p, a.id, tier) : undefined;
  const unit = a.unit ?? "";
  return (
    <div
      className="flex items-start gap-3 p-2.5"
      style={{ background: tier === 3 ? tint("#e5a93c", 0.2) : "#eedcb2", border: tier === 3 ? "2px solid #e5a93cb3" : undefined }}
    >
      <Medal a={a} tier={tier} size={60} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center">
          <span className={`min-w-0 flex-1 truncate text-[13px] ${tier > 0 ? "text-bark-900" : "text-bark-600"}`}>{tierTitle(a, tier < 1 ? 1 : tier)}</span>
          {a.tiers.length > 1 && (
            <span className="flex" aria-label={`${tier}/${a.tiers.length} 档`}>
              {a.tiers.map((t, i) => (
                <span
                  key={i}
                  title={`${tierText[i + 1]}：${numberText(t.need)} ${unit}`}
                  className="ml-1 h-2 w-2"
                  style={{ background: i < tier ? pip[i + 1] : "#c8a46e" }}
                />
              ))}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[12px] text-bark-600">{a.detail}</p>
        {next !== undefined && (
          <div className="mt-1.5 flex items-center gap-2">
            <span className="flex-1">
              <Bar value={Math.min(count, next)} max={next} height={6} label={`到${tierText[tier + 1] ?? ""}档`} />
            </span>
            <span className="text-[12px] text-bark-600">
              {count}/{next} {unit}
            </span>
          </div>
        )}
        {at !== undefined && (
          <p className="mt-1 text-[12px] text-bark-400">
            {day(at)}拿到{a.tiers.length > 1 ? `${tierText[tier]}牌` : ""}
          </p>
        )}
      </div>
    </div>
  );
}

function Secrets({ list, p, st }: { list: readonly Achievement[]; p: Progress; st: Standings }) {
  const found = list.filter((a) => st(a).tier > 0);
  const left = list.length - found.length;
  return (
    <div>
      <Heading text={`${categoryText.secret} ${found.length}/${list.length}`} />
      <div className="grid gap-2 sm:grid-cols-2">
        {found.map((a) => (
          <Card key={a.id} a={a} p={p} st={st} />
        ))}
        {left > 0 && (
          <div className="flex items-center gap-3 bg-cream-100 p-2.5">
            <SpriteIcon name="medal-locked" size={60} />
            <div>
              <p className="text-[13px] text-bark-600">还有 {left} 个彩蛋</p>
              <p className="text-[12px] text-bark-600">碰上了才知道是什么。</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
