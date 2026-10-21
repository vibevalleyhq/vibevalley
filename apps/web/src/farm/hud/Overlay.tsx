// The words over the village, at screen pixels so they stay sharp: each plot's
// card (what a click would do while pointed at, a reward, a note, its badge, its project, the level that clears it),
// what each helper is doing over its head, the manager's last words, and the yard's signs, names and counts. Words
// let clicks through to the village.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "@vibevalley/protocol";
import { useFrames } from "../../data/frame";
import { badgeColors, CardColors, PixelCard, plainText, type Piece } from "../kit";
import { farmState, useFarm } from "../store";
import { aimTool } from "../tools";
import { yardPlaces } from "../world/places";
import { beds, lockedPlot, plotOf, sessionAtStation, stationOfSession } from "../world/plots";
import { useVillage } from "../world/load";
import { plotH } from "../world/world";
import { doingOf, harvestedOf, lastManagerSaid, plotTitle } from "./rules";

/** Rows of art pixels above the plot's bottom where its rail is. */
const rail = 5;
/** A sign stands this far over its thing; one at the top edge stands inside it. */
const signGap = 3;
const topEdge = 20;
const signInside = 30;
/** The manager's words stay this long after he finished saying them. */
const speechMs = 9000;

const sign: Record<string, string> = {
  shop: "icon-shop",
  warehouse: "icon-crate",
  tasks: "icon-tasks",
  log: "icon-log",
  taskBoard: "icon-task-board",
  agents: "icon-board",
  runtimes: "machine-tractor",
  skills: "icon-skillbook",
};

/** A card centred on (x, y), its bottom there unless `ay` says otherwise; page pixels. */
function Pin({ x, y, ay = 1, children }: { x: number; y: number; ay?: number; children: ReactNode }) {
  return (
    <div className="absolute" style={{ left: x, top: y, transform: `translate(-50%, ${-ay * 100}%)` }}>
      {children}
    </div>
  );
}

const words = (text: string, color?: string): Piece => ({ kind: "words", text, color });

export function Overlay() {
  const { frame } = useFrames();
  const { village } = useVillage();
  const screen = useFarm((s) => s.screen);
  const tool = useFarm((s) => s.tool);
  const hoverBed = useFarm((s) => s.hoverBed);
  const hoverSpot = useFarm((s) => s.hoverSpot);
  const reveal = useFarm((s) => s.revealNames);
  const bedFx = useFarm((s) => s.bedFx);
  const rewards = useFarm((s) => s.rewards);
  const chatOpen = useFarm((s) => s.chatOpen);
  if (!frame || !screen || !village) return null;
  const { state, view } = frame;
  const { world, atlas } = village;
  const level = Math.round(view.level.level);
  const s = screen.scale;
  const at = (x: number, y: number) => screen.toScreen({ x, y });
  const back: ReactNode[] = [];
  const front: ReactNode[] = [];
  const tips: ReactNode[] = [];

  for (const bed of beds) {
    const p = world.plotAt(bed.index);
    const session = bed.unlockLevel === undefined ? sessionAtStation(state.sessions, bed.station) : undefined;
    const plot = bed.unlockLevel !== undefined ? lockedPlot(bed, level) : plotOf(view, session);
    let card: ReactNode;
    let where: "above" | "rail" | "middle" = "rail";
    const reward =
      bed.station < 0 ? undefined : rewards.filter((r) => state.sessions.some((h) => h.id === r.sessionId && stationOfSession(h) === bed.station)).at(-1);
    const note = bedFx.filter((f) => f.bed === bed.index && (f.kind === "note" || f.kind === "harvest")).at(-1);
    if (hoverBed === bed.index) {
      const aim = aimTool(tool, bed, session, plot, level);
      where = "above";
      card = (
        <PixelCard
          center
          rows={[
            [words(plotTitle(bed, session, plot.crop))],
            ...(session?.project ? [[words(session.project, CardColors.muted)]] : []),
            [words(aim.ok ? `点击：${aim.text}` : aim.text, aim.ok ? CardColors.good : CardColors.muted)],
          ]}
        />
      );
    } else if (reward) {
      card = <PixelCard rows={[[{ kind: "icon", sprite: atlas.get("icon-coin"), px: 12 }, words(`+${Math.round(reward.coins)}`)]]} />;
    } else if (note) {
      card = <PixelCard rows={[[words(note.text ?? "")]]} />;
    } else if (plot.badge) {
      const [paper, ink] = badgeColors[plot.badge.tone];
      card = <PixelCard paper={paper} ink={ink} rows={[[words(plot.badge.text)], ...(session?.project ? [[words(session.project, ink)]] : [])]} />;
    } else if (session?.project) {
      // Plots of several projects share the farm: each says whose it is.
      card = <PixelCard padX={3} padY={0} rows={[[words(session.project, CardColors.muted)]]} />;
    } else if (bed.unlockLevel !== undefined && plot.crop === "locked") {
      where = "middle";
      card = <PixelCard rows={[[words(`Lv.${bed.unlockLevel} 开垦`)]]} />;
    }
    if (!card) continue;
    const pin =
      where === "middle" ? (
        <Pin key={bed.index} {...at(p.x, p.y - plotH / 2)} ay={0.5}>
          {card}
        </Pin>
      ) : where === "rail" ? (
        <Pin key={bed.index} x={at(p.x, 0).x} y={at(0, p.y - plotH + rail).y - 2}>
          {card}
        </Pin>
      ) : (
        <Pin key={bed.index} x={at(p.x, 0).x} y={at(0, p.y - plotH - 3).y - 2}>
          {card}
        </Pin>
      );
    (where === "above" ? front : back).push(pin);
  }

  const mgr = world.manager;
  back.push(
    <ManagerWords
      key="manager"
      x={at(mgr.x, 0).x}
      y={at(0, mgr.y - 34).y - 4}
      hidden={chatOpen || reveal}
      sessions={state.sessions.length}
      said={lastManagerSaid(state.chat)}
    />,
  );

  yardPlaces.forEach((place, i) => {
    const box = world.spotBoxes.get(place.id);
    if (!box) return;
    const top = box.y0 < topEdge ? box.y0 + signInside : box.y0;
    const cx = (box.x0 + box.x1) / 2;
    const x = at(cx, 0).x;
    const y = at(0, top).y - 4;
    if (hoverSpot === place.id) {
      tips.push(
        <Pin key={place.id} x={x} y={y}>
          <PixelCard center rows={[[words(place.label)], [words(place.hint, CardColors.muted)]]} />
        </Pin>,
      );
    } else if (reveal) {
      tips.push(
        <Pin key={place.id} x={x} y={y}>
          <PixelCard center padX={3} padY={1} rows={[[words(place.label)]]} />
        </Pin>,
      );
    } else if (sign[place.id] && atlas.has(sign[place.id]!)) {
      back.push(
        <Pin key={place.id} x={x} y={at(0, top).y - signGap * s}>
          <span className="block motion-safe:animate-[hop_3.2s_steps(1)_infinite]" style={{ animationDelay: `${-i * 0.8}s` }}>
            <PixelCard paper={CardColors.wood} padX={2} padY={2} rows={[[{ kind: "icon", sprite: atlas.get(sign[place.id]!), px: 22 }]]} />
          </span>
        </Pin>,
      );
    }
    const count = place.id === "warehouse" ? harvestedOf(state).length : place.id === "taskBoard" ? frame.graphs.filter((g) => g.asksForYou).length : 0;
    if (count > 0)
      back.push(
        <Pin key={`${place.id}:count`} {...at(box.x1, box.y0)} ay={0.5}>
          <PixelCard paper={CardColors.bug} ink={CardColors.lightInk} padX={3} padY={0} rows={[[words(String(count))]]} />
        </Pin>,
      );
  });

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {back}
      <Heads sessions={state.sessions} />
      {front}
      {tips}
    </div>
  );
}

/** What each helper is doing, over its head as it walks: moved every frame, not rendered every frame. */
function Heads({ sessions }: { sessions: readonly Session[] }) {
  const screen = useFarm((s) => s.screen);
  const { village } = useVillage();
  const refs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (!screen) return;
    const place = () => {
      const sc = farmState().screen;
      if (!sc) return;
      for (const [id, el] of refs.current) {
        const feet = sc.helperAt(id);
        el.style.visibility = feet ? "visible" : "hidden";
        if (feet) el.style.transform = `translate(${Math.round(feet.x)}px, ${Math.round(feet.y - 31 * sc.scale - 2)}px) translate(-50%, -100%)`;
      }
    };
    place();
    return screen.onFrame(place);
  }, [screen]);
  if (!village) return null;
  return (
    <>
      {sessions.map((h) => {
        const doing = doingOf(h);
        const named = h.phase._tag === "arriving";
        const act = `act-${doing.action}`;
        if (doing.action === "none" && !named) return null;
        const rows: Piece[] = [];
        if (doing.action !== "none" && village.atlas.has(act)) rows.push({ kind: "icon", sprite: village.atlas.get(act), px: 18 });
        if (named) rows.push(words(h.name));
        return (
          <div
            key={h.id}
            ref={(el) => {
              if (el) refs.current.set(h.id, el);
              else refs.current.delete(h.id);
            }}
            className="absolute top-0 left-0"
            style={{ visibility: "hidden" }}
            data-testid={`head-${h.id}`}
          >
            <PixelCard padX={3} padY={2} rows={[rows]} />
          </div>
        );
      })}
    </>
  );
}

/** The manager's last line, for a while after he said it; on an empty farm, his question. */
function ManagerWords({ x, y, hidden, sessions, said }: { x: number; y: number; hidden: boolean; sessions: number; said: ReturnType<typeof lastManagerSaid> }) {
  const [now, setNow] = useState(() => Date.now());
  const finishedAt = useRef<{ key: string; at?: number }>({ key: "" });
  if (said && said.key !== finishedAt.current.key) finishedAt.current = { key: said.key };
  if (said?.final && finishedAt.current.at === undefined) finishedAt.current.at = Date.now();
  const doneAt = finishedAt.current.at;
  useEffect(() => {
    if (doneAt === undefined) return;
    const left = doneAt + speechMs - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => setNow(Date.now()), left + 50);
    return () => clearTimeout(t);
  }, [doneAt]);
  if (hidden) return null;
  const fresh = said && (doneAt === undefined || now - doneAt < speechMs);
  const text = fresh ? plainText(said.text) : sessions === 0 ? "今天种点什么？" : undefined;
  if (!text) return null;
  return (
    <Pin x={x} y={y}>
      <PixelCard maxWidth={220} maxLines={3} rows={[[words(text)]]} />
    </Pin>
  );
}
