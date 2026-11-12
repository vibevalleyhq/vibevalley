import type { JSX } from "@solidjs/web";
import { createSignal, For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { AccountUsage, RuntimeInfo } from "@vibevalley/protocol";

import { aria, useClickAway } from "#/base/dom.tsx";
import { yuan } from "#/base/format.ts";
import { commands } from "#/farm/frames.ts";
import { Phone } from "#/farm/phone/Phone.tsx";
import { PhoneButton } from "#/farm/phone/PhoneButton.tsx";
import { farm, farmRepo, timeOfDay, useFarm } from "#/farm/store.ts";
import { tools } from "#/farm/tools.ts";
import { nextClearing } from "#/farm/world/plots.ts";
import { webRoutes } from "#/farm/world/world.ts";
import { unreadTotal } from "#/features/channel/index.ts";
import { bottleSprite, quotaLevel, quotaOf, resetText, usableRuntimes, windowLabel } from "#/features/runtime/index.ts";
import { orchestratorLookOf } from "#/infra/agents.ts";
import { useCore, useFrames } from "#/infra/frame.ts";
import { ready, useAgents, useRuntimes } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { titleBar } from "#/ui/layout.tsx";
import { CardColors, createPixelAct, PixelCard, PxButton, SpriteIcon } from "#/ui/pixel/index.ts";
import { RuntimeIcon } from "#/ui/pixel/RuntimeIcon.tsx";
import { playSound } from "#/ui/pixel/sound.ts";

import { Friends } from "./Friends";
import { FxLayer } from "./FxLayer";
import { HudCard } from "./HudCard";
import { Overlay } from "./Overlay";
import { clockText, thousands } from "./readout";

const edge = 8;
const gap = 4;
const top = 52;
const bottom = 36;

const styles = {
  repoSignPost: (height: number): JSX.CSSProperties => ({ height: `${height}px` }),
  topLeft: (offsetTop: number): JSX.CSSProperties => ({ top: `${offsetTop}px` }),
  topRight: (offsetTop: number): JSX.CSSProperties => ({ top: `${offsetTop}px` }),
  bottomLeft: (offsetBottom: number): JSX.CSSProperties => ({ bottom: `${offsetBottom}px` }),
};

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

function RepoSign() {
  const screen = useFarm((s) => s.screen);
  const repo = farmRepo;
  const router = useRouter();
  const foot = () => screen()?.toScreen(signFoot);
  return (
    <Show when={foot()}>
      {(at) => (
        <button
          type="button"
          data-testid="repo-sign"
          data-key={repo()}
          aria-label={t("web.farm.sign.label", { repo: repo() || t("web.farm.sign.noRepo") })}
          title={t("web.farm.sign.hint")}
          onClick={() => {
            playSound("open");
            router.navigate("/repos");
          }}
          class="pointer-events-auto absolute flex [translate:-50%_-100%] cursor-pointer flex-col items-center font-pixel hover:[filter:brightness(110%)]"
          style={{ left: `${at().x}px`, top: `${at().y}px` }}
        >
          <span class="flex max-w-40 flex-col items-center border-2 border-bark-900 bg-bark-500 px-2.5 py-1 text-cream-50 pixel-shade">
            <span class="text-[length:10px] leading-3 text-cream-200">{t("web.farm.sign.repo")}</span>
            <span class="max-w-full truncate text-sm leading-xs">{repo() || t("web.farm.sign.noRepo")}</span>
          </span>
          <span class="w-1.5 bg-bark-900" style={styles.repoSignPost(Math.round((screen()?.scale ?? 3) * 5))} />
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
      <RepoSign />
      <Show when={shown()}>
        {(box) => (
          <div
            class="absolute inset-0"
            style={box().w < 680 ? undefined : { left: `${box().x}px`, top: `${box().y}px`, width: `${box().w}px`, height: `${box().h}px` }}
          >
            <TopLeft />
            <TopRight compact={box().w < 680} />
            <BottomLeft compact={box().w < 680} />
            <ToolBar compact={box().w < 680} />
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
    <div class="absolute left-2 flex items-start gap-1" style={styles.topLeft(edge + titleBar.top)}>
      <HudTap label={t("web.farm.hud.look")} testid="hud-orchestrator" onClick={() => open("orchestrator")}>
        <span class="inline-block pr-0.5 pb-0.5">
          <span class="box-border flex w-13.5 h-13 items-center justify-center border-2 border-bark-850 bg-glow-soft pixel-shade">
            <SpriteIcon name={face()} size={top - 8} />
          </span>
        </span>
      </HudTap>
      <HudTap label={t("web.farm.panel.graphs")} testid="hud-graphs" onClick={() => open("graphs")}>
        <span class="inline-block pr-0.5 pb-0.5 text-left">
          <span class="box-border flex h-13 flex-col justify-center border-2 border-bark-850 bg-glow-soft px-1.5 py-0.5 pixel-shade">
            <span class="flex items-center gap-0.75 text-xs leading-2xs">
              <span class="text-card-good">Lv.{level()}</span>
              <SpriteIcon name="icon-coin" size={12} />
              <span>{thousands(coins())}</span>
              <SpriteIcon name="icon-clock" size={12} />
              <span data-testid="farm-clock">{clockText(tod())}</span>
            </span>
            <span class="my-0.5 block h-1.5 w-37.5 bg-cream-200">
              <span class={["block h-full", "bg-agent-stage-edge"]} style={{ width: `${need() === 0 ? 0 : Math.min(100, (lv().xp / need()) * 100)}%` }} />
            </span>
            <span class="text-xs leading-2xs text-card-muted">
              {(() => {
                const target = next();
                return target !== undefined
                  ? t("web.farm.hud.toLevelNext", { xp: Math.round(lv().xp), need: need(), next: target })
                  : t("web.farm.hud.toLevel", { xp: Math.round(lv().xp), need: need() });
              })()}
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

function TopRight(props: { compact: boolean }) {
  const core = useCore();
  const router = useRouter();
  const unread = () => unreadTotal(core()?.chat);
  const go = (path: string) => {
    playSound("open");
    router.navigate(path);
  };
  return (
    <div
      class={["absolute right-2 flex flex-wrap items-start gap-1", props.compact && "left-2"]}
      style={styles.topRight(edge + (props.compact ? top + gap + titleBar.top : 0))}
    >
      <HudTap label={t("web.farm.hud.treeHint")} testid="hud-tree" onClick={() => go("/tree")}>
        <HudCard height={top}>
          <SpriteIcon name="icon-tree" size={20} />
          {t("web.farm.hud.tree")}
        </HudCard>
      </HudTap>
      <Show when={webRoutes.includes("/repos")}>
        <HudTap label={t("web.farm.hud.mapHint")} testid="hud-map" onClick={() => go("/repos")}>
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
            <span class="bg-berry px-1 text-[length:10px] text-cream-50">{unread()}</span>
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

function BottomLeft(props: { compact: boolean }) {
  const phoneOpen = useFarm((s) => s.phoneOpen);
  const box = useFarm((s) => s.screen?.shown);
  // The phone fits between the top row and the two buttons under it, inside the farm's box.
  const room = () => ({ w: (box()?.w ?? 0) - 2 * edge, h: (box()?.h ?? 0) - 2 * edge - top - 2 * bottom - 4 * gap });
  return (
    <div class="absolute left-2 flex flex-col items-start gap-1" style={styles.bottomLeft(edge + (props.compact ? bottom + gap : 0))}>
      <Show when={phoneOpen()}>
        <Phone room={room()} />
      </Show>
      <PhoneButton height={bottom} />
      <Friends height={bottom} />
    </div>
  );
}

function ToolBar(props: { compact: boolean }) {
  const held = useFarm((s) => s.tool);
  return (
    <div class="absolute inset-x-0 bottom-2 flex justify-center gap-1" role="toolbar" aria-label={t("web.farm.hud.tools")}>
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
                class={[
                  "box-border flex h-9 items-center justify-center gap-0.75 border-2 border-bark-850 pixel-shade",
                  props.compact ? "w-11" : "w-13",
                  held() === tool.id ? "bg-leaf-300" : "bg-cream-100",
                ]}
              >
                <span class="text-(length:--text-xs) text-card-muted">{i() + 1}</span>
                <SpriteIcon name={tool.icon} size={24} />
              </span>
            </span>
          </HudTap>
        )}
      </For>
    </div>
  );
}

const levelInk = {
  plenty: "text-leaf-700",
  low: "text-px-quota-low",
  gold: "text-px-quota-low",
  empty: "text-berry-500",
  unknown: "text-bark-500",
} as const;

const levelFill = {
  plenty: "bg-leaf-700",
  low: "bg-px-quota-low",
  gold: "bg-px-quota-low",
  empty: "bg-berry-500",
  unknown: "bg-bark-500",
} as const;

function UsageLines(props: { usage: AccountUsage | null }) {
  return (
    <Switch fallback={<p class="text-(length:--text-xs) text-bark-400">{t("web.farm.quota.unreported")}</p>}>
      <Match when={props.usage?.status === "login_required"}>
        <p class="text-(length:--text-xs) text-wheat-700">{t("web.farm.quota.signedOut")}</p>
      </Match>
      <Match when={props.usage?.status === "unavailable" ? props.usage : undefined}>
        {(u) => <p class="text-(length:--text-xs) text-bark-400">{t("web.farm.quota.unreadable", { why: u().reason })}</p>}
      </Match>
      <Match when={props.usage?.status === "balance" ? props.usage : undefined}>
        {(u) => (
          <p class={["text-(length:--text-xs)", u().available ? "text-bark-900" : "text-berry-500"]}>
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
                  <div class="text-(length:--text-xs)">
                    <div class="flex justify-between gap-2">
                      <span class="truncate">{windowLabel(w.label)}</span>
                      <span class={levelInk[quotaLevel(left())]}>{Math.round(left())}%</span>
                    </div>
                    <span class="block h-1.5 w-full bg-cream-200">
                      <span class={["block h-full", levelFill[quotaLevel(left())]]} style={{ width: `${Math.max(0, Math.min(100, left()))}%` }} />
                    </span>
                    <Show when={w.resetsAt}>{(at) => <span class="text-[length:10px] text-bark-400">{resetText(at())}</span>}</Show>
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
          <span class="text-(length:--text-sm)">{props.info.preset.label}</span>
          <Show when={subscription()}>{(sub) => <span class="truncate text-(length:--text-xs) text-bark-500">{sub()}</span>}</Show>
        </div>
        <UsageLines usage={usage()} />
        {/* Spent today may be 0, which is still said. */}
        <Show when={props.info.spentToday !== undefined ? { spent: props.info.spentToday } : undefined}>
          {(today) => (
            <p class="mt-0.5 text-(length:--text-xs) text-bark-500">
              {(props.info.settings.dailyBudget ?? 0) > 0
                ? t("web.farm.quota.spentTodayBudget", { spent: yuan(today().spent), budget: yuan(props.info.settings.dailyBudget ?? 0) })
                : t("web.farm.quota.spentToday", { spent: yuan(today().spent) })}
            </p>
          )}
        </Show>
        <Show when={props.info.stop}>
          <p class="mt-0.5 text-(length:--text-xs) text-berry">{props.info.stop}</p>
        </Show>
      </div>
      <div class="flex w-12 flex-col items-center">
        <SpriteIcon name={bottleSprite(quota())} size={40} label={quota().text} />
        <span
          class={["text-(length:--text-xs)", quota().level === "unknown" ? "text-bark-400" : quota().level === "empty" ? "text-berry-500" : "text-bark-800"]}
        >
          {quota().short || "—"}
        </span>
      </div>
    </div>
  );
}

/** How much the runtimes' accounts have left: a bottle at the HUD's top right, filled to the lowest of them. */
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
            <SpriteIcon name={bottleSprite({ level: quotaLevel(lowest()), fill: (lowest() ?? 0) / 100, short: "", text: "" })} size={28} />
            <span class={lowest() === undefined ? "text-bark-900" : levelInk[quotaLevel(lowest())]}>
              {shown() === undefined ? t("web.farm.quota.quota") : `${shown()}%`}
            </span>
          </HudCard>
        </button>
        <Show when={open()}>
          <div class="absolute top-full right-0 z-10 mt-2 w-88 bg-cream-50 p-3 shadow-px" role="dialog" aria-label={t("web.farm.quota.left")}>
            <div class="flex items-center">
              <span class="flex-1 text-(length:--text-sm)">{t("web.farm.quota.left")}</span>
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
            <p class="mt-2 text-(length:--text-xs) text-bark-400">{t("web.farm.quota.note")}</p>
          </div>
        </Show>
      </div>
    </Show>
  );
}
