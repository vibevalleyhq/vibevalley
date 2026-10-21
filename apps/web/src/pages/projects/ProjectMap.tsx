// The map: every project an island on parchment, its plots its helpers'
// worktrees, its empty plots room for more and the sacks at its gate what waits; a click opens the project, a helper's
// plot its issue, an empty plot a seed for the project.

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { type Agent, maxRunning, type Session } from "@vibevalley/protocol";
import { useAgents } from "../../data/agents";
import { reasonOf } from "../../data/api";
import { useCore, useFrames } from "../../data/frame";
import { useProjects } from "../../data/projects";
import { useFarmCommands } from "../../farm/commands";
import { badgeColors, CardColors, PixelCard } from "../../farm/kit";
import type { SpriteAtlas, SpriteInfo } from "../../farm/world/sprites";
import { useVillage } from "../../farm/world/load";
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
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { AgentFace } from "../../ui/Face";
import { TextArea } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { PoseSprite } from "../../ui/PoseSprite";
import { useToast } from "../../ui/Toast";
import { writeIssue } from "../issues/data";
import { Card, Quiet } from "../kit";
import { phaseText } from "@vibevalley/protocol/rules";

const gap = 24;
const parchment = "#ebd9ae";

/** The islands as the farm stands now. */
export function useIslands(): Island[] {
  const core = useCore();
  const view = useFrames().frame?.view;
  const projects = useProjects().data ?? [];
  return islandsOf({ projects, sessions: core?.sessions ?? [], plots: view?.plots ?? {}, issues: core?.issues ?? [] });
}

export function ProjectMap() {
  const atlas = useVillage().village?.atlas;
  const islands = useIslands();
  const loading = !useProjects().data;
  const sessions = useCore()?.sessions ?? [];
  const [sowing, setSowing] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const looks = atlas ? islandLooks.filter((l) => atlas.has(l)).map((l) => atlas.get(l)) : [];
  const cell = looks.length === 0 ? { w: 300, h: 200 } : { w: Math.max(...looks.map((l) => l.w)), h: Math.max(...looks.map((l) => l.h)) };
  const scale = islandScale(width - 32, cell.w, gap);
  const tally = mapTally(islands);
  const stray = homeless(sessions);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
        <span className="text-sm font-medium">
          {[
            `${islands.length} 座岛`,
            `${tally.peopled} 座有人`,
            `在干 ${tally.working}/${maxRunning} 块地`,
            ...(tally.queued > 0 ? [`排队 ${tally.queued}`] : []),
          ].join(" · ")}
        </span>
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          {(
            [
              ["map-stake", "空位，点了派活"],
              ["plot-locked", "农场的地都占着"],
              ["map-sack", "排队的活"],
            ] as const
          ).map(([icon, words]) => (
            <span key={icon} className="flex items-center gap-1 text-xs text-muted">
              <Icon name={icon} size={18} />
              {words}
            </span>
          ))}
        </span>
      </div>
      <div ref={box} className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-line" style={{ background: parchment }}>
        <Grid />
        {atlas && <Clouds atlas={atlas} />}
        {atlas?.has("map-compass") && width >= 700 && (
          <Art sp={atlas.get("map-compass")} scale={1.5} className="pointer-events-none absolute right-4 bottom-4 opacity-80" />
        )}
        <div className="absolute inset-0 overflow-y-auto p-4">
          {!atlas || (loading && islands.length === 0) ? (
            <Quiet>在找……</Quiet>
          ) : islands.length === 0 ? (
            <NoProjects />
          ) : (
            <div className="flex flex-wrap justify-center" style={{ gap }}>
              {islands.map((i) => (
                <div key={i.project} style={{ width: cell.w * scale }}>
                  <IslandView island={i} atlas={atlas} scale={scale} cellHeight={cell.h} onSow={() => setSowing(i.project)} />
                </div>
              ))}
            </div>
          )}
          {stray.length > 0 && <Homeless sessions={stray} />}
        </div>
      </div>
      <Dialog open={sowing !== undefined} onClose={() => setSowing(undefined)} title={`播种 · ${sowing ?? ""}`}>
        {sowing && <SowHere project={sowing} onDone={() => setSowing(undefined)} />}
      </Dialog>
    </div>
  );
}

/** A dashed line every 64 px, as the parchment's grid. */
function Grid() {
  const ink = "#c8a46e73";
  return (
    <div className="pointer-events-none absolute inset-0">
      <div
        className="absolute inset-0"
        style={{
          background: `repeating-linear-gradient(to right, transparent 0 62px, ${ink} 62px 64px)`,
          maskImage: "repeating-linear-gradient(to bottom, #000 0 4px, transparent 4px 8px)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background: `repeating-linear-gradient(to bottom, transparent 0 62px, ${ink} 62px 64px)`,
          maskImage: "repeating-linear-gradient(to right, #000 0 4px, transparent 4px 8px)",
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
function Clouds({ atlas }: { atlas: SpriteAtlas }) {
  const [t, setT] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const start = performance.now();
    const timer = setInterval(() => setT((performance.now() - start) / 1000), 100);
    return () => clearInterval(timer);
  }, []);
  if (!atlas.has("map-cloud")) return null;
  const cloud = atlas.get("map-cloud");
  const w = box.current?.clientWidth ?? 800;
  const h = box.current?.clientHeight ?? 600;
  const span = w + cloud.w * 4;
  return (
    <div ref={box} className="pointer-events-none absolute inset-0">
      {clouds.map(([y, from, speed], i) => (
        <Art
          key={i}
          sp={cloud}
          scale={2}
          className="absolute opacity-55"
          style={{ left: Math.round(((from * span + t * speed) % span) - cloud.w * 4), top: Math.round(y * h) }}
        />
      ))}
    </div>
  );
}

function Art({ sp, scale, className = "", style }: { sp: SpriteInfo; scale: number; className?: string; style?: CSSProperties }) {
  return (
    <img
      src={sp.url}
      alt=""
      draggable={false}
      className={`max-w-none [image-rendering:pixelated] ${className}`}
      style={{ width: sp.w * scale, height: sp.h * scale, ...style }}
    />
  );
}

function IslandView({
  island,
  atlas,
  scale: s,
  cellHeight,
  onSow,
}: {
  island: Island;
  atlas: SpriteAtlas;
  scale: number;
  cellHeight: number;
  onSow: () => void;
}) {
  const navigate = useNavigate();
  const agents = new Map((useAgents().data ?? []).map((a): [string, Agent] => [a.id, a]));
  const pic = atlas.first([islandLook(island.project), ...islandLooks]);
  const y = pic.yard;
  const yard = y
    ? { left: y.x0, top: y.y0, width: y.x1 - y.x0, height: y.y1 - y.y0 }
    : { left: pic.w * 0.25, top: pic.h * 0.25, width: pic.w * 0.5, height: pic.h * 0.4 };
  const at = plotsIn(yard, island.spots.length);
  const down = cellHeight - pic.h;
  const now = Date.now();
  const open = () => navigate(`/projects/${encodeURIComponent(island.project)}`);
  const has = (n: string) => atlas.has(n);
  const place = (sp: SpriteInfo, foot: { x: number; y: number }, child: ReactNode, o: { onClick?: () => void; tip?: string; label?: string } = {}) => {
    const style: CSSProperties = { left: (foot.x - sp.ax) * s, top: (foot.y - sp.ay) * s };
    return o.onClick ? (
      <button
        key={`${sp.name}${foot.x},${foot.y}`}
        type="button"
        title={o.tip}
        aria-label={o.label ?? o.tip}
        onClick={o.onClick}
        className="absolute cursor-pointer"
        style={style}
      >
        {child}
      </button>
    ) : (
      <span key={`${sp.name}${foot.x},${foot.y}`} title={o.tip} aria-label={o.label} className="absolute" style={style}>
        {child}
      </span>
    );
  };
  const layers: ReactNode[] = [];
  island.spots.forEach((spot, i) => {
    const foot = { x: at[i]!.x, y: at[i]!.y + down };
    const tip = spotText(spot, now);
    if (spot.kind === "taken") {
      const h = spot.session;
      const go = () => navigate(`/issues/${encodeURIComponent(h.id)}`);
      const cast = castOf(agents.get(h.agent)?.look, h.agent);
      const pose = mapPose(h);
      const body = atlas.get(castSprite(cast, pose, has));
      const bed = atlas.first([cropSprite(spot.plot.crop), "plot-seeded"]);
      layers.push(place(bed, foot, <Art sp={bed} scale={s} />, { onClick: go, tip, label: `${h.name}的地` }));
      layers.push(
        place(body, { x: foot.x + sessionInPlot.x, y: foot.y + sessionInPlot.y }, <PoseSprite cast={cast} pose={pose} height={body.h * s} />, {
          onClick: go,
          tip,
          label: h.name,
        }),
      );
      const badge = spot.plot.badge;
      if (badge) {
        const [paper, ink] = badgeColors[badge.tone];
        layers.push(
          <span key={`badge${h.id}`} className="pointer-events-none absolute -translate-x-1/2" style={{ left: foot.x * s, top: (foot.y - 3) * s }}>
            <PixelCard paper={paper} ink={ink} padX={4} padY={1} rows={[[{ kind: "words", text: badge.text, size: 10 }]]} />
          </span>,
        );
      }
    } else if (spot.kind === "open") {
      const empty = atlas.get("plot-empty");
      const stake = atlas.get("map-stake");
      layers.push(place(empty, foot, <Art sp={empty} scale={s} />, { onClick: onSow, tip, label: `空位，派一件活到 ${island.project}` }));
      layers.push(place(stake, { x: foot.x + 9, y: foot.y - 12 }, <Art sp={stake} scale={s} />, { onClick: onSow, tip }));
    } else {
      const locked = atlas.get("plot-locked");
      layers.push(place(locked, foot, <Art sp={locked} scale={s} />, { tip, label: "等地" }));
    }
  });
  const gate = { x: yard.left + yard.width / 2, y: yard.top + yard.height + down };
  const sacks = island.queued.slice(0, 3);
  sacks.forEach((item, i) => {
    const sack = atlas.get("map-sack");
    const foot = { x: gate.x + 16 + i * 13, y: gate.y + 15 };
    layers.push(
      place(sack, foot, <Art sp={sack} scale={s} />, {
        onClick: () => navigate(`/issues/${encodeURIComponent(item.id)}`),
        tip: `排队：${item.title}`,
        label: `排队的活：${item.title}`,
      }),
    );
    if (i === sacks.length - 1 && island.queued.length > sacks.length)
      layers.push(
        <span key="more" className="pointer-events-none absolute" style={{ left: (foot.x + 6) * s, top: (foot.y - 20) * s }}>
          <PixelCard padX={3} padY={0} rows={[[{ kind: "words", text: `+${island.queued.length - sacks.length}`, size: 10 }]]} />
        </span>,
      );
  });
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative" style={{ width: pic.w * s, height: cellHeight * s }}>
        <button type="button" aria-label={`${island.project}：${islandText(island)}`} onClick={open} className="absolute inset-x-0 bottom-0 cursor-pointer">
          <Art sp={pic} scale={s} className="mx-auto block" />
        </button>
        {layers}
      </div>
      <button type="button" onClick={open} aria-label={island.project} className="group cursor-pointer">
        <PixelCard
          center
          maxWidth={pic.w * s - 24}
          maxLines={1}
          rows={[
            [{ kind: "words", text: island.project, size: 14 }],
            [{ kind: "words", text: islandText(island), color: CardColors.muted }],
            [
              { kind: "words", text: "进岛", color: CardColors.good },
              ...(atlas.has("button-next") ? [{ kind: "icon" as const, sprite: atlas.get("button-next"), px: 12 }] : []),
            ],
          ]}
        />
      </button>
    </div>
  );
}

function Homeless({ sessions }: { sessions: Session[] }) {
  const navigate = useNavigate();
  return (
    <div className="mx-auto mt-4 flex w-fit flex-wrap items-center gap-2 rounded-lg border border-line bg-page px-3 py-2">
      <span className="text-xs text-muted">不在哪个项目里：</span>
      {sessions.map((h) => (
        <button
          key={h.id}
          type="button"
          onClick={() => navigate(`/issues/${encodeURIComponent(h.id)}`)}
          className="flex cursor-pointer items-center gap-1 text-sm underline"
        >
          <AgentFace agentId={h.agent} size={20} />
          {h.name}
        </button>
      ))}
    </div>
  );
}

function NoProjects() {
  return (
    <div className="mx-auto flex w-fit flex-col items-center gap-3 rounded-lg border border-line bg-page p-4">
      <p className="text-sm text-muted">工作目录下还没有项目，地图上还是一片海。</p>
    </div>
  );
}

/** A seed for this project, no bed to choose: planted now (the manager sends a helper), or kept as a todo to fill in. */
function SowHere({ project, onDone }: { project: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const commands = useFarmCommands();
  const navigate = useNavigate();
  const toast = useToast();
  const plant = async () => {
    setBusy(true);
    try {
      await commands.plant(text.trim(), { project });
      onDone();
    } catch (e) {
      toast(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  const write = async () => {
    setBusy(true);
    try {
      const got = await writeIssue(text, "", project);
      if (got.refused) toast(`先没起草：${got.refused}`);
      onDone();
      void navigate(`/issues/${encodeURIComponent(got.issue.id)}`);
    } catch (e) {
      toast(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">种在 {project}：写一句要做的事，管家派帮工来干；或者先写成待办，看过再开工。</p>
      <TextArea aria-label="要做的事" rows={4} autoFocus placeholder="比如：登录页加一个「记住我」" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex justify-end gap-2">
        <Button disabled={busy || !text.trim()} onClick={write}>
          先写成待办
        </Button>
        <Button tone="primary" disabled={busy || !text.trim()} onClick={plant}>
          种下
        </Button>
      </div>
    </div>
  );
}

/** One island: its worktrees, the room left, what waits. */
export function IslandDetail({ island }: { island: Island }) {
  const navigate = useNavigate();
  const now = Date.now();
  const last = island.summary?.last;
  const growth = growthOf(last, now);
  const shut = island.spots.filter((s) => s.kind === "shut").length;
  const taken = island.spots.flatMap((s) => (s.kind === "taken" ? [s] : []));
  const open = openOf(island);
  return (
    <Card title={island.project} action={<span className="text-sm text-muted">{islandText(island)}</span>}>
      <div className="flex items-center gap-2.5">
        <Icon name={`plot-${growth.crop}`} size={36} />
        <p className="text-sm text-muted">
          {!island.summary
            ? "工作目录里没有这个项目了，只剩还在岛上的帮工。"
            : `长势 · ${growth.label}${last !== undefined ? ` · 最近一次提交：${since(last, now)}` : ""}`}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-muted">worktree · {taken.length} 个</span>
        {taken.length === 0 ? (
          <Quiet>岛上还没有帮工：每派一件活来，就多一个 worktree。</Quiet>
        ) : (
          taken.map(({ session: h, plot }) => (
            <button
              key={h.id}
              type="button"
              onClick={() => navigate(`/issues/${encodeURIComponent(h.id)}`)}
              aria-label={`${h.name}：${phaseText(h, now)}`}
              className="flex cursor-pointer items-center gap-2 rounded-md p-1.5 text-left hover:bg-hover"
            >
              <AgentFace agentId={h.agent} size={32} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{h.name}</span>
                <span className="line-clamp-2 text-xs text-muted">{phaseText(h, now)}</span>
                {h.branch && (
                  <span className="flex items-center gap-1 font-mono text-xs text-muted">
                    <Icon name="icon-branch" size={14} />
                    <span className="truncate">{h.branch}</span>
                  </span>
                )}
              </span>
              <Icon name={cropSprite(plot.crop)} size={32} />
            </button>
          ))
        )}
      </div>
      <div className="flex items-center gap-2">
        <Icon name={open > 0 ? "map-stake" : "plot-locked"} size={24} />
        <p className="text-sm text-muted">
          {!island.summary
            ? "不再往这里派活。"
            : open > 0
              ? `还能再派 ${open} 件活，马上开工（这个项目最多同时 ${island.maxSessions} 个帮工）。`
              : shut > 0
                ? `农场的 ${maxRunning} 块地都有人在干活，派来的活先排队。`
                : `满了：${island.maxSessions} 个帮工都在干活，派来的活先排队。`}
        </p>
      </div>
      {island.queued.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted">排队 · {island.queued.length} 件</span>
          {island.queued.map((item) => (
            <div key={item.id} className="flex items-center gap-2">
              <Icon name="map-sack" size={20} />
              <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
              <button
                type="button"
                title="看这张工单"
                aria-label="看这张工单"
                onClick={() => navigate(`/issues/${encodeURIComponent(item.id)}`)}
                className="cursor-pointer rounded p-1 hover:bg-hover"
              >
                <Icon name="button-open" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
