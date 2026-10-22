// The layers over the farm a click or a key opens, from the store's overlays: the harvest, the sowing and watering
// forms, a panel (shop, warehouse, tasks, log, the orchestrator's looks, the task board) and the Esc menu. A plot's issue
// (inspect) is IssueView's. Each is a farm dialog: Esc or the backdrop closes it.

import { For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { farm, type FarmOverlay, type FarmPanel } from "../store";
import { lookReady, orchestratorLooks, orchestratorSprite, petName } from "../tools";
import { aria, Keyed } from "../../app/util";
import { useCore } from "../../data/frame";
import { FarmDialog, type FarmDialogSize, SpriteIcon } from "../kit";
import { useFarm } from "../state";
import { useVillage } from "../support";
import { Achievements } from "./Achievements";
import { FarmLog } from "./FarmLog";
import { HarvestReview, Warehouse } from "./Harvest";
import { Menu } from "./Menu";
import { SowForm, WaterForm } from "./SeedForms";
import { TaskBoard } from "./TaskBoard";
import { tint } from "./bits";

const panelTitle: Record<FarmPanel, [title: string, icon: string, size: FarmDialogSize]> = {
  shop: ["商店", "icon-shop", "sm"],
  warehouse: ["仓库", "icon-crate", "lg"],
  graphs: ["任务与成就", "icon-tasks", "lg"],
  log: ["农场日志", "icon-log", "lg"],
  orchestrator: ["管家和宠物", "manager-face", "wide"],
  taskBoard: ["种植计划", "machine-seeder", "lg"],
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
          <FarmDialog title={`收获${s().name}的地`} icon="icon-harvest" size="lg" onClose={() => farm.review(null)}>
            <Keyed key={s().id}>{() => <HarvestReview session={s()} onDone={() => farm.review(null)} />}</Keyed>
          </FarmDialog>
        )}
      </Match>
      <Match when={props.o.kind === "sow" ? (props.o as { station: number }) : undefined}>
        {(o) => (
          <FarmDialog title={`播种 · 第 ${o().station + 1} 块地`} icon="icon-seeds" size="lg" onClose={() => farm.sow(null)}>
            <SowForm station={o().station} onDone={() => farm.sow(null)} />
          </FarmDialog>
        )}
      </Match>
      <Match when={props.o.kind === "water" ? byId((props.o as { sessionId: string }).sessionId) : undefined}>
        {(s) => (
          <FarmDialog title={`给${s().name}浇水`} icon="icon-water" size="sm" onClose={() => farm.water(null)}>
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
        <FarmDialog title="菜单" icon="icon-wrench" size="md" onClose={() => farm.menu(false)}>
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
  const current = useFarm((s) => s.orchestratorLook);
  const pet = useFarm((s) => s.pet);
  const has = (name: string) => loaded().village?.atlas.has(name) ?? false;
  return (
    <div class="flex flex-col">
      <p class="text-[13px] text-bark-900">挑一个你喜欢的管家，农场和对话里马上换上。</p>
      <div class="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <For each={orchestratorLooks}>
          {(look) => (
            <Tile chosen={look.id === current()} ready={lookReady(look.id, has)} onClick={() => farm.setOrchestratorLook(look.id)}>
              <span class="h-28">
                <Show when={loaded().village}>
                  <SpriteIcon name={orchestratorSprite(look.id, "", has)} size={112} />
                </Show>
              </span>
              <span class="mt-1.5 text-[13px]">{look.name}</span>
              <span class="text-center text-[12px] text-bark-600">{lookReady(look.id, has) ? look.blurb : "还在画……"}</span>
            </Tile>
          )}
        </For>
      </div>
      <p class="mt-2 text-[13px]">宠物</p>
      <div class="mt-2 flex gap-2.5">
        <For each={pets}>
          {(p) => (
            <div class="flex-1 bg-cream-100">
              <Tile chosen={p === pet()} ready={has(`${p}-awake`)} onClick={() => farm.setPet(p)}>
                <span class="h-16">
                  <Show when={has(`${p}-awake`)}>
                    <SpriteIcon name={`${p}-awake`} size={64} />
                  </Show>
                </span>
                <span class="mt-1.5 text-[13px]">{petName[p]}</span>
                <Show when={!has(`${p}-awake`)}>
                  <span class="text-[12px] text-bark-600">还在画……</span>
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
  { name: "稻草人", price: 200, icon: "icon-scarecrow", note: "吓跑乌鸦，好看" },
  { name: "新种子包", price: 300, icon: "icon-seeds", note: "常用工单模板" },
  { name: "彩旗", price: 400, icon: "icon-bunting", note: "挂在篱笆上" },
  { name: "狗窝", price: 600, icon: "icon-doghouse", note: "给管家的狗" },
];

function Shop() {
  const core = useCore();
  return (
    <div class="flex flex-col">
      <p class="text-[13px] text-bark-800">商店还在装修，下一版开张。现在有 {Math.round(core()?.progress?.coins ?? 0)} 金币，先攒着。</p>
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
