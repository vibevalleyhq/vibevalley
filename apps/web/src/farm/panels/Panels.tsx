// The layers over the farm a click or a key opens, from the store's overlays: the harvest, the sowing and watering
// forms, a panel (shop, warehouse, tasks, log, the orchestrator's looks, the task board) and the Esc menu. A plot's issue
// (inspect) is IssueView's. Each is a farm dialog: Esc or the backdrop closes it.

import { farmWording } from "../words";
import { For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { farm, type FarmOverlay, type FarmPanel } from "../store";
import { lookReady, orchestratorLooks, orchestratorSprite, petName } from "../../features/orchestrator/looks";
import { aria, Keyed } from "../../base/util";
import { useCore } from "../../base/frame";
import { FarmDialog, type FarmDialogSize, SpriteIcon } from "../../ui/pixel";
import { useFarm } from "../state";
import { useVillage } from "../support";
import { Achievements } from "./Achievements";
import { FarmLog } from "./FarmLog";
import { HarvestReview, Warehouse } from "./Harvest";
import { Menu } from "./Menu";
import { SowForm, WaterForm } from "./SeedForms";
import { TaskBoard } from "./TaskBoard";
import { tint } from "./bits";
import { setOrchestratorLook, setPet, usePrefs } from "../../base/prefs";

const panelTitle: Record<FarmPanel, [title: string, icon: string, size: FarmDialogSize]> = {
  shop: [farmWording().panel.shop, "icon-shop", "sm"],
  warehouse: [farmWording().panel.warehouse, "icon-crate", "lg"],
  graphs: [farmWording().panel.graphs, "icon-tasks", "lg"],
  log: [farmWording().panel.log, "icon-log", "lg"],
  orchestrator: [farmWording().panel.orchestrator, "manager-face", "wide"],
  taskBoard: [farmWording().panel.taskBoard, "machine-seeder", "lg"],
};

/** Each layer is drawn by its kind; one of a kind replaced by another (another plot, another panel) is built anew. */
const layerKey = (o: FarmOverlay) => {
  switch (o.kind) {
    case "inspect":
    case "review":
    case "water":
      return `${o.kind}:${o.sessionId}`;
    case "sow":
      return `sow:${o.station}`;
    case "panel":
      return `panel:${o.panel}`;
    case "menu":
      return "menu";
  }
};

export function Panels() {
  const overlays = useFarm((s) => s.overlays);
  return (
    <For each={overlays()} keyed={layerKey}>
      {(o) => <Layer o={o()} />}
    </For>
  );
}

function Layer(props: { o: FarmOverlay }) {
  const core = useCore();
  const byId = (id: string) => (core()?.sessions ?? []).find((s) => s.id === id);
  return (
    <Switch>
      <Match when={props.o.kind === "review" ? byId((props.o as { sessionId: string }).sessionId) : undefined}>
        {(s) => (
          <FarmDialog title={farmWording().panel.harvest(s().name)} icon="icon-harvest" size="lg" onClose={() => farm.review(null)}>
            <Keyed key={s().id}>{() => <HarvestReview session={s()} onDone={() => farm.review(null)} />}</Keyed>
          </FarmDialog>
        )}
      </Match>
      <Match when={props.o.kind === "sow" ? props.o : undefined}>
        {(o) => (
          <FarmDialog title={farmWording().panel.sow(o().station + 1)} icon="icon-seeds" size="lg" onClose={() => farm.sow(null)}>
            <SowForm station={o().station} onDone={() => farm.sow(null)} />
          </FarmDialog>
        )}
      </Match>
      <Match when={props.o.kind === "water" ? byId((props.o as { sessionId: string }).sessionId) : undefined}>
        {(s) => (
          <FarmDialog title={farmWording().panel.water(s().name)} icon="icon-water" size="sm" onClose={() => farm.water(null)}>
            <WaterForm session={s()} onDone={() => farm.water(null)} />
          </FarmDialog>
        )}
      </Match>
      <Match when={props.o.kind === "panel" ? (props.o as { panel: FarmPanel }).panel : undefined}>
        {(panel) => (
          <FarmDialog title={panelTitle[panel()][0]} icon={panelTitle[panel()][1]} size={panelTitle[panel()][2]} onClose={() => farm.panel(null)}>
            <Switch fallback={<TaskBoard />}>
              <Match when={panel() === "warehouse"}>
                <Warehouse />
              </Match>
              <Match when={panel() === "graphs"}>
                <Achievements />
              </Match>
              <Match when={panel() === "log"}>
                <FarmLog />
              </Match>
              <Match when={panel() === "shop"}>
                <Shop />
              </Match>
              <Match when={panel() === "orchestrator"}>
                <OrchestratorLooks />
              </Match>
            </Switch>
          </FarmDialog>
        )}
      </Match>
      <Match when={props.o.kind === "menu"}>
        <FarmDialog title={farmWording().panel.menu} icon="icon-wrench" size="md" onClose={() => farm.menu(false)}>
          <Menu />
        </FarmDialog>
      </Match>
    </Switch>
  );
}

const pets = ["dog", "ragdoll", "bluecat"];

function Tile(props: { chosen: boolean; ready: boolean; onClick: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      aria-pressed={aria(props.chosen)}
      disabled={!props.ready}
      onClick={() => props.onClick()}
      class={[
        // The border is always there and only coloured when chosen: choosing does not squeeze what is inside.
        "flex w-full flex-col items-center border-2 p-2.5 enabled:cursor-pointer disabled:opacity-50",
        props.chosen ? "border-leaf-500" : "border-transparent enabled:hover:bg-cream-200",
      ]}
      style={{ background: props.chosen ? tint("#b4cb7c", 0.6) : undefined }}
    >
      {props.children}
    </button>
  );
}

function OrchestratorLooks() {
  const loaded = useVillage();
  const current = usePrefs((p) => p.orchestratorLook);
  const pet = usePrefs((p) => p.pet);
  const has = (name: string) => loaded().village?.atlas.has(name) ?? false;
  return (
    <div class="flex flex-col">
      <p class="text-[13px] text-bark-900">{farmWording().panel.pickLook}</p>
      <div class="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <For each={orchestratorLooks}>
          {(look) => (
            <Tile chosen={look.id === current()} ready={lookReady(look.id, has)} onClick={() => setOrchestratorLook(look.id)}>
              <span class="h-28">
                <Show when={loaded().village}>
                  <SpriteIcon name={orchestratorSprite(look.id, "", has)} size={112} />
                </Show>
              </span>
              <span class="mt-1.5 text-[13px]">{look.name}</span>
              <span class="text-center text-[12px] text-bark-600">{lookReady(look.id, has) ? look.blurb : farmWording().panel.drawing}</span>
            </Tile>
          )}
        </For>
      </div>
      <p class="mt-2 text-[13px]">{farmWording().panel.pets}</p>
      <div class="mt-2 flex gap-2.5">
        <For each={pets}>
          {(p) => (
            <div class="flex-1 bg-cream-100">
              <Tile chosen={p === pet()} ready={has(`${p}-awake`)} onClick={() => setPet(p)}>
                <span class="h-16">
                  <Show when={has(`${p}-awake`)}>
                    <SpriteIcon name={`${p}-awake`} size={64} />
                  </Show>
                </span>
                <span class="mt-1.5 text-[13px]">{petName[p]}</span>
                <Show when={!has(`${p}-awake`)}>
                  <span class="text-[12px] text-bark-600">{farmWording().panel.drawing}</span>
                </Show>
              </Tile>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

const shop = [
  { ...farmWording().panel.shopItems.scarecrow, price: 200, icon: "icon-scarecrow" },
  { ...farmWording().panel.shopItems.seeds, price: 300, icon: "icon-seeds" },
  { ...farmWording().panel.shopItems.bunting, price: 400, icon: "icon-bunting" },
  { ...farmWording().panel.shopItems.doghouse, price: 600, icon: "icon-doghouse" },
];

function Shop() {
  const core = useCore();
  return (
    <div class="flex flex-col">
      <p class="text-[13px] text-bark-800">{farmWording().panel.shopClosed(Math.round(core()?.progress?.coins ?? 0))}</p>
      <div class="mt-3 grid grid-cols-2 gap-2">
        <For each={shop}>
          {(item) => (
            <div class="flex items-center gap-2 bg-cream-100 p-2.5 opacity-80">
              <SpriteIcon name={item.icon} size={36} />
              <span class="min-w-0 flex-1">
                <span class="block text-[13px]">{item.name}</span>
                <span class="block truncate text-[12px] text-bark-600">{item.note}</span>
              </span>
              <SpriteIcon name="icon-coin" size={16} />
              <span class="text-[13px] text-bark-800">{item.price}</span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
