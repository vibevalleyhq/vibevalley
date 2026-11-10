import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import { defaultOrchestrator, type OrchestratorLook } from "@vibevalley/protocol";

import { aria, Keyed } from "#/base/dom.tsx";
import { farm, type FarmOverlay, type FarmPanel, useFarm } from "#/farm/store.ts";
import { useVillage } from "#/farm/world/load.ts";
import { lookReady, orchestratorLooks, orchestratorSprite, petName } from "#/features/orchestrator/index.ts";
import { orchestratorLookOf } from "#/infra/agents.ts";
import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { useQueryClient, ready, useAgents } from "#/infra/query.ts";
import { setPet, usePrefs } from "#/state/prefs.ts";
import { createPixelAct, FarmDialog, type FarmDialogSize, SpriteIcon } from "#/ui/pixel/index.ts";

import { Achievements } from "./Achievements";
import { FarmLog } from "./FarmLog";
import { HarvestReview, Warehouse } from "./Harvest";
import { Menu } from "./Menu";
import { SowForm, WaterForm } from "./SeedForms";

const styles = stylex.create({
  tile: {
    display: "flex",
    width: "100%",
    flexDirection: "column",
    alignItems: "center",
    borderStyle: "solid",
    borderWidth: "2px",
    padding: "calc(var(--spacing) * 2.5)",
    cursor: {
      default: null,
      ":enabled": "pointer",
    },
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
  tileIdle: {
    borderColor: "transparent",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":enabled:hover": "var(--color-cream-200)",
      },
    },
  },
  tileChosen: {
    borderColor: "var(--color-leaf-500)",
    backgroundColor: "color-mix(in srgb, var(--color-leaf-300) 60%, var(--color-cream-50))",
  },
  column: {
    display: "flex",
    flexDirection: "column",
  },
  lead: {
    fontSize: "13px",
    color: "var(--color-bark-900)",
  },
  looksGrid: {
    marginTop: "calc(var(--spacing) * 3)",
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2,minmax(0,1fr))",
      "@media (width>=40rem)": "repeat(3,minmax(0,1fr))",
    },
    gap: "calc(var(--spacing) * 2.5)",
  },
  lookPreview: {
    height: "calc(var(--spacing) * 28)",
  },
  tileName: {
    marginTop: "calc(var(--spacing) * 1.5)",
    fontSize: "13px",
  },
  tileBlurb: {
    textAlign: "center",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  petsHeading: {
    marginTop: "calc(var(--spacing) * 2)",
    fontSize: "13px",
  },
  petsRow: {
    marginTop: "calc(var(--spacing) * 2)",
    display: "flex",
    gap: "calc(var(--spacing) * 2.5)",
  },
  petSlot: {
    flex: "1",
    backgroundColor: "var(--color-cream-100)",
  },
  petPreview: {
    height: "calc(var(--spacing) * 16)",
  },
  petDrawing: {
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  shopText: {
    fontSize: "13px",
    color: "var(--color-bark-800)",
  },
  shopGrid: {
    marginTop: "calc(var(--spacing) * 3)",
    display: "grid",
    gridTemplateColumns: "repeat(2,minmax(0,1fr))",
    gap: "calc(var(--spacing) * 2)",
  },
  shopCard: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    backgroundColor: "var(--color-cream-100)",
    padding: "calc(var(--spacing) * 2.5)",
    opacity: ".8",
  },
  shopBody: {
    minWidth: "0",
    flex: "1",
  },
  shopName: {
    display: "block",
    fontSize: "13px",
  },
  shopNote: {
    display: "block",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
});

const panelTitle: Record<FarmPanel, [title: string, icon: string, size: FarmDialogSize]> = {
  shop: [t("web.farm.panel.shop"), "icon-shop", "sm"],
  warehouse: [t("web.farm.panel.warehouse"), "icon-crate", "lg"],
  graphs: [t("web.farm.panel.graphs"), "icon-tasks", "lg"],
  log: [t("web.farm.panel.log"), "icon-log", "lg"],
  orchestrator: [t("web.farm.panel.orchestrator"), "manager-face", "wide"],
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
      <Match when={props.o.kind === "review" ? byId(props.o.sessionId) : undefined}>
        {(s) => (
          <FarmDialog
            title={t("web.farm.panel.harvest", { name: s().name })}
            icon="icon-harvest"
            size="lg"
            testid="harvest"
            onClose={() => farm.review(undefined)}
          >
            <Keyed key={s().id}>{() => <HarvestReview session={s()} onDone={() => farm.review(undefined)} />}</Keyed>
          </FarmDialog>
        )}
      </Match>
      <Match when={props.o.kind === "sow" ? props.o : undefined}>
        {(o) => (
          <FarmDialog title={t("web.farm.panel.sow", { plot: o().station + 1 })} icon="icon-seeds" size="lg" testid="sow" onClose={() => farm.sow(undefined)}>
            <SowForm station={o().station} onDone={() => farm.sow(undefined)} />
          </FarmDialog>
        )}
      </Match>
      <Match when={props.o.kind === "water" ? byId(props.o.sessionId) : undefined}>
        {(s) => (
          <FarmDialog title={t("web.farm.panel.water", { name: s().name })} icon="icon-water" size="sm" testid="water" onClose={() => farm.water(undefined)}>
            <WaterForm session={s()} onDone={() => farm.water(undefined)} />
          </FarmDialog>
        )}
      </Match>
      <Match when={props.o.kind === "panel" ? props.o.panel : undefined}>
        {(panel) => (
          <FarmDialog
            title={panelTitle[panel()][0]}
            icon={panelTitle[panel()][1]}
            size={panelTitle[panel()][2]}
            testid={panel()}
            onClose={() => farm.panel(undefined)}
          >
            <Switch>
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
      {...stylex.attrs(styles.tile, props.chosen ? styles.tileChosen : styles.tileIdle)}
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
  const act = createPixelAct();
  // The API saves a whole profile, and the cached one may be older than an edit made since (on the profile's page).
  const choose = (look: OrchestratorLook) =>
    act.run(async () => {
      const me = (await api.agent.list()).find((a) => a.id === defaultOrchestrator);
      if (!me) return;
      await api.agent.update({ ...me, look: { ...me.look, orchestrator: look } });
      await client.invalidate({ prefix: ["agents"] });
    });
  const pet = usePrefs((p) => p.pet);
  const has = (name: string) => loaded().village?.atlas.has(name) ?? false;
  return (
    <div {...stylex.attrs(styles.column)}>
      <p {...stylex.attrs(styles.lead)}>{t("web.farm.panel.pickLook")}</p>
      <div {...stylex.attrs(styles.looksGrid)}>
        <For each={orchestratorLooks}>
          {(look) => (
            <Tile item={look.id} chosen={look.id === current()} ready={lookReady(look.id, has)} onClick={() => void choose(look.id)}>
              <span {...stylex.attrs(styles.lookPreview)}>
                <Show when={loaded().village}>
                  <SpriteIcon name={orchestratorSprite(look.id, "", has)} size={112} />
                </Show>
              </span>
              <span {...stylex.attrs(styles.tileName)}>{look.name}</span>
              <span {...stylex.attrs(styles.tileBlurb)}>{lookReady(look.id, has) ? look.blurb : t("web.farm.panel.drawing")}</span>
            </Tile>
          )}
        </For>
      </div>
      <p {...stylex.attrs(styles.petsHeading)}>{t("web.farm.panel.pets")}</p>
      <div {...stylex.attrs(styles.petsRow)}>
        <For each={pets}>
          {(p) => (
            <div {...stylex.attrs(styles.petSlot)}>
              <Tile item={p} chosen={p === pet()} ready={has(`${p}-awake`)} onClick={() => setPet(p)}>
                <span {...stylex.attrs(styles.petPreview)}>
                  <Show when={has(`${p}-awake`)}>
                    <SpriteIcon name={`${p}-awake`} size={64} />
                  </Show>
                </span>
                <span {...stylex.attrs(styles.tileName)}>{petName[p]}</span>
                <Show when={!has(`${p}-awake`)}>
                  <span {...stylex.attrs(styles.petDrawing)}>{t("web.farm.panel.drawing")}</span>
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
    <div {...stylex.attrs(styles.column)}>
      <p {...stylex.attrs(styles.shopText)}>{t("web.farm.panel.shopClosed", { coins: Math.round(core()?.progress?.coins ?? 0) })}</p>
      <div {...stylex.attrs(styles.shopGrid)}>
        <For each={shop}>
          {(item) => (
            <div {...stylex.attrs(styles.shopCard)}>
              <SpriteIcon name={item.icon} size={36} />
              <span {...stylex.attrs(styles.shopBody)}>
                <span {...stylex.attrs(styles.shopName)}>{item.name}</span>
                <span {...stylex.attrs(styles.shopNote)}>{item.note}</span>
              </span>
              <SpriteIcon name="icon-coin" size={16} />
              <span {...stylex.attrs(styles.shopText)}>{item.price}</span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
