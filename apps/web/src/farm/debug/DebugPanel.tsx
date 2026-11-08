import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, onSettled, Show, untrack } from "solid-js";

import { clockText } from "@vibevalley/engine/clock";
import { t } from "@vibevalley/i18n";
import type { Session, StateFrame } from "@vibevalley/protocol";

import { aria } from "#/base/dom.tsx";
import { createExternal } from "#/base/external.ts";
import { localEffects } from "#/farm/frames.ts";
import { clock, farm } from "#/farm/store.ts";
import { typing } from "#/farm/tools.ts";
import { api } from "#/infra/api.ts";
import { orchestratorMood, useCore, useFrames, rawFrame, subscribeLive } from "#/infra/frame.ts";
import { achievementsQuery as achievementCatalog, ready, useQuery } from "#/infra/query.ts";
import { createPixelAct } from "#/ui/pixel/index.ts";
import { playSound, SOUND_GROUPS, SOUND_LABEL } from "#/ui/pixel/sound.ts";

const recipeStyles = stylex.create({
  panelAside: {
    position: "absolute",
    top: "calc(var(--spacing) * 2)",
    right: "calc(var(--spacing) * 2)",
    bottom: "calc(var(--spacing) * 2)",
    zIndex: "50",
    display: "flex",
    width: "380px",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
    overflow: "hidden",
    backgroundColor: {
      default: "var(--color-px-debug-surface)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-ink-950) 96%, transparent)",
    },
    padding: "calc(var(--spacing) * 3)",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    color: "var(--color-paper)",
    boxShadow: "var(--shadow-px)",
  },
});

const variantStyles = stylex.create({
  panelDiv: {
    display: "flex",
    minHeight: "0",
    flex: "1",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
    overflowY: "auto",
  },
});

const viewStyles = stylex.create({
  sectionSection: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-ink-700)",
    paddingTop: "calc(var(--spacing) * 2)",
  },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    fontSize: "11px",
    letterSpacing: "var(--tracking-wide)",
    color: "var(--color-ink-300)",
  },
  sectionSpan: {
    flex: "1",
  },
  panelHeader: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  panelSpan: {
    flex: "1",
    fontSize: "13px",
    color: "var(--color-hat)",
  },
  panelDiv: {
    display: "flex",
    gap: "calc(var(--spacing) * 1.5)",
  },
  panelInput: {
    accentColor: "var(--color-hat)",
  },
  panelDiv2: {
    display: "flex",
    gap: "var(--spacing)",
  },
  panelSpan2: {
    color: "var(--color-ink-300)",
  },
  panelDiv3: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  panelButton: {
    minWidth: "0",
    flex: "1",
    cursor: "pointer",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textAlign: "left",
    color: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hat)",
      },
    },
  },
  panelDiv4: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--spacing)",
  },
  panelOl: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
  },
  debugFrame: {
    display: "flex",
    gap: "calc(var(--spacing) * 2)",
  },
  panelSpan3: {
    width: "calc(var(--spacing) * 8)",
    flexShrink: "0",
    textAlign: "right",
    color: "var(--color-ink-500)",
  },
  panelSpan4: {
    width: "calc(var(--spacing) * 12)",
    flexShrink: "0",
    color: "var(--color-hat)",
  },
  panelSpan5: {
    minWidth: "0",
    wordBreak: "break-all",
    color: "var(--color-ink-100)",
  },
});

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
    <section aria-label={props.title} {...stylex.attrs(viewStyles.sectionSection)}>
      <header {...stylex.attrs(viewStyles.sectionHeader)}>
        <span {...stylex.attrs(viewStyles.sectionSpan)}>{props.title}</span>
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
  const achievementsQuery = useQuery(achievementCatalog);
  const achievements = () => ready(achievementsQuery, []);
  const [next, setNext] = createSignal(0);
  const act = createPixelAct(t("web.farm.debug.title"));
  const sessions = () => core()?.sessions ?? [];
  const issueOf = (h: Session) => h.issue ?? h.id;
  const everyone = (action: "stop" | "dismiss") =>
    act.run(async () => {
      await Promise.all(
        sessions().map((h) => (action === "stop" ? api.session.stop({ id: h.id }) : api.issue.status.update({ id: issueOf(h), status: "canceled" }))),
      );
    });
  const level = () => Math.round(frames.frame?.view.level.level ?? 1);
  return (
    <aside aria-label={t("web.farm.debug.title")} data-testid="debug" {...stylex.attrs(recipeStyles.panelAside)}>
      <header {...stylex.attrs(viewStyles.panelHeader)}>
        <span {...stylex.attrs(viewStyles.panelSpan)}>{t("web.farm.debug.title")}</span>
        <button type="button" data-testid="debug-close" class={btn()} onClick={() => props.onClose()}>
          {t("web.farm.debug.close")}
        </button>
      </header>
      <div {...stylex.attrs(variantStyles.panelDiv)}>
        <Section
          title={t("web.farm.debug.call")}
          aside={
            <span>
              call={core()?.call} orchestrator={orchestratorMood(core())}
            </span>
          }
        >
          <div {...stylex.attrs(viewStyles.panelDiv)}>
            <button type="button" class={btn("hat")} onClick={() => void act.run(() => api.orchestrator.open())}>
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
            {...stylex.attrs(viewStyles.panelInput)}
          />
          <div {...stylex.attrs(viewStyles.panelDiv2)}>
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
          <div {...stylex.attrs(viewStyles.panelDiv)}>
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
            <span {...stylex.attrs(viewStyles.panelSpan2)}>{t("web.farm.debug.nobody")}</span>
          </Show>
          <For each={sessions()}>
            {(h) => (
              <div {...stylex.attrs(viewStyles.panelDiv3)}>
                <button type="button" {...stylex.attrs(viewStyles.panelButton)} onClick={() => farm.select(h.id)}>
                  {h.id} {h.name} · {h.phase._tag}
                </button>
                <Show when={h.phase._tag === "done"}>
                  <button type="button" class={btn("hat")} onClick={() => void act.run(() => api.issue.status.update({ id: issueOf(h), status: "done" }))}>
                    {t("web.farm.tool.harvest.label")}
                  </button>
                </Show>
                <button type="button" class={btn()} onClick={() => void act.run(() => api.session.stop({ id: h.id }))}>
                  {t("web.farm.debug.halt")}
                </button>
                <button type="button" class={btn("bad")} onClick={() => void act.run(() => api.issue.status.update({ id: issueOf(h), status: "canceled" }))}>
                  {t("web.farm.debug.dismiss")}
                </button>
              </div>
            )}
          </For>
        </Section>
        <Section title={t("web.farm.debug.all")}>
          <div {...stylex.attrs(viewStyles.panelDiv)}>
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
              <div {...stylex.attrs(viewStyles.panelDiv4)}>
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
            <span {...stylex.attrs(viewStyles.panelDiv2)}>
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
          <ol {...stylex.attrs(viewStyles.panelOl)}>
            <For each={props.log.entries().slice(-200).toReversed()} keyed={(e) => e.seq}>
              {(e) => (
                <li data-testid="debug-frame" data-type={e().type} {...stylex.attrs(viewStyles.debugFrame)}>
                  <span {...stylex.attrs(viewStyles.panelSpan3)}>{e().seq}</span>
                  <span {...stylex.attrs(viewStyles.panelSpan4)}>{e().type}</span>
                  <span {...stylex.attrs(viewStyles.panelSpan5)}>{e().summary}</span>
                </li>
              )}
            </For>
          </ol>
        </Section>
      </div>
    </aside>
  );
}
