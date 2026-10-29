import { t } from "@vibevalley/i18n";
// The farm's HUD over the village: the orchestrator's face and the farm's level, coins and clock at the top left; the
// memory tree, the map, the channels, the quota and the menu at the top right; the phone and the helpers at the bottom left; the tools along the
// bottom. Under it, the words over the village (Overlay.tsx); over it, the effects (FxLayer.tsx). Laid out in the part
// of the village on the page (store screen.shown).

import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { clockText, thousands } from "./readout";
import { playSound } from "@/ui/pixel/sound";
import { farm } from "@/farm/store";
import { tools } from "@/farm/tools";
import { webRoutes } from "@/farm/world/places";
import { nextClearing } from "@/farm/world/plots";
import { unreadTotal } from "@/features/channel";
import { aria } from "@/base/util";
import { useRouter } from "@/base/router";
import { useCore, useFrames } from "@/base/frame";
import { CardColors, PixelCard, SpriteIcon } from "@/ui/pixel";
import { Phone } from "@/farm/phone/Phone";
import { HudCard } from "./HudCard";
import { PhoneButton } from "@/farm/phone/PhoneButton";
import { timeOfDay, useFarm } from "@/farm/ui";
import { Friends } from "./Friends";
import { FxLayer } from "./FxLayer";
import { Overlay } from "./Overlay";
import { ProjectSign } from "./ProjectSign";
import { QuotaPill } from "./QuotaPill";
import { titleBar } from "@/ui/TitleBar";
import { orchestratorLookOf } from "@/base/agents";
import { ready, useAgents } from "@/base/query";

const edge = 8;
const gap = 4;
const top = 52;
const bottom = 36;

/** A HUD part: a button with its words as a tooltip and an accessible name. */
export function HudTap(props: { label: string; testid?: string; onClick: () => void; selected?: boolean; children: JSX.Element }) {
  return (
    <button
      type="button"
      data-testid={props.testid}
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.selected === undefined ? undefined : aria(props.selected)}
      onClick={() => props.onClick()}
      class="pointer-events-auto cursor-pointer"
    >
      {props.children}
    </button>
  );
}

export function Hud() {
  const shown = useFarm((s) => s.screen?.shown);
  return (
    <div class="pointer-events-none absolute inset-0" aria-label={t("web.farm.hud.label")}>
      <Overlay />
      <ProjectSign />
      <Show when={shown()}>
        {(box) => (
          <div class="absolute" style={{ left: `${box().x}px`, top: `${box().y}px`, width: `${box().w}px`, height: `${box().h}px` }}>
            <TopLeft />
            <TopRight />
            <BottomLeft />
            <ToolBar />
          </div>
        )}
      </Show>
      <FxLayer />
    </div>
  );
}

function TopLeft() {
  const router = useRouter();
  const frames = useFrames();
  const core = useCore();
  const tod = timeOfDay();
  const agents = useAgents();
  const look = () => orchestratorLookOf(ready(agents, []));
  const lv = () => frames.frame?.view.level ?? { level: 1, xp: 0, need: 10 };
  const level = () => Math.round(lv().level);
  const need = () => Math.round(lv().need);
  const next = () => nextClearing(level());
  const coins = () => Math.round(core()?.progress?.coins ?? 0);
  const face = () => (look() !== "farmer" ? `manager-${look()}-face` : "manager-face");
  const open = (panel: "orchestrator" | "graphs") => {
    playSound("open");
    farm.panel(panel);
  };
  return (
    <div class="absolute flex items-start" style={{ left: `${edge}px`, top: `${edge + titleBar.top}px`, gap: `${gap}px` }}>
      <HudTap label={t("web.farm.hud.look")} testid="hud-orchestrator" onClick={() => open("orchestrator")}>
        <span class="inline-block pr-0.5 pb-0.5">
          <span
            class="box-border flex items-center justify-center border-2 shadow-px-shade"
            style={{ width: `${top + 2}px`, height: `${top}px`, background: CardColors.paper, "border-color": CardColors.ink }}
          >
            <SpriteIcon name={face()} size={top - 8} />
          </span>
        </span>
      </HudTap>
      <HudTap label={t("web.farm.panel.graphs")} testid="hud-graphs" onClick={() => open("graphs")}>
        <span class="inline-block pr-0.5 pb-0.5 text-left">
          <span
            class="box-border flex flex-col justify-center border-2 px-1.5 py-0.5 shadow-px-shade"
            style={{ height: `${top}px`, background: CardColors.paper, "border-color": CardColors.ink }}
          >
            <span class="flex items-center gap-[3px] text-[12px] leading-[14px]">
              <span style={{ color: CardColors.good }}>Lv.{level()}</span>
              <SpriteIcon name="icon-coin" size={12} />
              <span>{thousands(coins())}</span>
              <SpriteIcon name="icon-clock" size={12} />
              <span data-testid="farm-clock">{clockText(tod())}</span>
            </span>
            <span class="my-0.5 block h-1.5 w-[150px]" style={{ background: CardColors.barTrack }}>
              <span class="block h-full" style={{ width: `${need() === 0 ? 0 : Math.min(100, (lv().xp / need()) * 100)}%`, background: CardColors.barFill }} />
            </span>
            <span class="text-[12px] leading-[14px]" style={{ color: CardColors.muted }}>
              {next() !== undefined
                ? t("web.farm.hud.toLevelNext", { xp: Math.round(lv().xp), need: need(), next: next()! })
                : t("web.farm.hud.toLevel", { xp: Math.round(lv().xp), need: need() })}
            </span>
          </span>
        </span>
      </HudTap>
      {/* A link, so it opens in a new tab too; in the row, so it covers nothing. */}
      <a
        href="/issues"
        data-testid="to-workbench"
        title={t("web.farm.hud.workbenchHint")}
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          playSound("open");
          router.navigate("/issues");
        }}
        class="pointer-events-auto cursor-pointer"
      >
        <HudCard height={top}>
          <SpriteIcon name="icon-tasks" size={20} />
          {t("web.farm.hud.workbench")}
        </HudCard>
      </a>
    </div>
  );
}

function TopRight() {
  const core = useCore();
  const router = useRouter();
  const unread = () => unreadTotal(core()?.chat);
  const go = (path: string) => {
    playSound("open");
    router.navigate(path);
  };
  return (
    <div class="absolute flex items-start" style={{ right: `${edge}px`, top: `${edge}px`, gap: `${gap}px` }}>
      <HudTap label={t("web.farm.hud.treeHint")} testid="hud-tree" onClick={() => go("/tree")}>
        <HudCard height={top}>
          <SpriteIcon name="icon-tree" size={20} />
          {t("web.farm.hud.tree")}
        </HudCard>
      </HudTap>
      <Show when={webRoutes.includes("/projects")}>
        <HudTap label={t("web.farm.hud.mapHint")} testid="hud-map" onClick={() => go("/projects")}>
          <HudCard height={top}>
            <SpriteIcon name="icon-map" size={20} />
            {t("web.farm.hud.map")}
          </HudCard>
        </HudTap>
      </Show>
      <HudTap
        label={unread() > 0 ? t("web.farm.hud.channelsUnread", { n: unread() }) : t("web.farm.chat.channels")}
        testid="hud-chat"
        onClick={() => go("/chat")}
      >
        <HudCard height={top}>
          <SpriteIcon name="icon-board" size={20} />
          {t("web.farm.chat.channels")}
          <Show when={unread() > 0}>
            <span class="bg-berry px-1 text-[10px] text-cream-50">{unread()}</span>
          </Show>
        </HudCard>
      </HudTap>
      <QuotaPill height={top} />
      <HudTap
        label={t("web.farm.hud.menuHint")}
        testid="hud-menu"
        onClick={() => {
          playSound("open");
          farm.menu(true);
        }}
      >
        <PixelCard
          height={top}
          rows={[
            [
              { kind: "words", text: t("web.farm.panel.menu") },
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
  const box = useFarm((s) => s.screen?.shown);
  // The phone fits between the top row and the two buttons under it, inside the farm's box.
  const room = () => ({ w: (box()?.w ?? 0) - 2 * edge, h: (box()?.h ?? 0) - 2 * edge - top - 2 * bottom - 4 * gap });
  return (
    <div class="absolute flex flex-col items-start" style={{ left: `${edge}px`, bottom: `${edge}px`, gap: `${gap}px` }}>
      <Show when={phoneOpen()}>
        <Phone room={room()} />
      </Show>
      <PhoneButton height={bottom} />
      <Friends height={bottom} />
    </div>
  );
}

function ToolBar() {
  const held = useFarm((s) => s.tool);
  return (
    <div class="absolute inset-x-0 flex justify-center" style={{ bottom: `${edge}px`, gap: `${gap}px` }} role="toolbar" aria-label={t("web.farm.hud.tools")}>
      <For each={tools}>
        {(tool, i) => (
          <HudTap
            label={t("shared.join.aside", { text: t("shared.join.labeled", { label: tool.label, text: tool.hint }), aside: i() + 1 })}
            testid={`tool-${tool.id}`}
            selected={held() === tool.id}
            onClick={() => farm.hold(tool.id)}
          >
            <span class="inline-block pr-0.5 pb-0.5">
              <span
                class="box-border flex items-center justify-center gap-[3px] border-2 shadow-px-shade"
                style={{
                  width: "52px",
                  height: `${bottom}px`,
                  background: held() === tool.id ? CardColors.held : CardColors.slot,
                  "border-color": CardColors.ink,
                }}
              >
                <span class="text-[12px]" style={{ color: CardColors.muted }}>
                  {i() + 1}
                </span>
                <SpriteIcon name={tool.icon} size={24} />
              </span>
            </span>
          </HudTap>
        )}
      </For>
    </div>
  );
}
