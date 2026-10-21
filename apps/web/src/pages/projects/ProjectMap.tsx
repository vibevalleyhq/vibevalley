// The map: every project an island on parchment, its plots its helpers'
// worktrees, its empty plots room for more and the sacks at its gate what waits; a click opens the project, a helper's
// plot its issue, an empty plot a seed for the project.

import { createMemo, createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { type Agent, maxRunning, type Session } from "@vibevalley/protocol";
import { phaseText } from "@vibevalley/protocol/rules";
import { reasonOf } from "../../data/api";
import { badgeColors, CardColors } from "../../farm/kit/card";
import type { SpriteAtlas, SpriteInfo } from "../../farm/world/sprites";
import { castOf, castSprite, cropSprite } from "../../rules/cast";
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
} from "../../rules/projects";
import { toast } from "../../ui/toasts";
import { writeIssue } from "../issues/write";
import { useRouter } from "../../app/router";
import { autofocus } from "../../app/util";
import { useCore, useFrames } from "../../data/frame";
import { ready, useAgents, useProjects } from "../../data/query";
import { PixelCard } from "../../farm/kit";
import { commands } from "../../farm/state";
import { useVillage } from "../../farm/support";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { AgentFace } from "../../ui/Face";
import { TextArea } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { PoseSprite } from "../../ui/PoseSprite";
import { Card, Quiet } from "../kit";

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
  const village = useVillage();
  const atlas = () => village().village?.atlas;
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
            `${islands().length} 座岛`,
            `${tally().peopled} 座有人`,
            `在干 ${tally().working}/${maxRunning} 块地`,
            ...(tally().queued > 0 ? [`排队 ${tally().queued}`] : []),
          ].join(" · ")}
        </span>
        <span class="flex flex-wrap gap-x-4 gap-y-1">
          <For
            each={
              [
                ["map-stake", "空位，点了派活"],
                ["plot-locked", "农场的地都占着"],
                ["map-sack", "排队的活"],
              ] as const
            }
          >
            {([icon, words]) => (
              <span class="flex items-center gap-1 text-xs text-muted">
                <Icon name={icon} size={18} />
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
              <Quiet>在找……</Quiet>
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
      <Dialog open={sowing() !== undefined} onClose={() => setSowing(undefined)} title={`播种 · ${sowing() ?? ""}`}>
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
  const has = (n: string) => props.atlas.has(n);
  const s = () => props.scale;
  const gate = () => ({ x: yard().left + yard().width / 2, y: yard().top + yard().height + down() });
  const sacks = () => props.island.queued.slice(0, 3);
  return (
    <div class="flex flex-col items-center gap-1.5">
      <div class="relative" style={{ width: `${pic().w * s()}px`, height: `${props.cellHeight * s()}px` }}>
        <button
          type="button"
          aria-label={`${props.island.project}：${islandText(props.island)}`}
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
                        <Placed sp={bed()} foot={foot()} scale={s()} onClick={visit} tip={tip()} label={`${h().name}的地`}>
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
                    label={`空位，派一件活到 ${props.island.project}`}
                  >
                    <Art sp={props.atlas.get("plot-empty")} scale={s()} />
                  </Placed>
                  <Placed sp={props.atlas.get("map-stake")} foot={{ x: foot().x + 9, y: foot().y - 12 }} scale={s()} onClick={props.onSow} tip={tip()}>
                    <Art sp={props.atlas.get("map-stake")} scale={s()} />
                  </Placed>
                </Match>
                <Match when={spot().kind === "shut"}>
                  <Placed sp={props.atlas.get("plot-locked")} foot={foot()} scale={s()} tip={tip()} label="等地">
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
                  tip={`排队：${item.title}`}
                  label={`排队的活：${item.title}`}
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
      <button type="button" onClick={open} aria-label={props.island.project} class="group cursor-pointer">
        <PixelCard
          center
          maxWidth={pic().w * s() - 24}
          maxLines={1}
          rows={[
            [{ kind: "words", text: props.island.project, size: 14 }],
            [{ kind: "words", text: islandText(props.island), color: CardColors.muted }],
            [
              { kind: "words", text: "进岛", color: CardColors.good },
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
      <span class="text-xs text-muted">不在哪个项目里：</span>
      <For each={props.sessions}>
        {(h) => (
          <button type="button" onClick={() => go(router.navigate, h.id)} class="flex cursor-pointer items-center gap-1 text-sm underline">
            <AgentFace agentId={h.agent} size={20} />
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
      <p class="text-sm text-muted">工作目录下还没有项目，地图上还是一片海。</p>
    </div>
  );
}

/** A seed for this project, no bed to choose: planted now (the manager sends a helper), or kept as a todo to fill in. */
function SowHere(props: { project: string; onDone: () => void }) {
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const router = useRouter();
  const plant = async () => {
    const project = props.project;
    setBusy(true);
    try {
      await commands.plant(text().trim(), { project });
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
      if (got.refused) toast(`先没起草：${got.refused}`);
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
      <p class="text-sm text-muted">种在 {props.project}：写一句要做的事，管家派帮工来干；或者先写成待办，看过再开工。</p>
      <TextArea
        ref={autofocus()}
        aria-label="要做的事"
        rows={4}
        placeholder="比如：登录页加一个「记住我」"
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <div class="flex justify-end gap-2">
        <Button disabled={busy() || !text().trim()} onClick={() => void write()}>
          先写成待办
        </Button>
        <Button tone="primary" disabled={busy() || !text().trim()} onClick={() => void plant()}>
          种下
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
        <Icon name={`plot-${growth().crop}`} size={36} />
        <p class="text-sm text-muted">
          {!props.island.summary
            ? "工作目录里没有这个项目了，只剩还在岛上的帮工。"
            : `长势 · ${growth().label}${last() !== undefined ? ` · 最近一次提交：${since(last()!, now())}` : ""}`}
        </p>
      </div>
      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-semibold text-muted">worktree · {taken().length} 个</span>
        <Show when={taken().length > 0} fallback={<Quiet>岛上还没有帮工：每派一件活来，就多一个 worktree。</Quiet>}>
          <For each={taken()}>
            {(t) => (
              <button
                type="button"
                onClick={() => go(router.navigate, t.session.id)}
                aria-label={`${t.session.name}：${phaseText(t.session, now())}`}
                class="flex cursor-pointer items-center gap-2 rounded-md p-1.5 text-left hover:bg-hover"
              >
                <AgentFace agentId={t.session.agent} size={32} />
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="text-sm font-medium">{t.session.name}</span>
                  <span class="line-clamp-2 text-xs text-muted">{phaseText(t.session, now())}</span>
                  <Show when={t.session.branch}>
                    <span class="flex items-center gap-1 font-mono text-xs text-muted">
                      <Icon name="icon-branch" size={14} />
                      <span class="truncate">{t.session.branch}</span>
                    </span>
                  </Show>
                </span>
                <Icon name={cropSprite(t.plot.crop)} size={32} />
              </button>
            )}
          </For>
        </Show>
      </div>
      <div class="flex items-center gap-2">
        <Icon name={open() > 0 ? "map-stake" : "plot-locked"} size={24} />
        <p class="text-sm text-muted">
          {!props.island.summary
            ? "不再往这里派活。"
            : open() > 0
              ? `还能再派 ${open()} 件活，马上开工（这个项目最多同时 ${props.island.maxSessions} 个帮工）。`
              : shut() > 0
                ? `农场的 ${maxRunning} 块地都有人在干活，派来的活先排队。`
                : `满了：${props.island.maxSessions} 个帮工都在干活，派来的活先排队。`}
        </p>
      </div>
      <Show when={props.island.queued.length > 0}>
        <div class="flex flex-col gap-1">
          <span class="text-xs font-semibold text-muted">排队 · {props.island.queued.length} 件</span>
          <For each={props.island.queued}>
            {(item) => (
              <div class="flex items-center gap-2">
                <Icon name="map-sack" size={20} />
                <span class="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                <button
                  type="button"
                  title="看这张工单"
                  aria-label="看这张工单"
                  onClick={() => go(router.navigate, item.id)}
                  class="cursor-pointer rounded p-1 hover:bg-hover"
                >
                  <Icon name="button-open" size={14} />
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </Card>
  );
}
