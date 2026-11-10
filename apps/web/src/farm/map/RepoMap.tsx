import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, For, Match, onSettled, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Agent, maxRunning, type Session } from "@vibevalley/protocol";
import { defaultOf, phaseText } from "@vibevalley/protocol/rules";

import { variant, autofocus } from "#/base/dom.tsx";
import { useInterval } from "#/base/timer.ts";
import { chatSay } from "#/features/channel/index.ts";
import { writeIssue } from "#/features/issue/index.ts";
import { type ReposSkin, since } from "#/features/repo/index.ts";
import { createRequestKey } from "#/infra/api.ts";
import { useCore, useFrames } from "#/infra/frame.ts";
import { ready, useAgents, useRepos } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { sendOnce, useIntents } from "#/state/intent.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { castOf, castSprite, cropSprite } from "#/ui/cast.ts";
import { Dialog } from "#/ui/Dialog.tsx";
import { AgentFace } from "#/ui/Face.tsx";
import { TextArea } from "#/ui/Field.tsx";
import { Card, Quiet } from "#/ui/layout.tsx";
import { type SpriteAtlas, type SpriteInfo, useAtlas } from "#/ui/pixel/atlas.ts";
import { PixelCard, SpriteIcon } from "#/ui/pixel/index.ts";
import { badgeColors, CardColors } from "#/ui/pixel/PixelCard.tsx";
import { PoseSprite } from "#/ui/PoseSprite.tsx";
import { styleProps } from "#/ui/positioner.ts";
import { toast } from "#/ui/toasts.ts";

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
  spotText,
} from "./islands";

const styles = stylex.create({
  enterIsland: { cursor: "pointer" },
  repoMapArt: {
    pointerEvents: "none",
    position: "absolute",
    right: "calc(var(--spacing) * 4)",
    bottom: "calc(var(--spacing) * 4)",
    opacity: ".8",
  },
  cloudsArt: {
    position: "absolute",
    opacity: ".55",
  },
  islandViewArt: {
    marginInline: "auto",
    display: "block",
  },
  islandDetailSpan: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
  },
  islandDetailSpan2: {
    WebkitLineClamp: "2",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  art: { maxWidth: "none", imageRendering: "pixelated" },
  repoMapDiv: {
    display: "flex",
    height: "100%",
    minHeight: "0",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
  },
  repoMapDiv2: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "calc(var(--spacing) * 5)",
    rowGap: "calc(var(--spacing) * 1.5)",
  },
  repoMapSpan: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-medium)",
  },
  repoMapSpan2: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: "calc(var(--spacing) * 4)",
    rowGap: "var(--spacing)",
  },
  repoMapSpan3: {
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  repoMapDiv3: {
    backgroundColor: "var(--color-px-map-paper)",
    position: "relative",
    minHeight: "0",
    flex: "1",
    overflow: "hidden",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
  },
  repoMapDiv4: {
    position: "absolute",
    inset: "0",
    overflowY: "auto",
    padding: "calc(var(--spacing) * 4)",
  },
  repoMapDiv5: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
  },
  gridDiv: {
    pointerEvents: "none",
    position: "absolute",
    inset: "0",
  },
  gridDiv2: {
    position: "absolute",
    inset: "0",
  },
  gridColumns: {
    backgroundImage: "repeating-linear-gradient(to right, transparent 0 62px, var(--color-px-map-grid) 62px 64px)",
    maskImage: "repeating-linear-gradient(to bottom, black 0 4px, transparent 4px 8px)",
  },
  gridRows: {
    backgroundImage: "repeating-linear-gradient(to bottom, transparent 0 62px, var(--color-px-map-grid) 62px 64px)",
    maskImage: "repeating-linear-gradient(to right, black 0 4px, transparent 4px 8px)",
  },
  placedSpan: {
    position: "absolute",
  },
  placedButton: {
    position: "absolute",
    cursor: "pointer",
  },
  islandViewDiv: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  islandViewDiv2: {
    position: "relative",
  },
  island: {
    position: "absolute",
    insetInline: "0",
    bottom: "0",
    cursor: "pointer",
  },
  islandViewSpan: {
    pointerEvents: "none",
    position: "absolute",
    translate: "calc(calc(1 / 2 * 100%) * -1) 0",
  },
  islandViewSpan2: {
    pointerEvents: "none",
    position: "absolute",
  },
  homelessDiv: {
    marginInline: "auto",
    marginTop: "calc(var(--spacing) * 4)",
    display: "flex",
    width: "fit-content",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
  },
  homelessSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  homelessButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "var(--spacing)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    textDecorationLine: "underline",
  },
  noReposDiv: {
    marginInline: "auto",
    display: "flex",
    width: "fit-content",
    flexDirection: "column",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    padding: "calc(var(--spacing) * 4)",
  },
  noReposP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  sowHereDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  sowHereDiv2: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "calc(var(--spacing) * 2)",
  },
  islandDetailDiv: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2.5)",
  },
  islandDetailDiv2: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
  },
  islandDetailSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  islandDetailButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    padding: "calc(var(--spacing) * 1.5)",
    textAlign: "left",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  islandDetailSpan22: {
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  islandDetailSpan32: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  islandDetailDiv3: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  islandDetailDiv4: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing)",
  },
  islandDetailSpan4: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  islandDetailButton2: {
    cursor: "pointer",
    borderRadius: ".25rem",
    padding: "var(--spacing)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
});

const gap = 24;

/** The islands as the farm stands now. */
function useIslands(): () => Island[] {
  const core = useCore();
  const frames = useFrames();
  const repos = useRepos();
  return createMemo(() =>
    islandsOf({ repos: ready(repos, []), sessions: core()?.sessions ?? [], plots: frames.frame?.view.plots ?? {}, issues: core()?.issues ?? [] }),
  );
}

const go = (navigate: (to: string) => void, id: string) => navigate(`/issues/${encodeURIComponent(id)}`);

function RepoMap() {
  const atlas = useAtlas();
  const islands = useIslands();
  const repos = useRepos();
  const loading = () => !ready(repos, undefined);
  const core = useCore();
  const [sowing, setSowing] = createSignal<string>();
  const [width, setWidth] = createSignal(0);
  let box: HTMLDivElement | undefined;
  onSettled(() => {
    const el = box;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
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
    <div {...stylex.attrs(styles.repoMapDiv)}>
      <div {...stylex.attrs(styles.repoMapDiv2)}>
        <span {...stylex.attrs(styles.repoMapSpan)}>
          {[
            t("web.farm.map.islands", { n: islands().length }),
            t("web.farm.map.peopled", { n: tally().peopled }),
            t("web.farm.map.working", { n: tally().working, of: maxRunning }),
            ...(tally().queued > 0 ? [t("web.farm.map.queued", { n: tally().queued })] : []),
          ].join(" · ")}
        </span>
        <span {...stylex.attrs(styles.repoMapSpan2)}>
          <For
            each={
              [
                ["map-stake", t("web.farm.map.stake")],
                ["plot-locked", t("web.farm.map.locked")],
                ["map-sack", t("web.farm.map.sack")],
              ] as const
            }
          >
            {([icon, words]) => (
              <span {...stylex.attrs(styles.repoMapSpan3)}>
                <SpriteIcon name={icon} size={18} />
                {words}
              </span>
            )}
          </For>
        </span>
      </div>
      <div ref={(el) => (box = el)} {...stylex.attrs(styles.repoMapDiv3)}>
        <Grid />
        <Show when={atlas()}>{(a) => <Clouds atlas={a()} />}</Show>
        <Show when={atlas()?.has("map-compass") === true && width() >= 700 ? atlas() : undefined}>
          {(a) => <Art sp={a().get("map-compass")} scale={1.5} styles={[styles.repoMapArt]} />}
        </Show>
        <div {...stylex.attrs(styles.repoMapDiv4)}>
          <Switch
            fallback={
              // Keyed by the atlas, loaded once: a plain value, so the islands' queries never read a closed branch.
              <Show when={atlas()} keyed>
                {(a) => (
                  <div {...stylex.attrs(styles.repoMapDiv5)} style={{ gap: `${gap}px` }}>
                    <For each={islands()} keyed={(i) => i.repo}>
                      {(i) => (
                        <div style={{ width: `${cell().w * scale()}px` }}>
                          <IslandView island={i()} atlas={a} scale={scale()} cellHeight={cell().h} onSow={() => setSowing(i().repo)} />
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </Show>
            }
          >
            <Match when={!atlas() || (loading() && islands().length === 0)}>
              <Quiet>{t("web.farm.map.finding")}</Quiet>
            </Match>
            <Match when={islands().length === 0}>
              <NoRepos />
            </Match>
          </Switch>
          <Show when={stray().length > 0}>
            <Homeless sessions={stray()} />
          </Show>
        </div>
      </div>
      <Dialog open={sowing() !== undefined} onClose={() => setSowing(undefined)} title={t("web.farm.map.send", { repo: sowing() ?? "" })}>
        <Show when={sowing()}>{(p) => <SowHere repo={p()} onDone={() => setSowing(undefined)} />}</Show>
      </Dialog>
    </div>
  );
}

/** A dashed line every 64 px, as the parchment's grid. */
function Grid() {
  return (
    <div {...stylex.attrs(styles.gridDiv)}>
      <div {...styleProps([styles.gridDiv2, styles.gridColumns])} />
      <div {...styleProps([styles.gridDiv2, styles.gridRows])} />
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
  const start = performance.now();
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  useInterval(() => !still && setT((performance.now() - start) / 1000), 100);
  return (
    <Show when={props.atlas.has("map-cloud") ? props.atlas.get("map-cloud") : undefined}>
      {(cloud) => {
        const span = () => (box?.clientWidth ?? 800) + cloud().w * 4;
        return (
          <div ref={(el) => (box = el)} {...stylex.attrs(styles.gridDiv)}>
            <For each={clouds}>
              {([y, from, speed]) => (
                <Art
                  sp={cloud()}
                  scale={2}
                  styles={[styles.cloudsArt]}
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

function Art(props: { sp: SpriteInfo; scale: number; styles?: stylex.StyleXStyles; style?: JSX.CSSProperties }) {
  return (
    <img
      src={props.sp.url}
      alt=""
      draggable="false"
      {...styleProps([styles.art, props.styles], { width: `${props.sp.w * props.scale}px`, height: `${props.sp.h * props.scale}px`, ...props.style })}
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
        <span title={props.tip} aria-label={props.label} {...stylex.attrs(styles.placedSpan)} style={style()}>
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
          {...stylex.attrs(styles.placedButton)}
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
  const pic = () => props.atlas.first([islandLook(props.island.repo), ...islandLooks]);
  const yard = () => {
    const y = pic().yard;
    return y
      ? { left: y.x0, top: y.y0, width: y.x1 - y.x0, height: y.y1 - y.y0 }
      : { left: pic().w * 0.25, top: pic().h * 0.25, width: pic().w * 0.5, height: pic().h * 0.4 };
  };
  const at = () => plotsIn(yard(), props.island.spots.length);
  const down = () => props.cellHeight - pic().h;
  const open = () => router.navigate(`/repos/${encodeURIComponent(props.island.repo)}`);
  const enter = () => router.navigate(`/farm/${encodeURIComponent(props.island.repo)}`);
  const has = (n: string) => props.atlas.has(n);
  const s = () => props.scale;
  const gate = () => ({ x: yard().left + yard().width / 2, y: yard().top + yard().height + down() });
  const sacks = () => props.island.queued.slice(0, 3);
  return (
    <div {...stylex.attrs(styles.islandViewDiv)}>
      <div {...stylex.attrs(styles.islandViewDiv2)} style={{ width: `${pic().w * s()}px`, height: `${props.cellHeight * s()}px` }}>
        <button
          type="button"
          data-testid="island"
          data-key={props.island.repo}
          aria-label={t("shared.join.labeled", { label: props.island.repo, text: islandText(props.island) })}
          onClick={open}
          {...stylex.attrs(styles.island)}
        >
          <Art sp={pic()} scale={s()} styles={[styles.islandViewArt]} />
        </button>
        <For each={props.island.spots} keyed={false}>
          {(spot, i) => {
            const foot = () => {
              const p = at()[i] ?? { x: 0, y: 0 };
              return { x: p.x, y: p.y + down() };
            };
            const tip = () => spotText(spot(), Date.now());
            return (
              <Switch>
                <Match when={variant(spot(), "kind", "taken")}>
                  {(taken) => {
                    const h = () => taken().session;
                    const cast = () => castOf(agents().get(h().agent)?.look, h().agent);
                    const pose = () => mapPose(h(), taken().issue?.conflict !== undefined);
                    const body = () => props.atlas.get(castSprite(cast(), pose(), has));
                    const bed = () => props.atlas.first([cropSprite(taken().plot.crop), "plot-seeded"]);
                    const visit = () => go(router.navigate, h().id);
                    return (
                      <>
                        <Placed sp={bed()} foot={foot()} scale={s()} onClick={visit} tip={tip()} label={t("web.farm.map.plot", { name: h().name })}>
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
                            <span {...stylex.attrs(styles.islandViewSpan)} style={{ left: `${foot().x * s()}px`, top: `${(foot().y - 3) * s()}px` }}>
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
                    label={t("web.farm.map.open", { repo: props.island.repo })}
                  >
                    <Art sp={props.atlas.get("plot-empty")} scale={s()} />
                  </Placed>
                  <Placed sp={props.atlas.get("map-stake")} foot={{ x: foot().x + 9, y: foot().y - 12 }} scale={s()} onClick={props.onSow} tip={tip()}>
                    <Art sp={props.atlas.get("map-stake")} scale={s()} />
                  </Placed>
                </Match>
                <Match when={spot().kind === "shut"}>
                  <Placed sp={props.atlas.get("plot-locked")} foot={foot()} scale={s()} tip={tip()} label={t("web.farm.map.wait")}>
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
                  tip={t("web.farm.map.queuedTip", { title: item.title })}
                  label={t("web.farm.map.queuedLabel", { title: item.title })}
                >
                  <Art sp={sack()} scale={s()} />
                </Placed>
                <Show when={i() === sacks().length - 1 && props.island.queued.length > sacks().length}>
                  <span {...stylex.attrs(styles.islandViewSpan2)} style={{ left: `${(foot().x + 6) * s()}px`, top: `${(foot().y - 20) * s()}px` }}>
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
        data-key={props.island.repo}
        onClick={enter}
        aria-label={t("web.farm.map.enter", { repo: props.island.repo })}
        {...styleProps(styles.enterIsland)}
      >
        <PixelCard
          center
          maxWidth={pic().w * s() - 24}
          maxLines={1}
          rows={[
            [{ kind: "words", text: props.island.repo, size: 14 }],
            [{ kind: "words", text: islandText(props.island), color: CardColors.muted }],
            [
              { kind: "words", text: t("web.farm.map.enterWord"), color: CardColors.good },
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
    <div {...stylex.attrs(styles.homelessDiv)}>
      <span {...stylex.attrs(styles.homelessSpan)}>{t("web.farm.map.homeless")}</span>
      <For each={props.sessions}>
        {(h) => (
          <button type="button" onClick={() => go(router.navigate, h.id)} {...stylex.attrs(styles.homelessButton)}>
            <AgentFace agentId={h.agent} runtime={h.runtime} size={20} />
            {h.name}
          </button>
        )}
      </For>
    </div>
  );
}

function NoRepos() {
  return (
    <div {...stylex.attrs(styles.noReposDiv)}>
      <p {...stylex.attrs(styles.noReposP)}>{t("web.farm.map.sea")}</p>
    </div>
  );
}

/** Work for this repo: sent now (the orchestrator sends a helper), or written down as a todo to fill in. */
function SowHere(props: { repo: string; onDone: () => void }) {
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const writing = createAct();
  const busy = () => sending() || writing.busy();
  const router = useRouter();
  const core = useCore();
  const says = useIntents(chatSay);
  // A line in the default channel, which shows it on its way; pressed again after a failure it is the same line.
  const send = async () => {
    const id = defaultOf(core()?.chat)?.id;
    if (!id) return;
    setSending(true);
    const end = await sendOnce(says, { id, text: text().trim(), repo: props.repo });
    setSending(false);
    if (end?.phase === "failed") toast(end.fault.reason, "bad");
    else props.onDone();
  };
  // The same key until the issue went in: a retry after a lost reply is that issue, not a second.
  const key = createRequestKey();
  const write = () => {
    const repo = props.repo;
    const words = text();
    const done = props.onDone;
    return writing.run(async () => {
      const got = await writeIssue(words, "", repo, key.now());
      key.used();
      if (got.refused) toast(t("web.farm.map.notDrafted", { why: got.refused }));
      done();
      go(router.navigate, got.issue.id);
    });
  };
  return (
    <div {...stylex.attrs(styles.sowHereDiv)}>
      <p {...stylex.attrs(styles.noReposP)}>{t("web.farm.map.sowIntro", { repo: props.repo })}</p>
      <TextArea
        ref={autofocus()}
        aria-label={t("web.farm.map.job")}
        rows={4}
        placeholder={t("web.farm.map.jobExample")}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <div {...stylex.attrs(styles.sowHereDiv2)}>
        <Button disabled={busy() || !text().trim()} onClick={() => void write()}>
          {t("web.farm.map.todo")}
        </Button>
        <Button tone="primary" disabled={busy() || !text().trim()} onClick={() => void send()}>
          {t("web.farm.map.sow")}
        </Button>
      </div>
    </div>
  );
}

/** One island: its worktrees, the room left, what waits. */
function IslandDetail(props: { island: Island }) {
  const router = useRouter();
  const now = () => Date.now();
  const last = () => props.island.summary?.last;
  const growth = () => growthOf(last(), now());
  const growthText = () => {
    const at = last();
    if (!props.island.summary) return t("web.farm.map.gone");
    return at !== undefined
      ? t("web.farm.map.growthSince", { label: growth().label, since: since(at, now()) })
      : t("web.farm.map.growth", { label: growth().label });
  };
  const shut = () => props.island.spots.filter((s) => s.kind === "shut").length;
  const taken = () => props.island.spots.flatMap((s) => (s.kind === "taken" ? [s] : []));
  const open = () => openOf(props.island);
  return (
    <Card title={props.island.repo} action={<span {...stylex.attrs(styles.noReposP)}>{islandText(props.island)}</span>}>
      <div {...stylex.attrs(styles.islandDetailDiv)}>
        <SpriteIcon name={`plot-${growth().crop}`} size={36} />
        <p {...stylex.attrs(styles.noReposP)}>{growthText()}</p>
      </div>
      <div {...stylex.attrs(styles.islandDetailDiv2)}>
        <span {...stylex.attrs(styles.islandDetailSpan3)}>{t("web.farm.map.worktrees", { n: taken().length })}</span>
        <Show when={taken().length > 0} fallback={<Quiet>{t("web.farm.map.noHelpers")}</Quiet>}>
          <For each={taken()}>
            {(slot) => (
              <button
                type="button"
                onClick={() => go(router.navigate, slot.session.id)}
                aria-label={t("shared.join.labeled", { label: slot.session.name, text: phaseText(slot.session, now()) })}
                {...stylex.attrs(styles.islandDetailButton)}
              >
                <AgentFace agentId={slot.session.agent} runtime={slot.session.runtime} size={32} />
                <span {...stylex.attrs(styles.islandDetailSpan)}>
                  <span {...stylex.attrs(styles.repoMapSpan)}>{slot.session.name}</span>
                  <span {...stylex.attrs(styles.islandDetailSpan2)}>{phaseText(slot.session, now())}</span>
                  <Show when={slot.session.branch}>
                    <span {...stylex.attrs(styles.islandDetailSpan22)}>
                      <SpriteIcon name="icon-branch" size={14} />
                      <span {...stylex.attrs(styles.islandDetailSpan32)}>{slot.session.branch}</span>
                    </span>
                  </Show>
                </span>
                <SpriteIcon name={cropSprite(slot.plot.crop)} size={32} />
              </button>
            )}
          </For>
        </Show>
      </div>
      <div {...stylex.attrs(styles.islandDetailDiv3)}>
        <SpriteIcon name={open() > 0 ? "map-stake" : "plot-locked"} size={24} />
        <p {...stylex.attrs(styles.noReposP)}>
          {!props.island.summary
            ? t("web.farm.map.noMore")
            : open() > 0
              ? t("web.farm.map.canSend", { n: open(), of: props.island.maxSessions })
              : shut() > 0
                ? t("web.farm.map.shut", { n: maxRunning })
                : t("web.farm.map.full", { n: props.island.maxSessions })}
        </p>
      </div>
      <Show when={props.island.queued.length > 0}>
        <div {...stylex.attrs(styles.islandDetailDiv4)}>
          <span {...stylex.attrs(styles.islandDetailSpan3)}>{t("web.farm.map.queue", { n: props.island.queued.length })}</span>
          <For each={props.island.queued}>
            {(item) => (
              <div {...stylex.attrs(styles.islandDetailDiv3)}>
                <SpriteIcon name="map-sack" size={20} />
                <span {...stylex.attrs(styles.islandDetailSpan4)}>{item.title}</span>
                <button
                  type="button"
                  title={t("web.farm.map.see")}
                  aria-label={t("web.farm.map.see")}
                  onClick={() => go(router.navigate, item.id)}
                  {...stylex.attrs(styles.islandDetailButton2)}
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

function IslandHead(props: { name: string }) {
  const islands = useIslands();
  const island = () => islands().find((i) => i.repo === props.name);
  return <Show when={island()}>{(i) => <IslandDetail island={i()} />}</Show>;
}

export const repoMap: ReposSkin = { Map: RepoMap, Head: IslandHead, picture: islandLook };
