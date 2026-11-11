import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
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
import { styleProps } from "#/ui/positioner.ts";

import { Friends } from "./Friends";
import { FxLayer } from "./FxLayer";
import { HudCard } from "./HudCard";
import { Overlay } from "./Overlay";
import { clockText, thousands } from "./readout";

const edge = 8;
const gap = 4;
const top = 52;
const bottom = 36;

const styles = stylex.create({
  quotaPopup: {
    position: "absolute",
    top: "100%",
    right: "0",
    zIndex: "10",
    marginTop: "0.5rem",
    width: "352px",
    backgroundColor: "var(--color-cream-50)",
    padding: "0.75rem",
    boxShadow: "var(--shadow-px)",
  },
  hudTap: {
    pointerEvents: "auto",
    cursor: "pointer",
  },
  repoSign: {
    pointerEvents: "auto",
    position: "absolute",
    display: "flex",
    translate: "-50% -100%",
    cursor: "pointer",
    flexDirection: "column",
    alignItems: "center",
    fontFamily: "var(--font-pixel)",
    filter: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "brightness(110%)",
      },
    },
  },
  repoSignBoard: {
    display: "flex",
    maxWidth: "10rem",
    flexDirection: "column",
    alignItems: "center",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-bark-500)",
    paddingInline: "0.625rem",
    paddingBlock: "0.25rem",
    color: "var(--color-cream-50)",
    boxShadow: "2px 2px 0 0 var(--color-px-shade)",
  },
  repoSignLabel: {
    fontSize: "10px",
    lineHeight: "0.75rem",
    color: "var(--color-cream-200)",
  },
  repoSignName: {
    maxWidth: "100%",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "13px",
    lineHeight: "1rem",
  },
  repoSignPost: (height: number) => ({
    width: "0.375rem",
    backgroundColor: "var(--color-bark-900)",
    height,
  }),
  hud: {
    pointerEvents: "none",
    position: "absolute",
    inset: "0",
  },
  hudFrame: {
    position: "absolute",
    inset: "0",
  },
  topLeft: (offsetTop: number) => ({
    position: "absolute",
    left: edge,
    top: offsetTop,
    display: "flex",
    alignItems: "flex-start",
    gap,
  }),
  cardShadowWrap: {
    display: "inline-block",
    paddingRight: "0.125rem",
    paddingBottom: "0.125rem",
  },
  faceBox: {
    boxSizing: "border-box",
    display: "flex",
    width: top + 2,
    height: top,
    alignItems: "center",
    justifyContent: "center",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-850)",
    backgroundColor: "var(--color-glow-soft)",
    boxShadow: "2px 2px 0 0 var(--color-px-shade)",
  },
  statusWrap: {
    display: "inline-block",
    paddingRight: "0.125rem",
    paddingBottom: "0.125rem",
    textAlign: "left",
  },
  statusBox: {
    boxSizing: "border-box",
    display: "flex",
    height: top,
    flexDirection: "column",
    justifyContent: "center",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-850)",
    backgroundColor: "var(--color-glow-soft)",
    paddingInline: "0.375rem",
    paddingBlock: "0.125rem",
    boxShadow: "2px 2px 0 0 var(--color-px-shade)",
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: "3px",
    fontSize: "12px",
    lineHeight: "14px",
  },
  levelGood: {
    color: "var(--color-card-good)",
  },
  xpTrack: {
    marginBlock: "0.125rem",
    display: "block",
    height: "0.375rem",
    width: "150px",
    backgroundColor: "var(--color-cream-200)",
  },
  barFill: {
    display: "block",
    height: "100%",
  },
  xpFill: {
    backgroundColor: "var(--color-agent-stage-edge)",
  },
  statusNote: {
    fontSize: "12px",
    lineHeight: "14px",
    color: "var(--color-card-muted)",
  },
  topRight: (offsetTop: number) => ({
    position: "absolute",
    right: edge,
    top: offsetTop,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap,
  }),
  topRightCompact: {
    left: edge,
  },
  unreadCount: {
    backgroundColor: "var(--color-berry)",
    paddingInline: "0.25rem",
    fontSize: "10px",
    color: "var(--color-cream-50)",
  },
  bottomLeft: (offsetBottom: number) => ({
    position: "absolute",
    left: edge,
    bottom: offsetBottom,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap,
  }),
  toolBar: {
    position: "absolute",
    insetInline: "0",
    bottom: edge,
    display: "flex",
    justifyContent: "center",
    gap,
  },
  toolSlot: {
    boxSizing: "border-box",
    display: "flex",
    height: bottom,
    alignItems: "center",
    justifyContent: "center",
    gap: "3px",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-850)",
    boxShadow: "2px 2px 0 0 var(--color-px-shade)",
  },
  toolSlotWide: {
    width: "52px",
  },
  toolSlotCompact: {
    width: "44px",
  },
  toolSlotHeld: {
    backgroundColor: "var(--color-leaf-300)",
  },
  toolSlotIdle: {
    backgroundColor: "var(--color-cream-100)",
  },
  toolKey: {
    fontSize: "12px",
    color: "var(--color-card-muted)",
  },
  smallText: {
    fontSize: "12px",
  },
  inkBark900: {
    color: "var(--color-bark-900)",
  },
  inkBark800: {
    color: "var(--color-bark-800)",
  },
  inkBark500: {
    color: "var(--color-bark-500)",
  },
  inkBark400: {
    color: "var(--color-bark-400)",
  },
  inkBerry: {
    color: "var(--color-berry-500)",
  },
  inkPlenty: {
    color: "var(--color-leaf-700)",
  },
  inkLow: {
    color: "var(--color-px-quota-low)",
  },
  fillPlenty: {
    backgroundColor: "var(--color-leaf-700)",
  },
  fillLow: {
    backgroundColor: "var(--color-px-quota-low)",
  },
  fillEmpty: {
    backgroundColor: "var(--color-berry-500)",
  },
  fillUnknown: {
    backgroundColor: "var(--color-bark-500)",
  },
  usageMuted: {
    fontSize: "12px",
    color: "var(--color-bark-400)",
  },
  usageWarn: {
    fontSize: "12px",
    color: "var(--color-wheat-700)",
  },
  usageWindows: {
    marginTop: "0.25rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  usageHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: "0.5rem",
  },
  usageLabel: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  usageTrack: {
    display: "block",
    height: "0.375rem",
    width: "100%",
    backgroundColor: "var(--color-cream-200)",
  },
  usageReset: {
    fontSize: "10px",
    color: "var(--color-bark-400)",
  },
  quotaMachine: {
    display: "flex",
    gap: "0.625rem",
    borderStyle: "solid",
    borderWidth: "1.5px",
    borderColor: "var(--color-cream-200)",
    backgroundColor: "var(--color-cream-100)",
    padding: "0.5rem",
  },
  machineBody: {
    minWidth: "0",
    flex: "1",
  },
  machineHeader: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
  },
  machineTitle: {
    fontSize: "13px",
  },
  machineSub: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "12px",
    color: "var(--color-bark-500)",
  },
  machineNote: {
    marginTop: "0.125rem",
    fontSize: "12px",
    color: "var(--color-bark-500)",
  },
  machineStop: {
    marginTop: "0.125rem",
    fontSize: "12px",
    color: "var(--color-berry)",
  },
  machineBottle: {
    display: "flex",
    width: "3rem",
    flexDirection: "column",
    alignItems: "center",
  },
  quotaPill: {
    pointerEvents: "auto",
    position: "relative",
  },
  quotaPillButton: {
    cursor: "pointer",
  },
  quotaDialogHeader: {
    display: "flex",
    alignItems: "center",
  },
  quotaDialogTitle: {
    flex: "1",
    fontSize: "13px",
  },
  quotaMachineList: {
    marginTop: "0.5rem",
    display: "flex",
    maxHeight: "min(512px,70vh)",
    flexDirection: "column",
    gap: "0.75rem",
    overflowY: "auto",
  },
  quotaDialogNote: {
    marginTop: "0.5rem",
    fontSize: "12px",
    color: "var(--color-bark-400)",
  },
});

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
      {...stylex.attrs(styles.hudTap)}
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
          {...stylex.attrs(styles.repoSign)}
          style={{ left: `${at().x}px`, top: `${at().y}px` }}
        >
          <span {...stylex.attrs(styles.repoSignBoard)}>
            <span {...stylex.attrs(styles.repoSignLabel)}>{t("web.farm.sign.repo")}</span>
            <span {...stylex.attrs(styles.repoSignName)}>{repo() || t("web.farm.sign.noRepo")}</span>
          </span>
          <span {...styleProps(styles.repoSignPost(Math.round((screen()?.scale ?? 3) * 5)))} />
        </button>
      )}
    </Show>
  );
}

export function Hud() {
  const shown = useFarm((s) => s.screen?.shown);
  return (
    <div {...stylex.attrs(styles.hud)} aria-label={t("web.farm.hud.label")}>
      <Overlay />
      <RepoSign />
      <Show when={shown()}>
        {(box) => (
          <div
            {...stylex.attrs(styles.hudFrame)}
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
    <div {...styleProps(styles.topLeft(edge + titleBar.top))}>
      <HudTap label={t("web.farm.hud.look")} testid="hud-orchestrator" onClick={() => open("orchestrator")}>
        <span {...stylex.attrs(styles.cardShadowWrap)}>
          <span {...stylex.attrs(styles.faceBox)}>
            <SpriteIcon name={face()} size={top - 8} />
          </span>
        </span>
      </HudTap>
      <HudTap label={t("web.farm.panel.graphs")} testid="hud-graphs" onClick={() => open("graphs")}>
        <span {...stylex.attrs(styles.statusWrap)}>
          <span {...stylex.attrs(styles.statusBox)}>
            <span {...stylex.attrs(styles.statusRow)}>
              <span {...stylex.attrs(styles.levelGood)}>Lv.{level()}</span>
              <SpriteIcon name="icon-coin" size={12} />
              <span>{thousands(coins())}</span>
              <SpriteIcon name="icon-clock" size={12} />
              <span data-testid="farm-clock">{clockText(tod())}</span>
            </span>
            <span {...stylex.attrs(styles.xpTrack)}>
              <span {...stylex.attrs(styles.barFill, styles.xpFill)} style={{ width: `${need() === 0 ? 0 : Math.min(100, (lv().xp / need()) * 100)}%` }} />
            </span>
            <span {...stylex.attrs(styles.statusNote)}>
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
        {...stylex.attrs(styles.hudTap)}
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
    <div {...styleProps([styles.topRight(edge + (props.compact ? top + gap + titleBar.top : 0)), props.compact && styles.topRightCompact])}>
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
            <span {...stylex.attrs(styles.unreadCount)}>{unread()}</span>
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
    <div {...styleProps(styles.bottomLeft(edge + (props.compact ? bottom + gap : 0)))}>
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
    <div {...stylex.attrs(styles.toolBar)} role="toolbar" aria-label={t("web.farm.hud.tools")}>
      <For each={tools}>
        {(tool, i) => (
          <HudTap
            label={t("shared.join.aside", { text: t("shared.join.labeled", { label: tool.label, text: tool.hint }), aside: i() + 1 })}
            testid={`tool-${tool.id}`}
            selected={held() === tool.id}
            onClick={() => farm.hold(tool.id)}
          >
            <span {...stylex.attrs(styles.cardShadowWrap)}>
              <span
                {...stylex.attrs(
                  styles.toolSlot,
                  props.compact ? styles.toolSlotCompact : styles.toolSlotWide,
                  held() === tool.id ? styles.toolSlotHeld : styles.toolSlotIdle,
                )}
              >
                <span {...stylex.attrs(styles.toolKey)}>{i() + 1}</span>
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
  plenty: styles.inkPlenty,
  low: styles.inkLow,
  gold: styles.inkLow,
  empty: styles.inkBerry,
  unknown: styles.inkBark500,
} as const;

const levelFill = {
  plenty: styles.fillPlenty,
  low: styles.fillLow,
  gold: styles.fillLow,
  empty: styles.fillEmpty,
  unknown: styles.fillUnknown,
} as const;

function UsageLines(props: { usage: AccountUsage | null }) {
  return (
    <Switch fallback={<p {...stylex.attrs(styles.usageMuted)}>{t("web.farm.quota.unreported")}</p>}>
      <Match when={props.usage?.status === "login_required"}>
        <p {...stylex.attrs(styles.usageWarn)}>{t("web.farm.quota.signedOut")}</p>
      </Match>
      <Match when={props.usage?.status === "unavailable" ? props.usage : undefined}>
        {(u) => <p {...stylex.attrs(styles.usageMuted)}>{t("web.farm.quota.unreadable", { why: u().reason })}</p>}
      </Match>
      <Match when={props.usage?.status === "balance" ? props.usage : undefined}>
        {(u) => (
          <p {...stylex.attrs(styles.smallText, u().available ? styles.inkBark900 : styles.inkBerry)}>
            {t("web.farm.quota.balance", { provider: u().provider, enough: u().available })}
          </p>
        )}
      </Match>
      <Match when={props.usage?.status === "ok" ? props.usage : undefined}>
        {(u) => (
          <div {...stylex.attrs(styles.usageWindows)}>
            <For each={u().windows}>
              {(w) => {
                const left = () => 100 - w.usedPercent;
                return (
                  <div {...stylex.attrs(styles.smallText)}>
                    <div {...stylex.attrs(styles.usageHeader)}>
                      <span {...stylex.attrs(styles.usageLabel)}>{windowLabel(w.label)}</span>
                      <span {...stylex.attrs(levelInk[quotaLevel(left())])}>{Math.round(left())}%</span>
                    </div>
                    <span {...stylex.attrs(styles.usageTrack)}>
                      <span {...stylex.attrs(styles.barFill, levelFill[quotaLevel(left())])} style={{ width: `${Math.max(0, Math.min(100, left()))}%` }} />
                    </span>
                    <Show when={w.resetsAt}>{(at) => <span {...stylex.attrs(styles.usageReset)}>{resetText(at())}</span>}</Show>
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
  // A function declaration: StyleX evaluates an arrow used in `stylex.attrs` at build time and fails on its body.
  function quota() {
    return quotaOf(props.info);
  }
  const usage = () => props.info.usage;
  const subscription = () => {
    const u = usage();
    return u?.status === "ok" ? u.subscription : undefined;
  };
  return (
    <div {...stylex.attrs(styles.quotaMachine)} data-testid="quota-machine">
      <RuntimeIcon runtime={props.info.id} size={34} />
      <div {...stylex.attrs(styles.machineBody)}>
        <div {...stylex.attrs(styles.machineHeader)}>
          <span {...stylex.attrs(styles.machineTitle)}>{props.info.preset.label}</span>
          <Show when={subscription()}>{(sub) => <span {...stylex.attrs(styles.machineSub)}>{sub()}</span>}</Show>
        </div>
        <UsageLines usage={usage()} />
        {/* Spent today may be 0, which is still said. */}
        <Show when={props.info.spentToday !== undefined ? { spent: props.info.spentToday } : undefined}>
          {(today) => (
            <p {...stylex.attrs(styles.machineNote)}>
              {(props.info.settings.dailyBudget ?? 0) > 0
                ? t("web.farm.quota.spentTodayBudget", { spent: yuan(today().spent), budget: yuan(props.info.settings.dailyBudget ?? 0) })
                : t("web.farm.quota.spentToday", { spent: yuan(today().spent) })}
            </p>
          )}
        </Show>
        <Show when={props.info.stop}>
          <p {...stylex.attrs(styles.machineStop)}>{props.info.stop}</p>
        </Show>
      </div>
      <div {...stylex.attrs(styles.machineBottle)}>
        <SpriteIcon name={bottleSprite(quota())} size={40} label={quota().text} />
        <span
          {...stylex.attrs(styles.smallText, quota().level === "unknown" ? styles.inkBark400 : quota().level === "empty" ? styles.inkBerry : styles.inkBark800)}
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
      <div ref={box} {...stylex.attrs(styles.quotaPill)}>
        <button
          type="button"
          aria-label={shown() === undefined ? t("web.farm.quota.all") : t("web.farm.quota.lowest", { pct: String(shown()) })}
          aria-expanded={aria(open())}
          onClick={() => setOpen(!open())}
          {...stylex.attrs(styles.quotaPillButton)}
        >
          <HudCard height={props.height} bright={open()}>
            <SpriteIcon name={bottleSprite({ level: quotaLevel(lowest()), fill: (lowest() ?? 0) / 100, short: "", text: "" })} size={28} />
            <span {...stylex.attrs(lowest() === undefined ? styles.inkBark900 : levelInk[quotaLevel(lowest())])}>
              {shown() === undefined ? t("web.farm.quota.quota") : `${shown()}%`}
            </span>
          </HudCard>
        </button>
        <Show when={open()}>
          <div {...stylex.attrs(styles.quotaPopup)} role="dialog" aria-label={t("web.farm.quota.left")}>
            <div {...stylex.attrs(styles.quotaDialogHeader)}>
              <span {...stylex.attrs(styles.quotaDialogTitle)}>{t("web.farm.quota.left")}</span>
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
            <div {...stylex.attrs(styles.quotaMachineList)}>
              <For each={runtimes()} keyed={(r) => r.id}>
                {(r) => <Machine info={r()} />}
              </For>
            </div>
            <p {...stylex.attrs(styles.quotaDialogNote)}>{t("web.farm.quota.note")}</p>
          </div>
        </Show>
      </div>
    </Show>
  );
}
