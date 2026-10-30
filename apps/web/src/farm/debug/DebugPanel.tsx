import { t } from "@vibevalley/i18n";
// The debug console: ` opens it over the farm, unless a field has the keys. It drives the farm by its real calls (open
// the farm, stop or dismiss a helper, harvest) and the page's own clock and effects (which earn nothing), plays each
// sound, and keeps the frames and side events it saw, to copy as JSON lines.

import { createEffect, createSignal, For, onSettled, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";

import type { Session, StateFrame } from "@vibevalley/protocol";
import { clockText } from "@vibevalley/engine/clock";
import { api, reasonOf } from "@/base/api";
import { subscribeLive } from "@/base/live";
import { localEffects } from "@/farm/effects";
import { playSound, SOUND_GROUPS, SOUND_LABEL } from "@/ui/pixel/sound";
import { clock, farm } from "@/farm/store";
import { typing } from "@/farm/tools";
import { aria } from "@/base/util";
import { createExternal } from "@/base/external";
import { orchestratorMood, useCore, useFrames, rawFrame } from "@/base/frame";
import { ready, useQuery } from "@/base/query";
import { toasts, ToastType } from "@/ui/pixel";

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
  return `call=${s.call} orchestrator=${orchestratorMood(s)} sessions=${sessions || "0"}${effects}`;
};

export function DebugPanel() {
  const [open, setOpen] = createSignal(false);
  onSettled(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== "`" || typing()) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  });
  const log = createLog();
  return (
    <Show when={open()}>
      <Panel log={log} onClose={() => setOpen(false)} />
    </Show>
  );
}

/** The frames as sent and the live stream's events, kept while the farm is on screen. */
function createLog() {
  const raw = rawFrame();
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const [paused, setPaused] = createSignal(false);
  let seq = 0;
  const add = (type: string, summary: string, json: unknown) => {
    // Asked once per entry, from the frame effect's apply and the live stream's callback alike.
    if (untrack(paused)) return;
    setEntries((all) => [...all.slice(-(keep - 1)), { seq: ++seq, type, at: Date.now(), summary, json }]);
  };
  createEffect(raw, (frame) => {
    if (frame) add("frame", frameSummary(frame), frame);
  });
  onSettled(() => subscribeLive((e) => add(e.type, JSON.stringify(e).slice(0, 160), e)));
  return { entries, paused, setPaused, clear: () => setEntries([]) };
}

const btn = (tone: "plain" | "hat" | "bad" = "plain") =>
  `h-7 cursor-pointer px-2.5 text-[12px] ${tone === "hat" ? "bg-hat text-ink-950 hover:brightness-110" : tone === "bad" ? "bg-berry-900 text-paper hover:bg-berry-800" : "bg-ink-800 text-paper hover:bg-ink-700"}`;

function Section(props: { title: string; aside?: JSX.Element; children: JSX.Element }) {
  return (
    <section aria-label={props.title} class="flex flex-col gap-1.5 border-t border-ink-700 pt-2">
      <header class="flex items-center gap-2 text-[11px] tracking-wide text-ink-300">
        <span class="flex-1">{props.title}</span>
        {props.aside}
      </header>
      {props.children}
    </section>
  );
}

function Panel(props: { log: ReturnType<typeof createLog>; onClose: () => void }) {
  const core = useCore();
  const frames = useFrames();
  const day = createExternal(clock.subscribe, clock.day, { always: true });
  const achievementsQuery = useQuery(() => ({ queryKey: ["achievements"], queryFn: () => api.game.achievement.list() }));
  const achievements = () => ready(achievementsQuery, []);
  const [next, setNext] = createSignal(0);
  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      toasts.add({ type: ToastType.error, title: t("web.farm.debug.title"), description: reasonOf(e), timeout: 4500 });
    }
  };
  const sessions = () => core()?.sessions ?? [];
  const issueOf = (h: Session) => h.issue ?? h.id;
  const everyone = (action: "stop" | "dismiss") =>
    run(async () => {
      for (const h of sessions()) await (action === "stop" ? api.session.stop({ id: h.id }) : api.issue.status.update({ id: issueOf(h), status: "canceled" }));
    });
  const level = () => Math.round(frames.frame?.view.level.level ?? 1);
  return (
    <aside
      aria-label={t("web.farm.debug.title")}
      data-testid="debug"
      class="absolute top-2 right-2 bottom-2 z-50 flex w-[380px] flex-col gap-2 overflow-hidden bg-ink-950/96 p-3 font-mono text-[12px] text-paper shadow-px"
    >
      <header class="flex items-center gap-2">
        <span class="flex-1 text-[13px] text-hat">{t("web.farm.debug.title")}</span>
        <button type="button" data-testid="debug-close" class={btn()} onClick={() => props.onClose()}>
          {t("web.farm.debug.close")}
        </button>
      </header>
      <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        <Section
          title={t("web.farm.debug.call")}
          aside={
            <span>
              call={core()?.call} orchestrator={orchestratorMood(core())}
            </span>
          }
        >
          <div class="flex gap-1.5">
            <button type="button" class={btn("hat")} onClick={() => void run(() => api.orchestrator.open())}>
              {t("web.farm.debug.open")}
            </button>
            <button type="button" class={btn()} onClick={() => void everyone("dismiss")}>
              {t("web.farm.debug.dismiss")}
            </button>
          </div>
        </Section>
        <Section title={t("web.farm.debug.sky")} aside={<span>{clockText(day().tod)}</span>}>
          <input
            type="range"
            aria-label={t("web.farm.debug.time")}
            min={0}
            max={0.999}
            step={0.005}
            value={day().tod}
            onInput={(e) => clock.setTimeOfDay(Number(e.currentTarget.value))}
            class="accent-hat"
          />
          <div class="flex gap-1">
            <For
              each={
                [
                  [0, t("web.farm.debug.stop")],
                  [1, "1×"],
                  [10, "10×"],
                  [60, "60×"],
                ] as const
              }
            >
              {([speed, label]) => (
                <button
                  type="button"
                  data-key={speed}
                  aria-pressed={aria((speed === 0 && day().paused) || (!day().paused && day().speed === speed))}
                  class={[btn(), "aria-pressed:bg-hat aria-pressed:text-ink-950"]}
                  onClick={() => clock.setSpeed(speed)}
                >
                  {label}
                </button>
              )}
            </For>
          </div>
        </Section>
        <Section title={t("web.farm.debug.progress")} aside={<span>Lv.{level()}</span>}>
          <div class="flex gap-1.5">
            <button type="button" data-testid="debug-level-up" class={btn()} onClick={() => localEffects.add({ kind: "levelUp", level: level() + 1 })}>
              {t("web.farm.debug.levelUp")}
            </button>
            <button
              type="button"
              class={btn()}
              disabled={achievements().length === 0}
              onClick={() => {
                const all = achievements();
                const a = all[next() % all.length]!;
                const t = a.tiers[0]!;
                setNext(next() + 1);
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
              {t("web.farm.debug.achievement")}
            </button>
          </div>
        </Section>
        <Section title={t("web.farm.debug.helpers", { n: sessions().length })}>
          <Show when={sessions().length === 0}>
            <span class="text-ink-300">{t("web.farm.debug.nobody")}</span>
          </Show>
          <For each={sessions()}>
            {(h) => (
              <div class="flex flex-wrap items-center gap-1.5">
                <button type="button" class="min-w-0 flex-1 cursor-pointer truncate text-left hover:text-hat" onClick={() => farm.select(h.id)}>
                  {h.id} {h.name} · {h.phase._tag}
                </button>
                <Show when={h.phase._tag === "done"}>
                  <button type="button" class={btn("hat")} onClick={() => void run(() => api.issue.status.update({ id: issueOf(h), status: "done" }))}>
                    {t("web.farm.tool.harvest.label")}
                  </button>
                </Show>
                <button type="button" class={btn()} onClick={() => void run(() => api.session.stop({ id: h.id }))}>
                  {t("web.farm.debug.halt")}
                </button>
                <button type="button" class={btn("bad")} onClick={() => void run(() => api.issue.status.update({ id: issueOf(h), status: "canceled" }))}>
                  {t("web.farm.debug.dismiss")}
                </button>
              </div>
            )}
          </For>
        </Section>
        <Section title={t("web.farm.debug.all")}>
          <div class="flex gap-1.5">
            <button type="button" class={btn()} onClick={() => void everyone("stop")}>
              {t("web.farm.debug.haltAll")}
            </button>
            <button type="button" class={btn("bad")} onClick={() => void everyone("dismiss")}>
              {t("web.farm.debug.dismissAll")}
            </button>
          </div>
        </Section>
        <For each={SOUND_GROUPS}>
          {(g) => (
            <Section title={g.title}>
              <div class="flex flex-wrap gap-1">
                <For each={g.names}>
                  {(n) => (
                    <button type="button" title={n} class={btn()} onClick={() => playSound(n)}>
                      {SOUND_LABEL[n]}
                    </button>
                  )}
                </For>
              </div>
            </Section>
          )}
        </For>
        <Section
          title={t("web.farm.debug.frames", { n: props.log.entries().length })}
          aside={
            <span class="flex gap-1">
              <button type="button" class={btn()} onClick={() => props.log.setPaused(!props.log.paused())}>
                {props.log.paused() ? t("web.farm.debug.resume") : t("web.farm.debug.pause")}
              </button>
              <button type="button" class={btn()} onClick={() => props.log.clear()}>
                {t("web.farm.debug.clear")}
              </button>
              <button
                type="button"
                class={btn()}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(
                      props.log
                        .entries()
                        .map((e) => JSON.stringify(e.json))
                        .join("\n"),
                    )
                    .catch(() => undefined)
                }
              >
                {t("web.farm.debug.copy")}
              </button>
            </span>
          }
        >
          <ol class="flex flex-col gap-0.5">
            <For each={props.log.entries().slice(-200).reverse()} keyed={(e) => e.seq}>
              {(e) => (
                <li data-testid="debug-frame" data-type={e().type} class="flex gap-2">
                  <span class="w-8 shrink-0 text-right text-ink-500">{e().seq}</span>
                  <span class="w-12 shrink-0 text-hat">{e().type}</span>
                  <span class="min-w-0 break-all text-ink-100">{e().summary}</span>
                </li>
              )}
            </For>
          </ol>
        </Section>
      </div>
    </aside>
  );
}
