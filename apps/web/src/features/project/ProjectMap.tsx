import { t } from "@vibevalley/i18n";
// The map: every project an island on parchment, its plots its helpers'
// worktrees, its empty plots room for more and the sacks at its gate what waits; a click opens the project, a helper's
// plot its issue, an empty plot a seed for the project.

import { createMemo, createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { type Agent, maxRunning, type Session } from "@vibevalley/protocol";
import { phaseText } from "@vibevalley/protocol/rules";
import { api, newSendKey, reasonOf } from "@/base/api";
import { badgeColors, CardColors } from "@/ui/pixel/card";
import { type SpriteAtlas, type SpriteInfo, useAtlas } from "@/ui/pixel/atlas";
import { castOf, castSprite, cropSprite } from "@/ui/cast";
import {
  growthOf,
  homeless,
  type Island,
  islandLook,
  islandLooks,
  islandScale,
  islandsOf,
  islandText,
  mapPose,
  mapTally,
  openOf,
  plotsIn,
  sessionInPlot,
  since,
  spotText,
} from "./rules";
import { toast } from "@/ui/toasts";
import { writeIssue } from "@/features/issue";
import { useRouter } from "@/base/router";
import { autofocus } from "@/base/util";
import { useCore, useFrames } from "@/base/frame";
import { defaultOf } from "@/features/channel";
import { ready, useAgents, useProjects } from "@/base/query";
import { PixelCard } from "@/ui/pixel";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { AgentFace } from "@/ui/Face";
import { TextArea } from "@/ui/Field";
import { SpriteIcon } from "@/ui/pixel";
import { PoseSprite } from "@/ui/PoseSprite";
import { Card, Quiet } from "@/ui/layout";

const gap = 24;
const parchment = "#ebd9ae";

/** The islands as the farm stands now. */
export function useIslands(): () => Island[] {
  const core = useCore();
  const frames = useFrames();
  const projects = useProjects();
  return createMemo(() =>
    islandsOf({ projects: ready(projects, []), sessions: core()?.sessions ?? [], plots: frames.frame?.view?.plots ?? {}, issues: core()?.issues ?? [] }),
  );
}

const go = (navigate: (to: string) => void, id: string) => navigate(`/issues/${encodeURIComponent(id)}`);

export function ProjectMap() {
  const atlas = useAtlas();
  const islands = useIslands();
  const projects = useProjects();
  const loading = () => !ready(projects, undefined);
  const core = useCore();
  const [sowing, setSowing] = createSignal<string>();
  const [width, setWidth] = createSignal(0);
  let box!: HTMLDivElement;
  onSettled(() => {
    const ro = new ResizeObserver(() => setWidth(box.clientWidth));
    ro.observe(box);
    return () => ro.disconnect();
  });
  const cell = () => {
    const a = atlas();
    const looks = a ? islandLooks.filter((l) => a.has(l)).map((l) => a.get(l)) : [];
    return looks.length === 0 ? { w: 300, h: 200 } : { w: Math.max(...looks.map((l) => l.w)), h: Math.max(...looks.map((l) => l.h)) };
  };
  const scale = () => islandScale(width() - 32, cell().w, gap);
  const tally = () => mapTally(islands());
  const stray = () => homeless(core()?.sessions ?? []);
  return (
    <div class="flex h-full min-h-0 flex-col gap-2">
      <div class="flex flex-wrap items-center gap-x-5 gap-y-1.5">
        <span class="text-sm font-medium">
          {[
            t("web.project.map.islands", { n: islands().length }),
            t("web.project.map.peopled", { n: tally().peopled }),
            t("web.project.map.working", { n: tally().working, of: maxRunning }),
            ...(tally().queued > 0 ? [t("web.project.map.queued", { n: tally().queued })] : []),
          ].join(" · ")}
        </span>
        <span class="flex flex-wrap gap-x-4 gap-y-1">
          <For
            each={
              [
                ["map-stake", t("web.project.map.stake")],
                ["plot-locked", t("web.project.map.locked")],
                ["map-sack", t("web.project.map.sack")],
              ] as const
            }
          >
            {([icon, words]) => (
              <span class="flex items-center gap-1 text-xs text-muted">
                <SpriteIcon name={icon} size={18} />
                {words}
              </span>
            )}
          </For>
        </span>
      </div>
      <div ref={(el) => (box = el)} class="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-line" style={{ background: parchment }}>
        <Grid />
        <Show when={atlas()}>{(a) => <Clouds atlas={a()} />}</Show>
        <Show when={atlas()?.has("map-compass") && width() >= 700 ? atlas() : undefined}>
          {(a) => <Art sp={a().get("map-compass")} scale={1.5} class="pointer-events-none absolute right-4 bottom-4 opacity-80" />}
        </Show>
        <div class="absolute inset-0 overflow-y-auto p-4">
          <Switch
            fallback={
              <div class="flex flex-wrap justify-center" style={{ gap: `${gap}px` }}>
                <For each={islands()} keyed={(i) => i.project}>
                  {(i) => (
                    <div style={{ width: `${cell().w * scale()}px` }}>
                      <IslandView island={i()} atlas={atlas()!} scale={scale()} cellHeight={cell().h} onSow={() => setSowing(i().project)} />
                    </div>
                  )}
                </For>
              </div>
            }
          >
            <Match when={!atlas() || (loading() && islands().length === 0)}>
              <Quiet>{t("web.project.finding")}</Quiet>
            </Match>
            <Match when={islands().length === 0}>
              <NoProjects />
            </Match>
          </Switch>
          <Show when={stray().length > 0}>
            <Homeless sessions={stray()} />
          </Show>
        </div>
      </div>
      <Dialog open={sowing() !== undefined} onClose={() => setSowing(undefined)} title={t("web.project.map.send", { project: sowing() ?? "" })}>
        <Show when={sowing()}>{(p) => <SowHere project={p()} onDone={() => setSowing(undefined)} />}</Show>
      </Dialog>
    </div>
  );
}

/** A dashed line every 64 px, as the parchment's grid. */
function Grid() {
  const ink = "#c8a46e73";
  return (
    <div class="pointer-events-none absolute inset-0">
      <div
        class="absolute inset-0"
        style={{
          background: `repeating-linear-gradient(to right, transparent 0 62px, ${ink} 62px 64px)`,
          "mask-image": "repeating-linear-gradient(to bottom, #000 0 4px, transparent 4px 8px)",
        }}
      />
      <div
        class="absolute inset-0"
        style={{
          background: `repeating-linear-gradient(to bottom, transparent 0 62px, ${ink} 62px 64px)`,
          "mask-image": "repeating-linear-gradient(to right, #000 0 4px, transparent 4px 8px)",
        }}
      />
    </div>
  );
}

const clouds = [
  [0.08, 0.1, 9],
  [0.46, 0.62, 6],
  [0.78, 0.35, 11],
] as const;

/** Slow, a whole pixel or so at a time. */
function Clouds(props: { atlas: SpriteAtlas }) {
  const [t, setT] = createSignal(0);
  let box: HTMLDivElement | undefined;
  onSettled(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const start = performance.now();
    const timer = setInterval(() => setT((performance.now() - start) / 1000), 100);
    return () => clearInterval(timer);
  });
  return (
    <Show when={props.atlas.has("map-cloud") ? props.atlas.get("map-cloud") : undefined}>
      {(cloud) => {
        const span = () => (box?.clientWidth ?? 800) + cloud().w * 4;
        return (
          <div ref={(el) => (box = el)} class="pointer-events-none absolute inset-0">
            <For each={clouds}>
              {([y, from, speed]) => (
                <Art
                  sp={cloud()}
                  scale={2}
                  class="absolute opacity-55"
                  style={{
                    left: `${Math.round(((from * span() + t() * speed) % span()) - cloud().w * 4)}px`,
                    top: `${Math.round(y * (box?.clientHeight ?? 600))}px`,
                  }}
                />
              )}
            </For>
          </div>
        );
      }}
    </Show>
  );
}

function Art(props: { sp: SpriteInfo; scale: number; class?: string; style?: JSX.CSSProperties }) {
  return (
    <img
      src={props.sp.url}
      alt=""
      draggable="false"
      class={["max-w-none [image-rendering:pixelated]", props.class]}
      style={{ width: `${props.sp.w * props.scale}px`, height: `${props.sp.h * props.scale}px`, ...props.style }}
    />
  );
}

/** A sprite stood with its anchor on `foot`: a button when it does something. */
function Placed(props: {
  sp: SpriteInfo;
  foot: { x: number; y: number };
  scale: number;
  onClick?: () => void;
  tip?: string;
  label?: string;
  children: JSX.Element;
}) {
  const style = () => ({ left: `${(props.foot.x - props.sp.ax) * props.scale}px`, top: `${(props.foot.y - props.sp.ay) * props.scale}px` });
  return (
    <Show
      when={props.onClick}
      fallback={
        <span title={props.tip} aria-label={props.label} class="absolute" style={style()}>
          {props.children}
        </span>
      }
    >
      {(onClick) => (
        <button
          type="button"
          title={props.tip}
          aria-label={props.label ?? props.tip}
          onClick={() => onClick()()}
          class="absolute cursor-pointer"
          style={style()}
        >
          {props.children}
        </button>
      )}
    </Show>
  );
}

function IslandView(props: { island: Island; atlas: SpriteAtlas; scale: number; cellHeight: number; onSow: () => void }) {
  const router = useRouter();
  const all = useAgents();
  const agents = createMemo(() => new Map(ready(all, []).map((a): [string, Agent] => [a.id, a])));
  const pic = () => props.atlas.first([islandLook(props.island.project), ...islandLooks]);
  const yard = () => {
    const y = pic().yard;
    return y
      ? { left: y.x0, top: y.y0, width: y.x1 - y.x0, height: y.y1 - y.y0 }
      : { left: pic().w * 0.25, top: pic().h * 0.25, width: pic().w * 0.5, height: pic().h * 0.4 };
  };
  const at = () => plotsIn(yard(), props.island.spots.length);
  const down = () => props.cellHeight - pic().h;
  const open = () => router.navigate(`/projects/${encodeURIComponent(props.island.project)}`);
  // 进岛: into this project's own farm.
  const enter = () => router.navigate(`/farm/${encodeURIComponent(props.island.project)}`);
  const has = (n: string) => props.atlas.has(n);
  const s = () => props.scale;
  const gate = () => ({ x: yard().left + yard().width / 2, y: yard().top + yard().height + down() });
  const sacks = () => props.island.queued.slice(0, 3);
  return (
    <div class="flex flex-col items-center gap-1.5">
      <div class="relative" style={{ width: `${pic().w * s()}px`, height: `${props.cellHeight * s()}px` }}>
        <button
          type="button"
          data-testid="island"
          data-key={props.island.project}
          aria-label={t("shared.join.labeled", { label: props.island.project, text: islandText(props.island) })}
          onClick={open}
          class="absolute inset-x-0 bottom-0 cursor-pointer"
        >
          <Art sp={pic()} scale={s()} class="mx-auto block" />
        </button>
        <For each={props.island.spots} keyed={false}>
          {(spot, i) => {
            const foot = () => ({ x: at()[i]!.x, y: at()[i]!.y + down() });
            const tip = () => spotText(spot(), Date.now());
            return (
              <Switch>
                <Match when={spot().kind === "taken" ? (spot() as Extract<Island["spots"][number], { kind: "taken" }>) : undefined}>
                  {(taken) => {
                    const h = () => taken().session;
                    const cast = () => castOf(agents().get(h().agent)?.look, h().agent);
                    const pose = () => mapPose(h());
                    const body = () => props.atlas.get(castSprite(cast(), pose(), has));
                    const bed = () => props.atlas.first([cropSprite(taken().plot.crop), "plot-seeded"]);
                    const visit = () => go(router.navigate, h().id);
                    return (
                      <>
                        <Placed sp={bed()} foot={foot()} scale={s()} onClick={visit} tip={tip()} label={t("web.project.map.plot", { name: h().name })}>
                          <Art sp={bed()} scale={s()} />
                        </Placed>
                        <Placed
                          sp={body()}
                          foot={{ x: foot().x + sessionInPlot.x, y: foot().y + sessionInPlot.y }}
                          scale={s()}
                          onClick={visit}
                          tip={tip()}
                          label={h().name}
                        >
                          <PoseSprite cast={cast()} pose={pose()} height={body().h * s()} />
                        </Placed>
                        <Show when={taken().plot.badge}>
                          {(badge) => (
                            <span
                              class="pointer-events-none absolute -translate-x-1/2"
                              style={{ left: `${foot().x * s()}px`, top: `${(foot().y - 3) * s()}px` }}
                            >
                              <PixelCard
                                paper={badgeColors[badge().tone][0]}
                                ink={badgeColors[badge().tone][1]}
                                padX={4}
                                padY={1}
                                rows={[[{ kind: "words", text: badge().text, size: 10 }]]}
                              />
                            </span>
                          )}
                        </Show>
                      </>
                    );
                  }}
                </Match>
                <Match when={spot().kind === "open"}>
                  <Placed
                    sp={props.atlas.get("plot-empty")}
                    foot={foot()}
                    scale={s()}
                    onClick={props.onSow}
                    tip={tip()}
                    label={t("web.project.map.open", { project: props.island.project })}
                  >
                    <Art sp={props.atlas.get("plot-empty")} scale={s()} />
                  </Placed>
                  <Placed sp={props.atlas.get("map-stake")} foot={{ x: foot().x + 9, y: foot().y - 12 }} scale={s()} onClick={props.onSow} tip={tip()}>
                    <Art sp={props.atlas.get("map-stake")} scale={s()} />
                  </Placed>
                </Match>
                <Match when={spot().kind === "shut"}>
                  <Placed sp={props.atlas.get("plot-locked")} foot={foot()} scale={s()} tip={tip()} label={t("web.project.map.wait")}>
                    <Art sp={props.atlas.get("plot-locked")} scale={s()} />
                  </Placed>
                </Match>
              </Switch>
            );
          }}
        </For>
        <For each={sacks()}>
          {(item, i) => {
            const foot = () => ({ x: gate().x + 16 + i() * 13, y: gate().y + 15 });
            const sack = () => props.atlas.get("map-sack");
            return (
              <>
                <Placed
                  sp={sack()}
                  foot={foot()}
                  scale={s()}
                  onClick={() => go(router.navigate, item.id)}
                  tip={t("web.project.map.queuedTip", { title: item.title })}
                  label={t("web.project.map.queuedLabel", { title: item.title })}
                >
                  <Art sp={sack()} scale={s()} />
                </Placed>
                <Show when={i() === sacks().length - 1 && props.island.queued.length > sacks().length}>
                  <span class="pointer-events-none absolute" style={{ left: `${(foot().x + 6) * s()}px`, top: `${(foot().y - 20) * s()}px` }}>
                    <PixelCard padX={3} padY={0} rows={[[{ kind: "words", text: `+${props.island.queued.length - sacks().length}`, size: 10 }]]} />
                  </span>
                </Show>
              </>
            );
          }}
        </For>
      </div>
      <button
        type="button"
        data-testid="enter-island"
        data-key={props.island.project}
        onClick={enter}
        aria-label={t("web.project.map.enter", { project: props.island.project })}
        class="group cursor-pointer"
      >
        <PixelCard
          center
          maxWidth={pic().w * s() - 24}
          maxLines={1}
          rows={[
            [{ kind: "words", text: props.island.project, size: 14 }],
            [{ kind: "words", text: islandText(props.island), color: CardColors.muted }],
            [
              { kind: "words", text: t("web.project.map.enterWord"), color: CardColors.good },
              ...(props.atlas.has("button-next") ? [{ kind: "icon" as const, sprite: props.atlas.get("button-next"), px: 12 }] : []),
            ],
          ]}
        />
      </button>
    </div>
  );
}

function Homeless(props: { sessions: Session[] }) {
  const router = useRouter();
  return (
    <div class="mx-auto mt-4 flex w-fit flex-wrap items-center gap-2 rounded-lg border border-line bg-page px-3 py-2">
      <span class="text-xs text-muted">{t("web.project.map.homeless")}</span>
      <For each={props.sessions}>
        {(h) => (
          <button type="button" onClick={() => go(router.navigate, h.id)} class="flex cursor-pointer items-center gap-1 text-sm underline">
            <AgentFace agentId={h.agent} runtime={h.runtime} size={20} />
            {h.name}
          </button>
        )}
      </For>
    </div>
  );
}

function NoProjects() {
  return (
    <div class="mx-auto flex w-fit flex-col items-center gap-3 rounded-lg border border-line bg-page p-4">
      <p class="text-sm text-muted">{t("web.project.map.sea")}</p>
    </div>
  );
}

/** A job for this project: sent now (the orchestrator sends a helper), or written down as a todo to fill in. */
function SowHere(props: { project: string; onDone: () => void }) {
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const router = useRouter();
  const core = useCore();
  const send = async () => {
    const project = props.project;
    const id = defaultOf(core()?.chat)?.id;
    if (!id) return;
    setBusy(true);
    try {
      await api.channel.message.send({ id, text: text().trim(), project, sendKey: newSendKey() });
      props.onDone();
    } catch (e) {
      toast(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  const write = async () => {
    const project = props.project;
    setBusy(true);
    try {
      const got = await writeIssue(text(), "", project);
      if (got.refused) toast(t("web.project.map.notDrafted", { why: got.refused }));
      props.onDone();
      go(router.navigate, got.issue.id);
    } catch (e) {
      toast(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="flex flex-col gap-3">
      <p class="text-sm text-muted">{t("web.project.map.sowIntro", { project: props.project })}</p>
      <TextArea
        ref={autofocus()}
        aria-label={t("web.project.map.job")}
        rows={4}
        placeholder={t("web.project.map.jobExample")}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <div class="flex justify-end gap-2">
        <Button disabled={busy() || !text().trim()} onClick={() => void write()}>
          {t("web.project.map.todo")}
        </Button>
        <Button tone="primary" disabled={busy() || !text().trim()} onClick={() => void send()}>
          {t("web.project.map.sow")}
        </Button>
      </div>
    </div>
  );
}

/** One island: its worktrees, the room left, what waits. */
export function IslandDetail(props: { island: Island }) {
  const router = useRouter();
  const now = () => Date.now();
  const last = () => props.island.summary?.last;
  const growth = () => growthOf(last(), now());
  const shut = () => props.island.spots.filter((s) => s.kind === "shut").length;
  const taken = () => props.island.spots.flatMap((s) => (s.kind === "taken" ? [s] : []));
  const open = () => openOf(props.island);
  return (
    <Card title={props.island.project} action={<span class="text-sm text-muted">{islandText(props.island)}</span>}>
      <div class="flex items-center gap-2.5">
        <SpriteIcon name={`plot-${growth().crop}`} size={36} />
        <p class="text-sm text-muted">
          {!props.island.summary
            ? t("web.project.map.gone")
            : last() !== undefined
              ? t("web.project.map.growthSince", { label: growth().label, since: since(last()!, now()) })
              : t("web.project.map.growth", { label: growth().label })}
        </p>
      </div>
      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-semibold text-muted">{t("web.project.map.worktrees", { n: taken().length })}</span>
        <Show when={taken().length > 0} fallback={<Quiet>{t("web.project.map.noHelpers")}</Quiet>}>
          <For each={taken()}>
            {(slot) => (
              <button
                type="button"
                onClick={() => go(router.navigate, slot.session.id)}
                aria-label={t("shared.join.labeled", { label: slot.session.name, text: phaseText(slot.session, now()) })}
                class="flex cursor-pointer items-center gap-2 rounded-md p-1.5 text-left hover:bg-hover"
              >
                <AgentFace agentId={slot.session.agent} runtime={slot.session.runtime} size={32} />
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="text-sm font-medium">{slot.session.name}</span>
                  <span class="line-clamp-2 text-xs text-muted">{phaseText(slot.session, now())}</span>
                  <Show when={slot.session.branch}>
                    <span class="flex items-center gap-1 font-mono text-xs text-muted">
                      <SpriteIcon name="icon-branch" size={14} />
                      <span class="truncate">{slot.session.branch}</span>
                    </span>
                  </Show>
                </span>
                <SpriteIcon name={cropSprite(slot.plot.crop)} size={32} />
              </button>
            )}
          </For>
        </Show>
      </div>
      <div class="flex items-center gap-2">
        <SpriteIcon name={open() > 0 ? "map-stake" : "plot-locked"} size={24} />
        <p class="text-sm text-muted">
          {!props.island.summary
            ? t("web.project.map.noMore")
            : open() > 0
              ? t("web.project.map.canSend", { n: open(), of: props.island.maxSessions })
              : shut() > 0
                ? t("web.project.map.shut", { n: maxRunning })
                : t("web.project.map.full", { n: props.island.maxSessions })}
        </p>
      </div>
      <Show when={props.island.queued.length > 0}>
        <div class="flex flex-col gap-1">
          <span class="text-xs font-semibold text-muted">{t("web.project.map.queue", { n: props.island.queued.length })}</span>
          <For each={props.island.queued}>
            {(item) => (
              <div class="flex items-center gap-2">
                <SpriteIcon name="map-sack" size={20} />
                <span class="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                <button
                  type="button"
                  title={t("web.project.map.see")}
                  aria-label={t("web.project.map.see")}
                  onClick={() => go(router.navigate, item.id)}
                  class="cursor-pointer rounded p-1 hover:bg-hover"
                >
                  <SpriteIcon name="button-open" size={14} />
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </Card>
  );
}
