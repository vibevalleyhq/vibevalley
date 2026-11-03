// The farm's HUD over the village: the orchestrator's face and the farm's level, coins and clock at the top left; the
// memory tree, the map, the channels, the quota and the menu at the top right; the phone and the helpers at the bottom left; the tools along the
// bottom. Under it, the words over the village (Overlay.tsx); over it, the effects (FxLayer.tsx). Laid out in the part
// of the village on the page (store screen.shown).

import type { JSX } from "@solidjs/web";
import { createSignal, For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { AccountUsage, RuntimeInfo } from "@vibevalley/protocol";

import { aria, useClickAway } from "@/base/dom";
import { yuan } from "@/base/format";
import { commands } from "@/farm/frames";
import { Phone } from "@/farm/phone/Phone";
import { PhoneButton } from "@/farm/phone/PhoneButton";
import { farm, farmProject, timeOfDay, useFarm } from "@/farm/store";
import { tools } from "@/farm/tools";
import { nextClearing } from "@/farm/world/plots";
import { webRoutes } from "@/farm/world/world";
import { unreadTotal } from "@/features/channel";
import { bottleSprite, quotaLevel, quotaOf, resetText, usableRuntimes, windowLabel } from "@/features/runtime";
import { orchestratorLookOf } from "@/infra/agents";
import { useCore, useFrames } from "@/infra/frame";
import { ready, useAgents, useRuntimes } from "@/infra/query";
import { useRouter } from "@/infra/router";
import { titleBar } from "@/ui/layout";
import { CardColors, createPixelAct, PixelCard, PxButton, SpriteIcon } from "@/ui/pixel";
import { RuntimeIcon } from "@/ui/pixel/RuntimeIcon";
import { playSound } from "@/ui/pixel/sound";

import { Friends } from "./Friends";
import { FxLayer } from "./FxLayer";
import { HudCard } from "./HudCard";
import { Overlay } from "./Overlay";
import { clockText, thousands } from "./readout";

const edge = 8;
const gap = 4;
const top = 52;
const bottom = 36;

/** A HUD part: a button with its words as a tooltip and an accessible name. */
function HudTap(props: { label: string; testid?: string; onClick: () => void; selected?: boolean; children: JSX.Element }) {
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

/** Where the sign's post stands, in the village's pixels: on the grass right of the mast (village.ldtk: its top at 18, 73). */
const signFoot = { x: 44, y: 104 };

/** The project sign by the mast: whose farm this is (every plot here is that project's); a click goes back to the projects' map to enter another island. */
function ProjectSign() {
  const screen = useFarm((s) => s.screen);
  const project = farmProject;
  const router = useRouter();
  const foot = () => screen()?.toScreen(signFoot);
  return (
    <Show when={foot()}>
      {(at) => (
        <button
          type="button"
          data-testid="project-sign"
          data-key={project()}
          aria-label={t("web.farm.sign.label", { project: project() || t("web.farm.sign.noProject") })}
          title={t("web.farm.sign.hint")}
          onClick={() => {
            playSound("open");
            router.navigate("/projects");
          }}
          class="pointer-events-auto absolute flex -translate-x-1/2 -translate-y-full cursor-pointer flex-col items-center font-pixel hover:brightness-110"
          style={{ left: `${at().x}px`, top: `${at().y}px` }}
        >
          <span class="flex max-w-40 flex-col items-center border-2 border-bark-900 bg-bark-500 px-2.5 py-1 text-cream-50 shadow-px-shade">
            <span class="text-[10px] leading-3 text-cream-200">{t("web.farm.sign.project")}</span>
            <span class="max-w-full truncate text-[13px] leading-4">{project() || t("web.farm.sign.noProject")}</span>
          </span>
          <span class="w-1.5 bg-bark-900" style={{ height: `${Math.round((screen()?.scale ?? 3) * 5)}px` }} />
        </button>
      )}
    </Show>
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

const levelInk = { plenty: "#3f6427", low: "#b8862a", gold: "#b8862a", empty: "#c84a3a", unknown: "#7f5b3b" } as const;

function UsageLines(props: { usage: AccountUsage | null }) {
  return (
    <Switch fallback={<p class="text-[12px] text-bark-400">{t("web.farm.quota.unreported")}</p>}>
      <Match when={props.usage?.status === "login_required"}>
        <p class="text-[12px] text-wheat-700">{t("web.farm.quota.signedOut")}</p>
      </Match>
      <Match when={props.usage?.status === "unavailable" ? props.usage : undefined}>
        {(u) => <p class="text-[12px] text-bark-400">{t("web.farm.quota.unreadable", { why: u().reason })}</p>}
      </Match>
      <Match when={props.usage?.status === "balance" ? props.usage : undefined}>
        {(u) => (
          <p class="text-[12px]" style={{ color: u().available ? "#2f1f13" : "#c84a3a" }}>
            {t("web.farm.quota.balance", { provider: u().provider, enough: u().available })}
          </p>
        )}
      </Match>
      <Match when={props.usage?.status === "ok" ? props.usage : undefined}>
        {(u) => (
          <div class="mt-1 flex flex-col gap-1">
            <For each={u().windows}>
              {(w) => {
                const left = () => 100 - w.usedPercent;
                return (
                  <div class="text-[12px]">
                    <div class="flex justify-between gap-2">
                      <span class="truncate">{windowLabel(w.label)}</span>
                      <span style={{ color: levelInk[quotaLevel(left())] }}>{Math.round(left())}%</span>
                    </div>
                    <span class="block h-1.5 w-full" style={{ background: CardColors.barTrack }}>
                      <span class="block h-full" style={{ width: `${Math.max(0, Math.min(100, left()))}%`, background: levelInk[quotaLevel(left())] }} />
                    </span>
                    <Show when={w.resetsAt}>{(at) => <span class="text-[10px] text-bark-400">{resetText(at())}</span>}</Show>
                  </div>
                );
              }}
            </For>
          </div>
        )}
      </Match>
    </Switch>
  );
}

function Machine(props: { info: RuntimeInfo }) {
  const quota = () => quotaOf(props.info);
  const usage = () => props.info.usage;
  const subscription = () => {
    const u = usage();
    return u?.status === "ok" ? u.subscription : undefined;
  };
  return (
    <div class="flex gap-2.5 border-[1.5px] border-cream-200 bg-cream-100 p-2" data-testid="quota-machine">
      <RuntimeIcon runtime={props.info.id} size={34} />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5">
          <span class="text-[13px]">{props.info.preset.label}</span>
          <Show when={subscription()}>{(sub) => <span class="truncate text-[12px] text-bark-500">{sub()}</span>}</Show>
        </div>
        <UsageLines usage={usage()} />
        {/* Spent today may be 0, which is still said. */}
        <Show when={props.info.spentToday !== undefined ? { spent: props.info.spentToday } : undefined}>
          {(today) => (
            <p class="mt-0.5 text-[12px] text-bark-500">
              {(props.info.settings.dailyBudget ?? 0) > 0
                ? t("web.farm.quota.spentTodayBudget", { spent: yuan(today().spent), budget: yuan(props.info.settings.dailyBudget ?? 0) })
                : t("web.farm.quota.spentToday", { spent: yuan(today().spent) })}
            </p>
          )}
        </Show>
        <Show when={props.info.stop}>
          <p class="mt-0.5 text-[12px] text-berry">{props.info.stop}</p>
        </Show>
      </div>
      <div class="flex w-12 flex-col items-center">
        <SpriteIcon name={bottleSprite(quota())} size={40} label={quota().text} />
        <span class="text-[12px]" style={{ color: quota().level === "unknown" ? "#9b7550" : quota().level === "empty" ? "#c84a3a" : "#46301d" }}>
          {quota().short || "—"}
        </span>
      </div>
    </div>
  );
}

/**
 * How much the runtimes' accounts have left: a bottle at the HUD's top right, filled to the lowest of them; open, each
 * runtime's machine, usage windows, today's spend and a stop it is under.
 */
function QuotaPill(props: { height: number }) {
  const all = useRuntimes();
  const runtimes = () => usableRuntimes(ready(all, []));
  const [open, setOpen] = createSignal(false);
  const act = createPixelAct();
  const box = useClickAway(open, () => setOpen(false));
  const lowest = () => {
    const lefts = runtimes().flatMap((r) => (r.quota?.left === undefined ? [] : [r.quota.left]));
    return lefts.length > 0 ? Math.min(...lefts) : undefined;
  };
  const shown = () => {
    const l = lowest();
    return l === undefined ? undefined : Math.round(l);
  };
  return (
    <Show when={runtimes().length > 0}>
      <div ref={box} class="pointer-events-auto relative">
        <button
          type="button"
          aria-label={shown() === undefined ? t("web.farm.quota.all") : t("web.farm.quota.lowest", { pct: String(shown()) })}
          aria-expanded={aria(open())}
          onClick={() => setOpen(!open())}
          class="cursor-pointer"
        >
          <HudCard height={props.height} bright={open()}>
            <SpriteIcon
              name={bottleSprite({ level: quotaLevel(lowest()), fill: lowest() === undefined ? 0 : lowest()! / 100, short: "", text: "" })}
              size={28}
            />
            <span style={{ color: lowest() === undefined ? "#2f1f13" : levelInk[quotaLevel(lowest())] }}>
              {shown() === undefined ? t("web.farm.quota.quota") : `${shown()}%`}
            </span>
          </HudCard>
        </button>
        <Show when={open()}>
          <div class="absolute top-full right-0 z-10 mt-2 w-[352px] bg-cream-50 p-3 shadow-px" role="dialog" aria-label={t("web.farm.quota.left")}>
            <div class="flex items-center">
              <span class="flex-1 text-[13px]">{t("web.farm.quota.left")}</span>
              <PxButton
                size="icon"
                label={t("web.farm.quota.refresh")}
                disabled={act.busy()}
                onClick={() => {
                  const ids = runtimes().map((r) => r.id);
                  void act.run(() => Promise.all(ids.map((id) => commands.refreshRuntime(id))));
                }}
              >
                <SpriteIcon name="button-refresh" size={14} />
              </PxButton>
            </div>
            <div class="mt-2 flex max-h-[min(512px,70vh)] flex-col gap-3 overflow-y-auto">
              <For each={runtimes()} keyed={(r) => r.id}>
                {(r) => <Machine info={r()} />}
              </For>
            </div>
            <p class="mt-2 text-[12px] text-bark-400">{t("web.farm.quota.note")}</p>
          </div>
        </Show>
      </div>
    </Show>
  );
}
