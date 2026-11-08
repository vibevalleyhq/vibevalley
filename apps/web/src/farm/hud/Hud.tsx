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

import { Friends } from "./Friends";
import { FxLayer } from "./FxLayer";
import { HudCard } from "./HudCard";
import { Overlay } from "./Overlay";
import { clockText, thousands } from "./readout";

const recipeStyles = stylex.create({
  quotaPillDiv: {
    position: "absolute",
    top: "100%",
    right: "0",
    zIndex: "10",
    marginTop: "calc(var(--spacing) * 2)",
    width: "352px",
    backgroundColor: "var(--color-cream-50)",
    padding: "calc(var(--spacing) * 3)",
    boxShadow: "0 0 transparent,0 0 transparent,0 0 transparent,0 0 transparent,var(--shadow-px)",
  },
});

const viewStyles = stylex.create({
  hudTapButton: {
    pointerEvents: "auto",
    cursor: "pointer",
  },
  repoSign: {
    pointerEvents: "auto",
    position: "absolute",
    display: "flex",
    translate: "calc(calc(1 / 2 * 100%) * -1) -100%",
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
  repoSignSpan: {
    display: "flex",
    maxWidth: "calc(var(--spacing) * 40)",
    flexDirection: "column",
    alignItems: "center",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-bark-500)",
    paddingInline: "calc(var(--spacing) * 2.5)",
    paddingBlock: "var(--spacing)",
    color: "var(--color-cream-50)",
    boxShadow: "0 0 transparent, 0 0 transparent, 0 0 transparent, 0 0 transparent, 2px 2px 0 0 var(--color-px-shade)",
  },
  repoSignSpan2: {
    fontSize: "10px",
    lineHeight: "calc(var(--spacing) * 3)",
    color: "var(--color-cream-200)",
  },
  repoSignSpan3: {
    maxWidth: "100%",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "13px",
    lineHeight: "calc(var(--spacing) * 4)",
  },
  repoSignSpan4: {
    width: "calc(var(--spacing) * 1.5)",
    backgroundColor: "var(--color-bark-900)",
  },
  hudDiv: {
    pointerEvents: "none",
    position: "absolute",
    inset: "0",
  },
  hudDiv2: {
    position: "absolute",
    inset: "0",
  },
  topLeftDiv: {
    position: "absolute",
    display: "flex",
    alignItems: "flex-start",
  },
  topLeftSpan: {
    display: "inline-block",
    paddingRight: "calc(var(--spacing) * .5)",
    paddingBottom: "calc(var(--spacing) * .5)",
  },
  topLeftSpan2: {
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderStyle: "solid",
    borderWidth: "2px",
    boxShadow: "0 0 transparent, 0 0 transparent, 0 0 transparent, 0 0 transparent, 2px 2px 0 0 var(--color-px-shade)",
  },
  topLeftSpan3: {
    display: "inline-block",
    paddingRight: "calc(var(--spacing) * .5)",
    paddingBottom: "calc(var(--spacing) * .5)",
    textAlign: "left",
  },
  topLeftSpan4: {
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    borderStyle: "solid",
    borderWidth: "2px",
    paddingInline: "calc(var(--spacing) * 1.5)",
    paddingBlock: "calc(var(--spacing) * .5)",
    boxShadow: "0 0 transparent, 0 0 transparent, 0 0 transparent, 0 0 transparent, 2px 2px 0 0 var(--color-px-shade)",
  },
  topLeftSpan5: {
    display: "flex",
    alignItems: "center",
    gap: "3px",
    fontSize: "12px",
    lineHeight: "14px",
  },
  topLeftSpan6: {
    marginBlock: "calc(var(--spacing) * .5)",
    display: "block",
    height: "calc(var(--spacing) * 1.5)",
    width: "150px",
  },
  topLeftSpan7: {
    display: "block",
    height: "100%",
  },
  topLeftSpan8: {
    fontSize: "12px",
    lineHeight: "14px",
  },
  topRightDiv: {
    position: "absolute",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
  },
  topRightSpan: {
    backgroundColor: "var(--wb-berry)",
    paddingInline: "var(--spacing)",
    fontSize: "10px",
    color: "var(--color-cream-50)",
  },
  bottomLeftDiv: {
    position: "absolute",
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
  },
  toolBarDiv: {
    position: "absolute",
    insetInline: "0",
    display: "flex",
    justifyContent: "center",
  },
  toolBarSpan: {
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "3px",
    borderStyle: "solid",
    borderWidth: "2px",
    boxShadow: "0 0 transparent, 0 0 transparent, 0 0 transparent, 0 0 transparent, 2px 2px 0 0 var(--color-px-shade)",
  },
  toolBarSpan2: {
    fontSize: "12px",
  },
  usageLinesP: {
    fontSize: "12px",
    color: "var(--color-bark-400)",
  },
  usageLinesP2: {
    fontSize: "12px",
    color: "var(--color-wheat-700)",
  },
  usageLinesDiv: {
    marginTop: "var(--spacing)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing)",
  },
  usageLinesDiv2: {
    display: "flex",
    justifyContent: "space-between",
    gap: "calc(var(--spacing) * 2)",
  },
  usageLinesSpan: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  usageLinesSpan2: {
    display: "block",
    height: "calc(var(--spacing) * 1.5)",
    width: "100%",
  },
  usageLinesSpan3: {
    fontSize: "10px",
    color: "var(--color-bark-400)",
  },
  quotaMachine: {
    display: "flex",
    gap: "calc(var(--spacing) * 2.5)",
    borderStyle: "solid",
    borderWidth: "1.5px",
    borderColor: "var(--color-cream-200)",
    backgroundColor: "var(--color-cream-100)",
    padding: "calc(var(--spacing) * 2)",
  },
  machineDiv: {
    minWidth: "0",
    flex: "1",
  },
  machineDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  machineSpan: {
    fontSize: "13px",
  },
  machineSpan2: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "12px",
    color: "var(--color-bark-500)",
  },
  machineP: {
    marginTop: "calc(var(--spacing) * .5)",
    fontSize: "12px",
    color: "var(--color-bark-500)",
  },
  machineP2: {
    marginTop: "calc(var(--spacing) * .5)",
    fontSize: "12px",
    color: "var(--wb-berry)",
  },
  machineDiv3: {
    display: "flex",
    width: "calc(var(--spacing) * 12)",
    flexDirection: "column",
    alignItems: "center",
  },
  quotaPillDiv: {
    pointerEvents: "auto",
    position: "relative",
  },
  quotaPillButton: {
    cursor: "pointer",
  },
  quotaPillDiv2: {
    display: "flex",
    alignItems: "center",
  },
  quotaPillSpan: {
    flex: "1",
    fontSize: "13px",
  },
  quotaPillDiv3: {
    marginTop: "calc(var(--spacing) * 2)",
    display: "flex",
    maxHeight: "min(512px,70vh)",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
    overflowY: "auto",
  },
  quotaPillP: {
    marginTop: "calc(var(--spacing) * 2)",
    fontSize: "12px",
    color: "var(--color-bark-400)",
  },
});

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
      {...stylex.attrs(viewStyles.hudTapButton)}
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
          {...stylex.attrs(viewStyles.repoSign)}
          style={{ left: `${at().x}px`, top: `${at().y}px` }}
        >
          <span {...stylex.attrs(viewStyles.repoSignSpan)}>
            <span {...stylex.attrs(viewStyles.repoSignSpan2)}>{t("web.farm.sign.repo")}</span>
            <span {...stylex.attrs(viewStyles.repoSignSpan3)}>{repo() || t("web.farm.sign.noRepo")}</span>
          </span>
          <span {...stylex.attrs(viewStyles.repoSignSpan4)} style={{ height: `${Math.round((screen()?.scale ?? 3) * 5)}px` }} />
        </button>
      )}
    </Show>
  );
}

export function Hud() {
  const shown = useFarm((s) => s.screen?.shown);
  return (
    <div {...stylex.attrs(viewStyles.hudDiv)} aria-label={t("web.farm.hud.label")}>
      <Overlay />
      <RepoSign />
      <Show when={shown()}>
        {(box) => (
          <div
            {...stylex.attrs(viewStyles.hudDiv2)}
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
    <div {...stylex.attrs(viewStyles.topLeftDiv)} style={{ left: `${edge}px`, top: `${edge + titleBar.top}px`, gap: `${gap}px` }}>
      <HudTap label={t("web.farm.hud.look")} testid="hud-orchestrator" onClick={() => open("orchestrator")}>
        <span {...stylex.attrs(viewStyles.topLeftSpan)}>
          <span
            {...stylex.attrs(viewStyles.topLeftSpan2)}
            style={{ width: `${top + 2}px`, height: `${top}px`, background: CardColors.paper, "border-color": CardColors.ink }}
          >
            <SpriteIcon name={face()} size={top - 8} />
          </span>
        </span>
      </HudTap>
      <HudTap label={t("web.farm.panel.graphs")} testid="hud-graphs" onClick={() => open("graphs")}>
        <span {...stylex.attrs(viewStyles.topLeftSpan3)}>
          <span {...stylex.attrs(viewStyles.topLeftSpan4)} style={{ height: `${top}px`, background: CardColors.paper, "border-color": CardColors.ink }}>
            <span {...stylex.attrs(viewStyles.topLeftSpan5)}>
              <span style={{ color: CardColors.good }}>Lv.{level()}</span>
              <SpriteIcon name="icon-coin" size={12} />
              <span>{thousands(coins())}</span>
              <SpriteIcon name="icon-clock" size={12} />
              <span data-testid="farm-clock">{clockText(tod())}</span>
            </span>
            <span {...stylex.attrs(viewStyles.topLeftSpan6)} style={{ background: CardColors.barTrack }}>
              <span
                {...stylex.attrs(viewStyles.topLeftSpan7)}
                style={{ width: `${need() === 0 ? 0 : Math.min(100, (lv().xp / need()) * 100)}%`, background: CardColors.barFill }}
              />
            </span>
            <span {...stylex.attrs(viewStyles.topLeftSpan8)} style={{ color: CardColors.muted }}>
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
        {...stylex.attrs(viewStyles.hudTapButton)}
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
      {...stylex.attrs(viewStyles.topRightDiv)}
      style={{
        right: `${edge}px`,
        left: props.compact ? `${edge}px` : undefined,
        top: `${edge + (props.compact ? top + gap + titleBar.top : 0)}px`,
        gap: `${gap}px`,
      }}
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
            <span {...stylex.attrs(viewStyles.topRightSpan)}>{unread()}</span>
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
    <div {...stylex.attrs(viewStyles.bottomLeftDiv)} style={{ left: `${edge}px`, bottom: `${edge + (props.compact ? bottom + gap : 0)}px`, gap: `${gap}px` }}>
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
    <div {...stylex.attrs(viewStyles.toolBarDiv)} style={{ bottom: `${edge}px`, gap: `${gap}px` }} role="toolbar" aria-label={t("web.farm.hud.tools")}>
      <For each={tools}>
        {(tool, i) => (
          <HudTap
            label={t("shared.join.aside", { text: t("shared.join.labeled", { label: tool.label, text: tool.hint }), aside: i() + 1 })}
            testid={`tool-${tool.id}`}
            selected={held() === tool.id}
            onClick={() => farm.hold(tool.id)}
          >
            <span {...stylex.attrs(viewStyles.topLeftSpan)}>
              <span
                {...stylex.attrs(viewStyles.toolBarSpan)}
                style={{
                  width: props.compact ? "44px" : "52px",
                  height: `${bottom}px`,
                  background: held() === tool.id ? CardColors.held : CardColors.slot,
                  "border-color": CardColors.ink,
                }}
              >
                <span {...stylex.attrs(viewStyles.toolBarSpan2)} style={{ color: CardColors.muted }}>
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
    <Switch fallback={<p {...stylex.attrs(viewStyles.usageLinesP)}>{t("web.farm.quota.unreported")}</p>}>
      <Match when={props.usage?.status === "login_required"}>
        <p {...stylex.attrs(viewStyles.usageLinesP2)}>{t("web.farm.quota.signedOut")}</p>
      </Match>
      <Match when={props.usage?.status === "unavailable" ? props.usage : undefined}>
        {(u) => <p {...stylex.attrs(viewStyles.usageLinesP)}>{t("web.farm.quota.unreadable", { why: u().reason })}</p>}
      </Match>
      <Match when={props.usage?.status === "balance" ? props.usage : undefined}>
        {(u) => (
          <p {...stylex.attrs(viewStyles.toolBarSpan2)} style={{ color: u().available ? "#2f1f13" : "#c84a3a" }}>
            {t("web.farm.quota.balance", { provider: u().provider, enough: u().available })}
          </p>
        )}
      </Match>
      <Match when={props.usage?.status === "ok" ? props.usage : undefined}>
        {(u) => (
          <div {...stylex.attrs(viewStyles.usageLinesDiv)}>
            <For each={u().windows}>
              {(w) => {
                const left = () => 100 - w.usedPercent;
                return (
                  <div {...stylex.attrs(viewStyles.toolBarSpan2)}>
                    <div {...stylex.attrs(viewStyles.usageLinesDiv2)}>
                      <span {...stylex.attrs(viewStyles.usageLinesSpan)}>{windowLabel(w.label)}</span>
                      <span style={{ color: levelInk[quotaLevel(left())] }}>{Math.round(left())}%</span>
                    </div>
                    <span {...stylex.attrs(viewStyles.usageLinesSpan2)} style={{ background: CardColors.barTrack }}>
                      <span
                        {...stylex.attrs(viewStyles.topLeftSpan7)}
                        style={{ width: `${Math.max(0, Math.min(100, left()))}%`, background: levelInk[quotaLevel(left())] }}
                      />
                    </span>
                    <Show when={w.resetsAt}>{(at) => <span {...stylex.attrs(viewStyles.usageLinesSpan3)}>{resetText(at())}</span>}</Show>
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
    <div {...stylex.attrs(viewStyles.quotaMachine)} data-testid="quota-machine">
      <RuntimeIcon runtime={props.info.id} size={34} />
      <div {...stylex.attrs(viewStyles.machineDiv)}>
        <div {...stylex.attrs(viewStyles.machineDiv2)}>
          <span {...stylex.attrs(viewStyles.machineSpan)}>{props.info.preset.label}</span>
          <Show when={subscription()}>{(sub) => <span {...stylex.attrs(viewStyles.machineSpan2)}>{sub()}</span>}</Show>
        </div>
        <UsageLines usage={usage()} />
        {/* Spent today may be 0, which is still said. */}
        <Show when={props.info.spentToday !== undefined ? { spent: props.info.spentToday } : undefined}>
          {(today) => (
            <p {...stylex.attrs(viewStyles.machineP)}>
              {(props.info.settings.dailyBudget ?? 0) > 0
                ? t("web.farm.quota.spentTodayBudget", { spent: yuan(today().spent), budget: yuan(props.info.settings.dailyBudget ?? 0) })
                : t("web.farm.quota.spentToday", { spent: yuan(today().spent) })}
            </p>
          )}
        </Show>
        <Show when={props.info.stop}>
          <p {...stylex.attrs(viewStyles.machineP2)}>{props.info.stop}</p>
        </Show>
      </div>
      <div {...stylex.attrs(viewStyles.machineDiv3)}>
        <SpriteIcon name={bottleSprite(quota())} size={40} label={quota().text} />
        <span
          {...stylex.attrs(viewStyles.toolBarSpan2)}
          style={{ color: quota().level === "unknown" ? "#9b7550" : quota().level === "empty" ? "#c84a3a" : "#46301d" }}
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
      <div ref={box} {...stylex.attrs(viewStyles.quotaPillDiv)}>
        <button
          type="button"
          aria-label={shown() === undefined ? t("web.farm.quota.all") : t("web.farm.quota.lowest", { pct: String(shown()) })}
          aria-expanded={aria(open())}
          onClick={() => setOpen(!open())}
          {...stylex.attrs(viewStyles.quotaPillButton)}
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
          <div {...stylex.attrs(recipeStyles.quotaPillDiv)} role="dialog" aria-label={t("web.farm.quota.left")}>
            <div {...stylex.attrs(viewStyles.quotaPillDiv2)}>
              <span {...stylex.attrs(viewStyles.quotaPillSpan)}>{t("web.farm.quota.left")}</span>
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
            <div {...stylex.attrs(viewStyles.quotaPillDiv3)}>
              <For each={runtimes()} keyed={(r) => r.id}>
                {(r) => <Machine info={r()} />}
              </For>
            </div>
            <p {...stylex.attrs(viewStyles.quotaPillP)}>{t("web.farm.quota.note")}</p>
          </div>
        </Show>
      </div>
    </Show>
  );
}
