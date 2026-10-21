// The layers over the farm a click or a key opens, from the store's overlays: the
// harvest, the sowing and watering forms, a panel (shop, warehouse, tasks, log, the manager's looks, the task board)
// and the Esc menu. A plot's issue (inspect) is IssueView's. Each is a farm dialog: Esc or the backdrop closes it.

import type { ReactNode } from "react";
import { useCore } from "../../data/frame";
import { FarmDialog, type FarmDialogSize, SpriteIcon } from "../kit";
import { farm, useFarm, type FarmPanel, type FarmOverlay } from "../store";
import { lookReady, managerLooks, managerSprite, petName } from "../tools";
import { useVillage } from "../world/load";
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
  manager: ["管家和宠物", "manager-face", "md"],
  taskBoard: ["种植计划", "machine-seeder", "lg"],
};

export function Panels() {
  const overlays = useFarm((s) => s.overlays);
  const sessions = useCore()?.sessions ?? [];
  const byId = (id: string) => sessions.find((s) => s.id === id);
  const layer = (o: FarmOverlay): ReactNode => {
    switch (o.kind) {
      case "inspect":
        return null;
      case "review": {
        const s = byId(o.sessionId);
        if (!s) return null;
        return (
          <FarmDialog key="harvest" title={`收获${s.name}的地`} icon="icon-harvest" size="lg" onClose={() => farm.review(null)}>
            <HarvestReview key={o.sessionId} session={s} onDone={() => farm.review(null)} />
          </FarmDialog>
        );
      }
      case "sow":
        return (
          <FarmDialog key="sow" title={`播种 · 第 ${o.station + 1} 块地`} icon="icon-seeds" size="lg" onClose={() => farm.sow(null)}>
            <SowForm station={o.station} onDone={() => farm.sow(null)} />
          </FarmDialog>
        );
      case "water": {
        const s = byId(o.sessionId);
        if (!s) return null;
        return (
          <FarmDialog key="water" title={`给${s.name}浇水`} icon="icon-water" size="sm" onClose={() => farm.water(null)}>
            <WaterForm session={s} onDone={() => farm.water(null)} />
          </FarmDialog>
        );
      }
      case "panel": {
        const [title, icon, size] = panelTitle[o.panel];
        return (
          <FarmDialog key={`panel-${o.panel}`} title={title} icon={icon} size={size} onClose={() => farm.panel(null)}>
            {o.panel === "warehouse" ? (
              <Warehouse />
            ) : o.panel === "graphs" ? (
              <Achievements />
            ) : o.panel === "log" ? (
              <FarmLog />
            ) : o.panel === "shop" ? (
              <Shop />
            ) : o.panel === "manager" ? (
              <ManagerLooks />
            ) : (
              <TaskBoard />
            )}
          </FarmDialog>
        );
      }
      case "menu":
        return (
          <FarmDialog key="menu" title="菜单" icon="icon-wrench" size="md" onClose={() => farm.menu(false)}>
            <Menu />
          </FarmDialog>
        );
    }
  };
  return <>{overlays.map(layer)}</>;
}

const pets = ["dog", "ragdoll", "bluecat"];

function Tile({ chosen, ready, onClick, children }: { chosen: boolean; ready: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={chosen}
      disabled={!ready}
      onClick={onClick}
      className={`flex flex-col items-center p-2.5 enabled:cursor-pointer disabled:opacity-50 ${chosen ? "border-2 border-leaf-500" : "enabled:hover:bg-cream-200"}`}
      style={{ background: chosen ? tint("#b4cb7c", 0.6) : undefined }}
    >
      {children}
    </button>
  );
}

function ManagerLooks() {
  const { village } = useVillage();
  const current = useFarm((s) => s.managerLook);
  const pet = useFarm((s) => s.pet);
  const has = (name: string) => village?.atlas.has(name) ?? false;
  return (
    <div className="flex flex-col">
      <p className="text-[13px] text-bark-900">挑一个你喜欢的管家，农场和对话里马上换上。</p>
      <div className="mt-3 grid grid-cols-3 gap-2.5">
        {managerLooks.map((look) => (
          <Tile key={look.id} chosen={look.id === current} ready={lookReady(look.id, has)} onClick={() => farm.setManagerLook(look.id)}>
            <span className="h-28">{village && <SpriteIcon name={managerSprite(look.id, "", has)} size={112} />}</span>
            <span className="mt-1.5 text-[13px]">{look.name}</span>
            <span className="text-center text-[12px] text-bark-600">{lookReady(look.id, has) ? look.blurb : "还在画……"}</span>
          </Tile>
        ))}
      </div>
      <p className="mt-2 text-[13px]">宠物</p>
      <div className="mt-2 flex gap-2.5">
        {pets.map((p) => (
          <div key={p} className="flex-1 bg-cream-100">
            <Tile chosen={p === pet} ready={has(`${p}-awake`)} onClick={() => farm.setPet(p)}>
              <span className="h-16">{has(`${p}-awake`) && <SpriteIcon name={`${p}-awake`} size={64} />}</span>
              <span className="mt-1.5 text-[13px]">{petName[p]}</span>
              {!has(`${p}-awake`) && <span className="text-[12px] text-bark-600">还在画……</span>}
            </Tile>
          </div>
        ))}
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
  const coins = Math.round(useCore()?.progress?.coins ?? 0);
  return (
    <div className="flex flex-col">
      <p className="text-[13px] text-bark-800">商店还在装修，下一版开张。现在有 {coins} 金币，先攒着。</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {shop.map((item) => (
          <div key={item.name} className="flex items-center gap-2 bg-cream-100 p-2.5 opacity-80">
            <SpriteIcon name={item.icon} size={36} />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px]">{item.name}</span>
              <span className="block truncate text-[12px] text-bark-600">{item.note}</span>
            </span>
            <SpriteIcon name="icon-coin" size={16} />
            <span className="text-[13px] text-bark-800">{item.price}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
