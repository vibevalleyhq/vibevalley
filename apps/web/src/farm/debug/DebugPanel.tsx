// The debug console: ` opens it over the farm, unless a field has the keys. It drives the farm by its
// real calls (open the farm, stop or dismiss a helper, harvest) and the page's own clock and effects (which earn
// nothing), plays each sound, and keeps the frames and side events it saw, to copy as JSON lines.

import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Session, StateFrame } from "@vibevalley/protocol";
import { clockText } from "@vibevalley/engine/clock";
import { api, reasonOf } from "../../data/api";
import { useCore, useFrames } from "../../data/frame";
import { useLive } from "../../data/live";
import { localEffects } from "../effects";
import { toasts, ToastType } from "../kit";
import { playSound, SOUND_GROUPS, SOUND_LABEL } from "../sound";
import { clock, farm } from "../store";

const keep = 2000;

interface Entry {
  readonly seq: number;
  readonly type: string;
  readonly at: number;
  readonly summary: string;
  readonly json: unknown;
}

const frameSummary = (f: StateFrame) => {
  const s = f.state;
  const sessions = s.sessions.map((h) => `${h.id}:${h.phase._tag}`).join(" ");
  const effects = f.effects.length === 0 ? "" : ` · ${f.effects.map((e) => e.kind).join(" ")}`;
  return `call=${s.call} manager=${s.manager} sessions=${sessions || "0"}${effects}`;
};

/** A field has the keys: ` is typed, not a hotkey. */
const typing = () => {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);
};

function useDay() {
  return useSyncExternalStore(clock.subscribe, clock.day);
}

export function DebugPanel() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== "`" || typing()) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, []);
  const log = useLog();
  return open ? <Panel log={log} onClose={() => setOpen(false)} /> : null;
}

function useLog() {
  const { frame } = useFrames();
  const [entries, setEntries] = useState<Entry[]>([]);
  const seq = useRef(0);
  const paused = useRef(false);
  const add = (type: string, summary: string, json: unknown) => {
    if (paused.current) return;
    setEntries((all) => [...all.slice(-(keep - 1)), { seq: ++seq.current, type, at: Date.now(), summary, json }]);
  };
  useEffect(() => {
    if (frame) add("frame", frameSummary(frame), frame);
  }, [frame]);
  useLive((e) => add(e.type, JSON.stringify(e).slice(0, 160), e));
  return { entries, paused, clear: () => setEntries([]) };
}

const btn = (tone: "plain" | "hat" | "bad" = "plain") =>
  `h-7 cursor-pointer px-2.5 text-[12px] ${tone === "hat" ? "bg-hat text-ink-950 hover:brightness-110" : tone === "bad" ? "bg-[#5a2420] text-paper hover:bg-[#6c2b26]" : "bg-ink-800 text-paper hover:bg-ink-700"}`;

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1.5 border-t border-ink-700 pt-2">
      <header className="flex items-center gap-2 text-[11px] tracking-wide text-ink-300">
        <span className="flex-1">{title}</span>
        {aside}
      </header>
      {children}
    </section>
  );
}

function Panel({ log, onClose }: { log: ReturnType<typeof useLog>; onClose: () => void }) {
  const core = useCore();
  const day = useDay();
  const [, redraw] = useState(0);
  const achievements = useQuery({ queryKey: ["achievements"], queryFn: () => api.game.achievements() }).data ?? [];
  const [next, setNext] = useState(0);
  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      toasts.add({ type: ToastType.error, title: "调试台", description: reasonOf(e), timeout: 4500 });
    }
  };
  const sessions = core?.sessions ?? [];
  const issueOf = (h: Session) => h.issue ?? h.id;
  const everyone = (action: "stop" | "dismiss") =>
    run(async () => {
      for (const h of sessions) await (action === "stop" ? api.session.stop({ id: h.id }) : api.issue.status({ id: issueOf(h), body: { status: "canceled" } }));
    });
  const level = Math.round(useFrames().frame?.view.level.level ?? 1);
  return (
    <aside
      aria-label="调试台"
      className="absolute top-2 right-2 bottom-2 z-50 flex w-[380px] flex-col gap-2 overflow-hidden bg-[#14110ef5] p-3 font-mono text-[12px] text-paper shadow-px"
    >
      <header className="flex items-center gap-2">
        <span className="flex-1 text-[13px] text-hat">调试台</span>
        <button type="button" className={btn()} onClick={onClose}>
          关闭 `
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        <Section
          title="通话"
          aside={
            <span>
              call={core?.call} manager={core?.manager}
            </span>
          }
        >
          <div className="flex gap-1.5">
            <button type="button" className={btn("hat")} onClick={() => void run(() => api.manager.open())}>
              开工
            </button>
            <button type="button" className={btn()} onClick={() => void everyone("dismiss")}>
              收工
            </button>
          </div>
        </Section>
        <Section title="天色" aside={<span>{clockText(day.tod)}</span>}>
          <input
            type="range"
            aria-label="时间"
            min={0}
            max={0.999}
            step={0.005}
            value={day.tod}
            onChange={(e) => clock.setTimeOfDay(Number(e.target.value))}
            className="accent-[#f2b53a]"
          />
          <div className="flex gap-1">
            {[
              [0, "停"],
              [1, "1×"],
              [10, "10×"],
              [60, "60×"],
            ].map(([speed, label]) => (
              <button
                key={label}
                type="button"
                aria-pressed={(speed === 0 && day.paused) || (!day.paused && day.speed === speed)}
                className={`${btn()} aria-pressed:bg-hat aria-pressed:text-ink-950`}
                onClick={() => clock.setSpeed(speed as number)}
              >
                {label}
              </button>
            ))}
          </div>
        </Section>
        <Section title="游戏进度" aside={<span>Lv.{level}</span>}>
          <div className="flex gap-1.5">
            <button type="button" className={btn()} onClick={() => localEffects.add({ kind: "levelUp", level: level + 1 })}>
              升一级（带横幅）
            </button>
            <button
              type="button"
              className={btn()}
              disabled={achievements.length === 0}
              onClick={() => {
                const a = achievements[next % achievements.length]!;
                const t = a.tiers[0]!;
                setNext(next + 1);
                localEffects.add({
                  kind: "achievement",
                  achievement: a.id,
                  tier: 1,
                  title: t.title,
                  reached: t.reached,
                  detail: a.detail,
                  coins: t.coins,
                  oneOff: a.tiers.length === 1,
                });
              }}
            >
              弹一个成就
            </button>
          </div>
        </Section>
        <Section title={`帮工 · ${sessions.length}`}>
          {sessions.length === 0 && <span className="text-ink-300">地里没人。</span>}
          {sessions.map((h) => (
            <div key={h.id} className="flex flex-wrap items-center gap-1.5">
              <button type="button" className="min-w-0 flex-1 cursor-pointer truncate text-left hover:text-hat" onClick={() => farm.select(h.id)}>
                {h.id} {h.name} · {h.phase._tag}
              </button>
              {h.phase._tag === "ripe" && (
                <button type="button" className={btn("hat")} onClick={() => void run(() => api.issue.status({ id: issueOf(h), body: { status: "done" } }))}>
                  收获
                </button>
              )}
              <button type="button" className={btn()} onClick={() => void run(() => api.session.stop({ id: h.id }))}>
                叫停
              </button>
              <button type="button" className={btn("bad")} onClick={() => void run(() => api.issue.status({ id: issueOf(h), body: { status: "canceled" } }))}>
                收工
              </button>
            </div>
          ))}
        </Section>
        <Section title="全部">
          <div className="flex gap-1.5">
            <button type="button" className={btn()} onClick={() => void everyone("stop")}>
              全部叫停
            </button>
            <button type="button" className={btn("bad")} onClick={() => void everyone("dismiss")}>
              全部收工
            </button>
          </div>
        </Section>
        {SOUND_GROUPS.map((g) => (
          <Section key={g.title} title={g.title}>
            <div className="flex flex-wrap gap-1">
              {g.names.map((n) => (
                <button key={n} type="button" title={n} className={btn()} onClick={() => playSound(n)}>
                  {SOUND_LABEL[n] ?? n}
                </button>
              ))}
            </div>
          </Section>
        ))}
        <Section
          title={`帧和事件 · ${log.entries.length}`}
          aside={
            <span className="flex gap-1">
              <button
                type="button"
                className={btn()}
                onClick={() => {
                  log.paused.current = !log.paused.current;
                  redraw((n) => n + 1);
                }}
              >
                {log.paused.current ? "接着记" : "暂停"}
              </button>
              <button type="button" className={btn()} onClick={log.clear}>
                清空
              </button>
              <button
                type="button"
                className={btn()}
                onClick={() => void navigator.clipboard?.writeText(log.entries.map((e) => JSON.stringify(e.json)).join("\n")).catch(() => undefined)}
              >
                复制 .jsonl
              </button>
            </span>
          }
        >
          <ol className="flex flex-col gap-0.5">
            {log.entries
              .slice(-200)
              .reverse()
              .map((e) => (
                <li key={e.seq} className="flex gap-2">
                  <span className="w-8 shrink-0 text-right text-ink-500">{e.seq}</span>
                  <span className="w-12 shrink-0 text-hat">{e.type}</span>
                  <span className="min-w-0 break-all text-ink-100">{e.summary}</span>
                </li>
              ))}
          </ol>
        </Section>
      </div>
    </aside>
  );
}
