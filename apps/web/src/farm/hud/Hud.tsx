// The farm's HUD over the village: the manager's face and the farm's level, coins
// and clock at the top left; the channels, the quota and the menu at the top right; the phone and the helpers at the
// bottom left; the tools along the bottom. Under it, the words over the village (Overlay.tsx); over it, the effects
// (FxLayer.tsx). Laid out in the part of the village on the page (store screen.shown).

import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useCore, useFrames } from "../../data/frame";
import { unreadTotal } from "../../rules/chat";
import { CardColors, cx, PixelCard, SpriteIcon } from "../kit";
import { playSound } from "../sound";
import { farm, useFarm, useTimeOfDay } from "../store";
import { tools } from "../tools";
import { nextClearing } from "../world/plots";
import { webRoutes } from "../world/places";
import { Phone } from "../phone/Phone";
import { PhoneButton } from "../phone/PhoneButton";
import { Friends } from "./Friends";
import { FxLayer } from "./FxLayer";
import { Overlay } from "./Overlay";
import { QuotaPill } from "./QuotaPill";
import { clockText, thousands } from "./rules";

const edge = 8;
const gap = 4;
const top = 52;
const bottom = 36;

/** A HUD part: a button with its words as a tooltip and an accessible name. */
export function HudTap({ label, onClick, selected, children }: { label: string; onClick: () => void; selected?: boolean; children: ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={selected} onClick={onClick} className="pointer-events-auto cursor-pointer">
      {children}
    </button>
  );
}

/** A wooden card the height of the HUD's row, an icon and words. */
export function HudCard({ height, bright, children }: { height?: number; bright?: boolean; children: ReactNode }) {
  return (
    <span className="inline-block pr-0.5 pb-0.5">
      <span
        className={cx("box-border flex items-center gap-1 border-2 px-2 font-pixel text-[12px]", bright ? "brightness-110" : "")}
        style={{ height, background: CardColors.paper, borderColor: CardColors.ink, color: CardColors.ink, boxShadow: "2px 2px 0 0 #3a2a1899" }}
      >
        {children}
      </span>
    </span>
  );
}

export function Hud() {
  const screen = useFarm((s) => s.screen);
  const shown = screen?.shown;
  return (
    <div className="pointer-events-none absolute inset-0" aria-label="农场的 HUD">
      <Overlay />
      {shown && (
        <div className="absolute" style={{ left: shown.x, top: shown.y, width: shown.w, height: shown.h }}>
          <TopLeft />
          <TopRight />
          <BottomLeft />
          <ToolBar />
        </div>
      )}
      <FxLayer />
    </div>
  );
}

function TopLeft() {
  const { frame } = useFrames();
  const core = useCore();
  const tod = useTimeOfDay();
  const look = useFarm((s) => s.managerLook);
  const lv = frame?.view.level ?? { level: 1, xp: 0, need: 10 };
  const level = Math.round(lv.level);
  const need = Math.round(lv.need);
  const next = nextClearing(level);
  const coins = Math.round(core?.progress?.coins ?? 0);
  const face = look !== "farmer" ? `manager-${look}-face` : "manager-face";
  const open = (panel: "manager" | "graphs") => {
    playSound("open");
    farm.panel(panel);
  };
  return (
    <div className="absolute flex items-start" style={{ left: edge, top: edge, gap }}>
      <HudTap label="换管家的样子" onClick={() => open("manager")}>
        <span className="inline-block pr-0.5 pb-0.5">
          <span
            className="box-border flex items-center justify-center border-2 shadow-[2px_2px_0_0_#3a2a1899]"
            style={{ width: top + 2, height: top, background: CardColors.paper, borderColor: CardColors.ink }}
          >
            <SpriteIcon name={face} size={top - 8} />
          </span>
        </span>
      </HudTap>
      <HudTap label="任务与成就" onClick={() => open("graphs")}>
        <span className="inline-block pr-0.5 pb-0.5 text-left">
          <span
            className="box-border flex flex-col justify-center border-2 px-1.5 py-0.5 shadow-[2px_2px_0_0_#3a2a1899]"
            style={{ height: top, background: CardColors.paper, borderColor: CardColors.ink }}
          >
            <span className="flex items-center gap-[3px] text-[12px] leading-[14px]">
              <span style={{ color: CardColors.good }}>Lv.{level}</span>
              <SpriteIcon name="icon-coin" size={12} />
              <span>{thousands(coins)}</span>
              <SpriteIcon name="icon-clock" size={12} />
              <span data-testid="farm-clock">{clockText(tod)}</span>
            </span>
            <span className="my-0.5 block h-1.5 w-[150px]" style={{ background: CardColors.barTrack }}>
              <span className="block h-full" style={{ width: `${need === 0 ? 0 : Math.min(100, (lv.xp / need) * 100)}%`, background: CardColors.barFill }} />
            </span>
            <span className="text-[12px] leading-[14px]" style={{ color: CardColors.muted }}>
              {Math.round(lv.xp)}/{need} commit{next !== undefined ? ` · Lv.${next} 开垦` : ""}
            </span>
          </span>
        </span>
      </HudTap>
    </div>
  );
}

function TopRight() {
  const core = useCore();
  const navigate = useNavigate();
  const unread = unreadTotal(core?.chat);
  const go = (path: string) => {
    playSound("open");
    void navigate(path);
  };
  return (
    <div className="absolute flex items-start" style={{ right: edge, top: edge, gap }}>
      {webRoutes.includes("/projects") && (
        <HudTap label="地图：每个项目一座岛" onClick={() => go("/projects")}>
          <HudCard height={top}>
            <SpriteIcon name="icon-map" size={20} />
            地图
          </HudCard>
        </HudTap>
      )}
      <HudTap label={unread > 0 ? `频道，${unread} 条没读` : "频道"} onClick={() => go("/chat")}>
        <HudCard height={top}>
          <SpriteIcon name="icon-board" size={20} />
          频道
          {unread > 0 && <span className="bg-berry px-1 text-[10px] text-cream-50">{unread}</span>}
        </HudCard>
      </HudTap>
      <QuotaPill height={top} />
      <HudTap
        label="菜单（Esc）"
        onClick={() => {
          playSound("open");
          farm.menu(true);
        }}
      >
        <PixelCard
          height={top}
          rows={[
            [
              { kind: "words", text: "菜单" },
              { kind: "words", text: "Esc", color: CardColors.muted },
            ],
          ]}
        />
      </HudTap>
    </div>
  );
}

function BottomLeft() {
  const phoneOpen = useFarm((s) => s.phoneOpen);
  return (
    <div className="absolute flex flex-col items-start" style={{ left: edge, bottom: edge, gap }}>
      {phoneOpen && <Phone />}
      <PhoneButton height={bottom} />
      <Friends height={bottom} />
    </div>
  );
}

function ToolBar() {
  const held = useFarm((s) => s.tool);
  return (
    <div className="absolute inset-x-0 flex justify-center" style={{ bottom: edge, gap }} role="toolbar" aria-label="农具">
      {tools.map((tool, i) => (
        <HudTap key={tool.id} label={`${tool.label}：${tool.hint}（${i + 1}）`} selected={held === tool.id} onClick={() => farm.hold(tool.id)}>
          <span className="inline-block pr-0.5 pb-0.5">
            <span
              className="box-border flex items-center justify-center gap-[3px] border-2 shadow-[2px_2px_0_0_#3a2a1899]"
              style={{ width: 52, height: bottom, background: held === tool.id ? CardColors.held : CardColors.slot, borderColor: CardColors.ink }}
            >
              <span className="text-[12px]" style={{ color: CardColors.muted }}>
                {i + 1}
              </span>
              <SpriteIcon name={tool.icon} size={24} />
            </span>
          </span>
        </HudTap>
      ))}
    </div>
  );
}
