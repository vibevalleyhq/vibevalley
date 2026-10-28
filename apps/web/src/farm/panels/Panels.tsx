import { t } from "@vibevalley/i18n";
// The layers over the farm a click or a key opens, from the store's overlays: the harvest, the sowing and watering
// forms, a panel (shop, warehouse, tasks, log, the orchestrator's looks, the task board) and the Esc menu. A plot's issue
// (inspect) is IssueView's. Each is a farm dialog: Esc or the backdrop closes it.

import { For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { farm, type FarmOverlay, type FarmPanel } from "../store";
import { lookReady, orchestratorLooks, orchestratorSprite, petName } from "../../features/orchestrator";
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
import { setPet, usePrefs } from "../../base/prefs";
import { useQueryClient } from "@tanstack/solid-query";
import { defaultOrchestrator, type OrchestratorLook } from "@vibevalley/protocol";
import { orchestratorLookOf } from "../../base/agents";
import { api, reasonOf } from "../../base/api";
import { ready, useAgents } from "../../base/query";
import { toast } from "../../ui/toasts";

const panelTitle: Record<FarmPanel, [title: string, icon: string, size: FarmDialogSize]> = {
  shop: [t("web.farm.panel.shop"), "icon-shop", "sm"],
  warehouse: [t("web.farm.panel.warehouse"), "icon-crate", "lg"],
  graphs: [t("web.farm.panel.graphs"), "icon-tasks", "lg"],
  log: [t("web.farm.panel.log"), "icon-log", "lg"],
  orchestrator: [t("web.farm.panel.orchestrator"), "manager-face", "wide"],
  taskBoard: [t("web.farm.panel.taskBoard"), "machine-seeder", "lg"],
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
          <FarmDialog title={t("web.farm.panel.harvest", { name: s().name })} icon="icon-harvest" size="lg" testid="harvest" onClose={() => farm.review(null)}>
            <Keyed key={s().id}>{() => <HarvestReview session={s()} onDone={() => farm.review(null)} />}</Keyed>
          </FarmDialog>
        )}
      </Match>
      <Match when={props.o.kind === "sow" ? props.o : undefined}>
        {(o) => (
          <FarmDialog title={t("web.farm.panel.sow", { plot: o().station + 1 })} icon="icon-seeds" size="lg" testid="sow" onClose={() => farm.sow(null)}>
            <SowForm station={o().station} onDone={() => farm.sow(null)} />
          </FarmDialog>
        )}
      </Match>
      <Match when={props.o.kind === "water" ? byId((props.o as { sessionId: string }).sessionId) : undefined}>
        {(s) => (
          <FarmDialog title={t("web.farm.panel.water", { name: s().name })} icon="icon-water" size="sm" testid="water" onClose={() => farm.water(null)}>
            <WaterForm session={s()} onDone={() => farm.water(null)} />
          </FarmDialog>
        )}
      </Match>
      <Match when={props.o.kind === "panel" ? (props.o as { panel: FarmPanel }).panel : undefined}>
        {(panel) => (
          <FarmDialog
            title={panelTitle[panel()][0]}
            icon={panelTitle[panel()][1]}
            size={panelTitle[panel()][2]}
            testid={panel()}
            onClose={() => farm.panel(null)}
          >
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
        <FarmDialog title={t("web.farm.panel.menu")} icon="icon-wrench" size="md" testid="menu" onClose={() => farm.menu(false)}>
          <Menu />
        </FarmDialog>
      </Match>
    </Switch>
  );
}

const pets = ["dog", "ragdoll", "bluecat"];

function Tile(props: { item: string; chosen: boolean; ready: boolean; onClick: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      data-key={props.item}
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

/** The default orchestrator's look, kept in its profile. */
function OrchestratorLooks() {
  const loaded = useVillage();
  const agents = useAgents();
  const client = useQueryClient();
  const current = () => orchestratorLookOf(ready(agents, []));
  const choose = async (look: OrchestratorLook) => {
    const me = ready(agents, []).find((a) => a.id === defaultOrchestrator);
    if (!me) return;
    try {
      await api.agent.update({ ...me, look: { ...me.look, orchestrator: look } });
      await client.invalidateQueries({ queryKey: ["agents"] });
    } catch (e) {
      toast(reasonOf(e));
    }
  };
  const pet = usePrefs((p) => p.pet);
  const has = (name: string) => loaded().village?.atlas.has(name) ?? false;
  return (
    <div class="flex flex-col">
      <p class="text-[13px] text-bark-900">{t("web.farm.panel.pickLook")}</p>
      <div class="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <For each={orchestratorLooks}>
          {(look) => (
            <Tile item={look.id} chosen={look.id === current()} ready={lookReady(look.id, has)} onClick={() => void choose(look.id)}>
              <span class="h-28">
                <Show when={loaded().village}>
                  <SpriteIcon name={orchestratorSprite(look.id, "", has)} size={112} />
                </Show>
              </span>
              <span class="mt-1.5 text-[13px]">{look.name}</span>
              <span class="text-center text-[12px] text-bark-600">{lookReady(look.id, has) ? look.blurb : t("web.farm.panel.drawing")}</span>
            </Tile>
          )}
        </For>
      </div>
      <p class="mt-2 text-[13px]">{t("web.farm.panel.pets")}</p>
      <div class="mt-2 flex gap-2.5">
        <For each={pets}>
          {(p) => (
            <div class="flex-1 bg-cream-100">
              <Tile item={p} chosen={p === pet()} ready={has(`${p}-awake`)} onClick={() => setPet(p)}>
                <span class="h-16">
                  <Show when={has(`${p}-awake`)}>
                    <SpriteIcon name={`${p}-awake`} size={64} />
                  </Show>
                </span>
                <span class="mt-1.5 text-[13px]">{petName[p]}</span>
                <Show when={!has(`${p}-awake`)}>
                  <span class="text-[12px] text-bark-600">{t("web.farm.panel.drawing")}</span>
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
  { name: t("web.farm.panel.shopItems.scarecrow.name"), note: t("web.farm.panel.shopItems.scarecrow.note"), price: 200, icon: "icon-scarecrow" },
  { name: t("web.farm.panel.shopItems.seeds.name"), note: t("web.farm.panel.shopItems.seeds.note"), price: 300, icon: "icon-seeds" },
  { name: t("web.farm.panel.shopItems.bunting.name"), note: t("web.farm.panel.shopItems.bunting.note"), price: 400, icon: "icon-bunting" },
  { name: t("web.farm.panel.shopItems.doghouse.name"), note: t("web.farm.panel.shopItems.doghouse.note"), price: 600, icon: "icon-doghouse" },
];

function Shop() {
  const core = useCore();
  return (
    <div class="flex flex-col">
      <p class="text-[13px] text-bark-800">{t("web.farm.panel.shopClosed", { coins: Math.round(core()?.progress?.coins ?? 0) })}</p>
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
