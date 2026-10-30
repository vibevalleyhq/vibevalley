import { t } from "@vibevalley/i18n";
// The words over the village, at screen pixels so they stay sharp: each plot's card (what a click would do while
// pointed at, a reward, a note, its badge, its project, the level that clears it), what each helper is doing over its
// head, the orchestrator's last words, and the yard's signs, names and counts. Words let clicks through to the village.

import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { SessionId, SessionView } from "@vibevalley/protocol";
import { doingOf, harvestedOf, lastOrchestratorSaid, plotTitle } from "./readout";
import { farmState } from "@/farm/store";
import { aimTool } from "@/farm/tools";
import { yardPlaces } from "@/farm/world/places";
import { beds, issueOf, lockedPlot, plotOf, sessionAtStation, stationOfSession } from "@/farm/world/plots";
import type { Village } from "@/farm/world/load";
import { plotH } from "@/farm/world/world";
import { useFrames } from "@/base/frame";
import { useFollowed, defaultOf } from "@/features/channel";
import { badgeColors, CardColors, PixelCard, plainText, type Piece } from "@/ui/pixel";
import { useFarm } from "@/farm/ui";
import { useVillage } from "@/farm/support";

/** Rows of art pixels above the plot's bottom where its rail is. */
const rail = 5;
/** A sign stands this far over its thing; one at the top edge stands inside it. */
const signGap = 3;
const topEdge = 20;
const signInside = 30;
/** The orchestrator's words stay this long after he finished saying them. */
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

/** What a PixelCard draws, as data: the pins are worked out in one memo and drawn by key. */
interface Card {
  rows: readonly (readonly Piece[])[];
  paper?: string;
  ink?: string;
  padX?: number;
  padY?: number;
  center?: boolean;
  maxWidth?: number;
  maxLines?: number;
}

/** A card centred on (x, y), its bottom there unless `ay` says otherwise; page pixels. `hop`: a sign's bob delay. */
interface Pin {
  key: string;
  x: number;
  y: number;
  ay: number;
  card: Card;
  hop?: number;
}

const words = (text: string, color?: string): Piece => ({ kind: "words", text, ...(color ? { color } : {}) });

function PinView(props: { pin: Pin }) {
  const card = () => (
    <PixelCard
      rows={props.pin.card.rows}
      paper={props.pin.card.paper}
      ink={props.pin.card.ink}
      padX={props.pin.card.padX}
      padY={props.pin.card.padY}
      center={props.pin.card.center}
      maxWidth={props.pin.card.maxWidth}
      maxLines={props.pin.card.maxLines}
    />
  );
  return (
    <div class="absolute" style={{ left: `${props.pin.x}px`, top: `${props.pin.y}px`, transform: `translate(-50%, ${-props.pin.ay * 100}%)` }}>
      <Show when={props.pin.hop !== undefined} fallback={card()}>
        <span class="block motion-safe:animate-[hop_3.2s_steps(1)_infinite]" style={{ "animation-delay": `${props.pin.hop}s` }}>
          {card()}
        </span>
      </Show>
    </div>
  );
}

export function Overlay() {
  const frames = useFrames();
  const general = useFollowed(() => defaultOf(frames.frame?.state.chat)?.id);
  const loaded = useVillage();
  const screen = useFarm((s) => s.screen);
  const tool = useFarm((s) => s.tool);
  const hoverBed = useFarm((s) => s.hoverBed);
  const hoverSpot = useFarm((s) => s.hoverSpot);
  const reveal = useFarm((s) => s.revealNames);
  const bedFx = useFarm((s) => s.bedFx);
  const rewards = useFarm((s) => s.rewards);
  const chatOpen = useFarm((s) => s.chatOpen);

  const pins = createMemo(() => {
    const frame = frames.frame;
    const sc = screen();
    const village = loaded().village;
    if (!frame || !sc || !village) return undefined;
    const { state, view } = frame;
    const { world, atlas } = village;
    const level = Math.round(view.level.level);
    const at = (x: number, y: number) => sc.toScreen({ x, y });
    const back: Pin[] = [];
    const front: Pin[] = [];
    const tips: Pin[] = [];

    for (const bed of beds) {
      const p = world.plotAt(bed.index);
      const session = bed.unlockLevel === undefined ? sessionAtStation(state.sessions, bed.station) : undefined;
      const plot = bed.unlockLevel !== undefined ? lockedPlot(bed, level) : plotOf(view, session);
      let card: Card | undefined;
      let where: "above" | "rail" | "middle" = "rail";
      const reward =
        bed.station < 0 ? undefined : rewards().findLast((r) => state.sessions.some((h) => h.id === r.sessionId && stationOfSession(h) === bed.station));
      const note = bedFx().findLast((f) => f.bed === bed.index && (f.kind === "note" || f.kind === "harvest"));
      if (hoverBed() === bed.index) {
        const issue = session ? state.issues.find((i) => i.id === issueOf(session)) : undefined;
        const aim = aimTool(tool(), bed, session, plot, level, issue);
        where = "above";
        card = {
          center: true,
          rows: [
            [words(plotTitle(bed, session, plot.crop))],
            ...(session?.project ? [[words(session.project, CardColors.muted)]] : []),
            [words(aim.ok ? t("web.farm.overlay.click", { text: aim.text }) : aim.text, aim.ok ? CardColors.good : CardColors.muted)],
          ],
        };
      } else if (reward) {
        card = { rows: [[{ kind: "icon", sprite: atlas.get("icon-coin"), px: 12 }, words(`+${Math.round(reward.coins)}`)]] };
      } else if (note) {
        card = { rows: [[words(note.text ?? "")]] };
      } else if (plot.badge) {
        const [paper, ink] = badgeColors[plot.badge.tone];
        card = { paper, ink, rows: [[words(plot.badge.text)], ...(session?.project ? [[words(session.project, ink)]] : [])] };
      } else if (session?.project) {
        // Plots of several projects share the farm: each says whose it is.
        card = { padX: 3, padY: 0, rows: [[words(session.project, CardColors.muted)]] };
      } else if (bed.unlockLevel !== undefined && plot.crop === "locked") {
        where = "middle";
        card = { rows: [[words(t("web.farm.overlay.clearAt", { level: bed.unlockLevel }))]] };
      }
      if (!card) continue;
      const key = `bed:${bed.index}`;
      const pin: Pin =
        where === "middle"
          ? { key, ...at(p.x, p.y - plotH / 2), ay: 0.5, card }
          : where === "rail"
            ? { key, x: at(p.x, 0).x, y: at(0, p.y - plotH + rail).y - 2, ay: 1, card }
            : { key, x: at(p.x, 0).x, y: at(0, p.y - plotH - 3).y - 2, ay: 1, card };
      (where === "above" ? front : back).push(pin);
    }

    yardPlaces.forEach((place, i) => {
      const box = world.spotBoxes.get(place.id);
      if (!box) return;
      const top = box.y0 < topEdge ? box.y0 + signInside : box.y0;
      const x = at((box.x0 + box.x1) / 2, 0).x;
      const y = at(0, top).y - 4;
      const icon = sign[place.id];
      if (hoverSpot() === place.id) {
        tips.push({ key: `spot:${place.id}`, x, y, ay: 1, card: { center: true, rows: [[words(place.label)], [words(place.hint, CardColors.muted)]] } });
      } else if (reveal()) {
        tips.push({ key: `spot:${place.id}`, x, y, ay: 1, card: { center: true, padX: 3, padY: 1, rows: [[words(place.label)]] } });
      } else if (icon && atlas.has(icon)) {
        back.push({
          key: `sign:${place.id}`,
          x,
          y: at(0, top).y - signGap * sc.scale,
          ay: 1,
          hop: -i * 0.8,
          card: { paper: CardColors.wood, padX: 2, padY: 2, rows: [[{ kind: "icon", sprite: atlas.get(icon), px: 22 }]] },
        });
      }
      const count = place.id === "warehouse" ? harvestedOf(state).length : place.id === "taskBoard" ? frame.graphs.filter((g) => g.asksForYou).length : 0;
      if (count > 0)
        back.push({
          key: `count:${place.id}`,
          ...at(box.x1, box.y0),
          ay: 0.5,
          card: { paper: CardColors.bug, ink: CardColors.lightInk, padX: 3, padY: 0, rows: [[words(String(count))]] },
        });
    });

    const mgr = world.orchestrator;
    return { back, front, tips, orchestrator: { x: at(mgr.x, 0).x, y: at(0, mgr.y - 34).y - 4 }, village };
  });

  return (
    <Show when={pins()}>
      {(p) => (
        <div class="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
          <For each={p().back} keyed={(pin) => pin.key}>
            {(pin) => <PinView pin={pin()} />}
          </For>
          <OrchestratorWords
            x={p().orchestrator.x}
            y={p().orchestrator.y}
            hidden={chatOpen() || reveal()}
            sessions={frames.frame?.state.sessions.length ?? 0}
            said={lastOrchestratorSaid(general().messages)}
          />
          <Heads sessions={frames.frame?.state.sessions ?? []} village={p().village} />
          <For each={p().front} keyed={(pin) => pin.key}>
            {(pin) => <PinView pin={pin()} />}
          </For>
          <For each={p().tips} keyed={(pin) => pin.key}>
            {(pin) => <PinView pin={pin()} />}
          </For>
        </div>
      )}
    </Show>
  );
}

/** What each helper is doing, over its head as it walks: moved every frame, not drawn again every frame. */
function Heads(props: { sessions: readonly SessionView[]; village: Village }) {
  const screen = useFarm((s) => s.screen);
  const placed = new Map<SessionId, HTMLDivElement>();
  const place = () => {
    const sc = farmState().screen;
    if (!sc) return;
    for (const [id, el] of placed) {
      const feet = sc.helperAt(id);
      el.style.visibility = feet ? "visible" : "hidden";
      if (feet) el.style.transform = `translate(${Math.round(feet.x)}px, ${Math.round(feet.y - 31 * sc.scale - 2)}px) translate(-50%, -100%)`;
    }
  };
  createEffect(screen, (sc) => {
    if (!sc) return;
    place();
    return sc.onFrame(place);
  });
  return (
    <For each={props.sessions} keyed={(h) => h.id}>
      {(h) => <Head session={h()} village={props.village} placed={placed} />}
    </For>
  );
}

function Head(props: { session: SessionView; village: Village; placed: Map<string, HTMLDivElement> }) {
  const rows = () => {
    const doing = doingOf(props.session);
    const named = props.session.phase._tag === "arriving";
    const act = `act-${doing.action}`;
    if (doing.action === "none" && !named) return undefined;
    const out: Piece[] = [];
    if (doing.action !== "none" && props.village.atlas.has(act)) out.push({ kind: "icon", sprite: props.village.atlas.get(act), px: 18 });
    if (named) out.push(words(props.session.name));
    return out;
  };
  let el: HTMLDivElement | undefined;
  onSettled(() => {
    const id = props.session.id;
    if (el) props.placed.set(id, el);
    return () => props.placed.delete(id);
  });
  return (
    <Show when={rows()}>
      {(r) => (
        <div ref={(div) => (el = div)} class="absolute top-0 left-0" style={{ visibility: "hidden" }} data-testid={`head-${props.session.id}`}>
          <PixelCard padX={3} padY={2} rows={[r()]} />
        </div>
      )}
    </Show>
  );
}

/** The orchestrator's last line, for a while after he said it; on an empty farm, his question. */
function OrchestratorWords(props: { x: number; y: number; hidden: boolean; sessions: number; said: ReturnType<typeof lastOrchestratorSaid> }) {
  const [now, setNow] = createSignal(Date.now());
  // When the line being shown was finished; a new line starts over.
  let finished: { key: string; at?: number } = { key: "" };
  const doneAt = createMemo(() => {
    const said = props.said;
    if (said && said.key !== finished.key) finished = { key: said.key };
    if (said && finished.at === undefined) finished.at = Date.now();
    return finished.at;
  });
  createEffect(doneAt, (at) => {
    if (at === undefined) return;
    const left = at + speechMs - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => setNow(Date.now()), left + 50);
    return () => clearTimeout(t);
  });
  const text = () => {
    if (props.hidden) return undefined;
    const said = props.said;
    const at = doneAt();
    const fresh = said && (at === undefined || now() - at < speechMs);
    return fresh === true ? plainText(said.text) : props.sessions === 0 ? t("web.farm.overlay.idle") : undefined;
  };
  return (
    <Show when={text()}>
      {(t) => <PinView pin={{ key: "orchestrator", x: props.x, y: props.y, ay: 1, card: { maxWidth: 220, maxLines: 3, rows: [[words(t())]] } }} />}
    </Show>
  );
}
