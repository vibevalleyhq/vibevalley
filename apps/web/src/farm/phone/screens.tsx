import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { InboxItem } from "@vibevalley/protocol";

import { aria } from "#/base/dom.tsx";
import { farmGroup, phoneAnimations } from "#/farm/interaction.stylex.ts";
import { type CallPhase, createCall, voiceCall } from "#/features/voice/index.ts";
import { useAgent } from "#/infra/agents.ts";
import { useCore } from "#/infra/frame.ts";
import { AgentFace, OrchestratorFace } from "#/ui/domain/Face.tsx";
import { SpriteIcon } from "#/ui/pixel/index.ts";
import type { GlyphCell } from "#/ui/pixel/PixelCard.tsx";
import { styleProps } from "#/ui/positioner.ts";

import { missedOf, phoneState } from "./calls";
import { BugSnakeIcon } from "./games/BugSnakeGame";
import { MergeIcon } from "./games/MergeGame";
import { lcd, phoneCells } from "./lcd";

const styles = stylex.create({
  bigFace: {
    display: "grid",
    width: "72px",
    height: "72px",
    placeItems: "center",
    backgroundColor: "var(--color-lcd-pale)",
    boxShadow: "inset 0 0 0 2px var(--color-lcd-dark)",
  },
  callRow: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: "0.5rem",
    paddingInline: "0.5rem",
    paddingBlock: "0.375rem",
    textAlign: "left",
  },
  callRule: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-lcd-rule)",
  },
  missedCall: { cursor: "pointer", backgroundColor: { default: null, "@media (hover:hover)": { default: null, ":hover": "var(--color-lcd-light)" } } },
  app: { display: "flex", cursor: "pointer", flexDirection: "column", alignItems: "center", gap: "0.25rem" },
  appIcon: {
    position: "relative",
    display: "grid",
    width: "2.75rem",
    height: "2.75rem",
    placeItems: "center",
    backgroundColor: {
      default: "var(--color-lcd-pale)",
      "@media (hover:hover)": { default: null, [stylex.when.ancestor(":hover", farmGroup)]: "var(--color-lcd-pale-hover)" },
    },
    boxShadow: "inset 0 0 0 2px var(--color-lcd-dark)",
    translate: { default: null, [stylex.when.ancestor(":active", farmGroup)]: "0 1px" },
  },
  screenBody: {
    display: "flex",
    minHeight: "0",
    flex: "1",
    flexDirection: "column",
    alignItems: "center",
    paddingInline: "0.75rem",
    paddingTop: "1.25rem",
    textAlign: "center",
  },
  ringingText: {
    marginTop: "0.5rem",
    WebkitLineClamp: "3",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    lineHeight: "1.625",
  },
  tabBar: {
    display: "flex",
    borderBottomStyle: "solid",
    borderBottomWidth: "2px",
    borderColor: "var(--color-lcd-dark)",
  },
  tabButton: {
    flex: "1",
    cursor: "pointer",
    paddingBlock: "0.25rem",
  },
  tabActive: {
    backgroundColor: "var(--color-lcd-dark)",
    color: "var(--color-lcd-pale)",
  },
  tabIdle: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-lcd-light)",
      },
    },
  },
  lineStatus: {
    marginTop: "0.75rem",
    WebkitLineClamp: "4",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    lineHeight: "1.625",
  },
  lineFailed: {
    color: "var(--color-phone-failed)",
  },
  cellsSvg: {
    flexShrink: "0",
  },
  smallFace: {
    display: "grid",
    width: "2rem",
    height: "2rem",
    flexShrink: "0",
    placeItems: "center",
    overflow: "hidden",
    backgroundColor: "var(--color-lcd-pale)",
  },
  ringingFaceWrap: {
    marginTop: "0.75rem",
  },
  callerName: {
    marginTop: "0.75rem",
    fontSize: "24px",
    lineHeight: "1",
  },
  callerLabel: {
    marginTop: "0.5rem",
    backgroundColor: "var(--color-lcd-dark)",
    paddingInline: "0.5rem",
    color: "var(--color-lcd-pale)",
  },
  ringingActions: {
    marginTop: "auto",
    marginBottom: "1.25rem",
    display: "flex",
    gap: "2rem",
  },
  roundKey: {
    display: "flex",
    cursor: "pointer",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.25rem",
  },
  roundKeyCircle: {
    display: "grid",
    width: "2.75rem",
    height: "2.75rem",
    placeItems: "center",
    boxShadow: "inset 0 0 0 2px var(--color-bark-900), inset -3px -3px 0 0 var(--color-px-key-dent)",
  },
  roundKeyAnswer: {
    backgroundColor: "var(--color-leaf-600)",
  },
  roundKeyDecline: {
    backgroundColor: "var(--color-berry-500)",
  },
  flexRow: {
    display: "flex",
  },
  declineGlyph: {
    transform: "rotate(135deg)",
  },
  callOrchestrator: {
    margin: "0.5rem",
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
    backgroundColor: "var(--color-leaf-600)",
    paddingBlock: "0.375rem",
    color: "var(--color-cream-50)",
    boxShadow: "inset 0 0 0 2px var(--color-bark-900)",
    filter: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "brightness(110%)",
      },
    },
  },
  callsEmpty: {
    paddingInline: "0.75rem",
    paddingBlock: "1.5rem",
    textAlign: "center",
    color: "var(--color-lcd-dark)",
  },
  callList: {
    minHeight: "0",
    flex: "1",
    overflowY: "auto",
  },
  callSummary: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  inkLcdDark: {
    color: "var(--color-lcd-dark)",
  },
  inkDecline: {
    color: "var(--color-berry-500)",
  },
  missedBody: {
    minWidth: "0",
    flex: "1",
  },
  missedKind: {
    marginLeft: "auto",
    color: "var(--color-berry-500)",
  },
  missedText: {
    display: "block",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    color: "var(--color-lcd-dark)",
  },
  orchestratorName: {
    marginTop: "0.5rem",
    fontSize: "24px",
    lineHeight: "1",
  },
  orchestratorActions: {
    marginTop: "auto",
    marginBottom: "1.25rem",
  },
  sokobanIcon: {
    display: "grid",
    width: "1.75rem",
    height: "1.75rem",
    placeItems: "center",
    fontSize: "18px",
    lineHeight: "1",
    boxShadow: "inset 0 0 0 2px var(--color-lcd-ink)",
  },
  gamesIcon: {
    display: "grid",
    gridTemplateColumns: "repeat(2,minmax(0,1fr))",
    gap: "1px",
  },
  appGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3,minmax(0,1fr))",
    alignContent: "flex-start",
    rowGap: "0.75rem",
    paddingInline: "0.5rem",
    paddingTop: "1rem",
  },
  appBadge: {
    position: "absolute",
    top: "-0.375rem",
    right: "-0.375rem",
    backgroundColor: "var(--color-berry-500)",
    paddingInline: "0.25rem",
    lineHeight: "14px",
    color: "var(--color-cream-50)",
  },
});

export type PhoneApp = "home" | "missed" | "log" | "orchestrator" | "games" | "blocks" | "dino" | "sokoban" | "bugs" | "merge";

const creamFill = "var(--color-cream-50)";

/** Cells on a grid, scaled whole into `size` and centred. */
function Cells(props: { cells: readonly GlyphCell[]; grid: [number, number]; size: [number, number]; origin?: [number, number] }) {
  const origin = () => props.origin ?? [0, 0];
  return (
    <svg
      width={props.size[0]}
      height={props.size[1]}
      viewBox={`${origin()[0]} ${origin()[1]} ${props.grid[0]} ${props.grid[1]}`}
      shape-rendering="crispEdges"
      aria-hidden="true"
      {...stylex.attrs(styles.cellsSvg)}
    >
      <For each={props.cells}>{([x, y, w, h, fill]) => <rect x={x} y={y} width={w} height={h} fill={fill} />}</For>
    </svg>
  );
}

const PhoneGlyph = (props: { size: number; lit?: boolean }) => (
  <Cells cells={phoneCells(props.lit ?? false)} grid={[10, 16]} size={[(props.size * 10) / 16, props.size]} />
);

function CallerFace(props: { call: InboxItem; size: number }) {
  const core = useCore();
  const session = () => {
    const from = props.call.from;
    return from.kind === "session" ? core()?.sessions.find((s) => s.id === from.id) : undefined;
  };
  const agent = useAgent(() => (props.call.from.kind !== "orchestrator" ? props.call.from.agent : undefined));
  return (
    <Show when={props.call.from.kind !== "orchestrator" ? props.call.from : undefined} fallback={<OrchestratorFace size={props.size} />}>
      {(from) => <AgentFace agentId={from().agent || from().id} look={agent()?.look} runtime={session()?.runtime ?? agent()?.runtime} size={props.size} />}
    </Show>
  );
}

const BigFace = (props: { children: JSX.Element; shake?: boolean }) => (
  <span {...styleProps([styles.bigFace, !(props.shake !== true) && phoneAnimations.shake])}>{props.children}</span>
);

const SmallFace = (props: { children: JSX.Element }) => <span {...stylex.attrs(styles.smallFace)}>{props.children}</span>;

export function RingingScreen(props: { call: InboxItem; onAnswer: () => void; onDecline: () => void }) {
  return (
    <div data-testid="ringing" data-key={props.call.id} data-kind={props.call.kind} {...stylex.attrs(styles.screenBody)}>
      <span {...styleProps(phoneAnimations.blink)}>{t("web.farm.phone.ringing")}</span>
      <span {...stylex.attrs(styles.ringingFaceWrap)}>
        <BigFace shake>
          <CallerFace call={props.call} size={60} />
        </BigFace>
      </span>
      <p {...stylex.attrs(styles.callerName)}>{props.call.who}</p>
      <p {...stylex.attrs(styles.callerLabel)}>{props.call.words.label}</p>
      <p {...stylex.attrs(styles.ringingText)}>{props.call.text}</p>
      <div {...stylex.attrs(styles.ringingActions)}>
        <RoundKey answer={false} testid="decline" label={t("web.farm.phone.decline")} onClick={() => props.onDecline()} />
        <RoundKey answer testid="answer" label={t("web.farm.phone.answer")} onClick={() => props.onAnswer()} />
      </div>
    </div>
  );
}

function RoundKey(props: { answer: boolean; testid: string; label: string; onClick: () => void }) {
  return (
    <button type="button" data-testid={props.testid} onClick={() => props.onClick()} {...stylex.attrs(styles.roundKey)}>
      <span {...stylex.attrs(styles.roundKeyCircle, props.answer ? styles.roundKeyAnswer : styles.roundKeyDecline)}>
        <span {...stylex.attrs(styles.flexRow, !props.answer && styles.declineGlyph)}>
          <Cells
            cells={[
              [0, 2, 3, 4, creamFill],
              [8, 2, 3, 4, creamFill],
              [1, 0, 9, 2, creamFill],
            ]}
            grid={[11, 6]}
            size={[22, 12]}
          />
        </span>
      </span>
      {props.label}
    </button>
  );
}

function CallOrchestrator(props: { onCall: () => void }) {
  return (
    <button type="button" data-testid="call-orchestrator" onClick={() => props.onCall()} {...stylex.attrs(styles.callOrchestrator)}>
      <PhoneGlyph size={14} lit />
      {t("web.farm.phone.callOrchestrator")}
    </button>
  );
}

export function ListScreen(props: { screen: "missed" | "log"; onScreen: (s: "missed" | "log") => void; onAnswer: (c: InboxItem) => void; onCall: () => void }) {
  const phone = phoneState();
  const missed = () => missedOf(phone());
  const empty = (text: string) => (
    <li data-testid="calls-empty" {...stylex.attrs(styles.callsEmpty)}>
      {text}
    </li>
  );
  return (
    <>
      <div {...stylex.attrs(styles.tabBar)}>
        <For each={["missed", "log"] as const}>
          {(s) => (
            <button
              type="button"
              data-key={s}
              onClick={() => props.onScreen(s)}
              aria-pressed={aria(props.screen === s)}
              {...stylex.attrs(styles.tabButton, props.screen === s ? styles.tabActive : styles.tabIdle)}
            >
              {s === "missed" ? t("web.farm.phone.missed", { n: missed().length }) : t("web.farm.phone.log")}
            </button>
          )}
        </For>
      </div>
      <ul {...stylex.attrs(styles.callList)}>
        <Show
          when={props.screen === "missed"}
          fallback={
            <Show when={phone().log.length > 0} fallback={empty(t("web.farm.phone.noCalls"))}>
              <For each={phone().log} keyed={(e) => `${e.call.id}-${e.at}`}>
                {(e) => (
                  <li
                    data-testid="call-log"
                    data-key={e().call.id}
                    data-answered={e().answered ? "" : undefined}
                    {...stylex.attrs(styles.callRow, styles.callRule)}
                  >
                    <SmallFace>
                      <CallerFace call={e().call} size={28} />
                    </SmallFace>
                    <span {...stylex.attrs(styles.callSummary)}>
                      {e().call.who} · {e().call.words.label}
                    </span>
                    <span {...stylex.attrs(e().answered ? styles.inkLcdDark : styles.inkDecline)}>
                      {e().answered ? t("web.farm.phone.answered") : t("web.farm.phone.declined")}
                    </span>
                  </li>
                )}
              </For>
            </Show>
          }
        >
          <Show when={missed().length > 0} fallback={empty(t("web.farm.phone.noMissed"))}>
            <For each={missed()} keyed={(c) => c.id}>
              {(c) => (
                <li {...stylex.attrs(styles.callRule)}>
                  <button
                    type="button"
                    data-testid="missed-call"
                    data-key={c().id}
                    onClick={() => props.onAnswer(c())}
                    aria-label={t("shared.join.labeled", { label: c().who, text: c().words.label })}
                    {...stylex.attrs(styles.callRow, styles.missedCall)}
                  >
                    <SmallFace>
                      <CallerFace call={c()} size={28} />
                    </SmallFace>
                    <span {...stylex.attrs(styles.missedBody)}>
                      <span {...stylex.attrs(styles.flexRow)}>
                        {c().who}
                        <span {...stylex.attrs(styles.missedKind)}>{c().words.label}</span>
                      </span>
                      <span {...stylex.attrs(styles.missedText)}>{c().text}</span>
                    </span>
                  </button>
                </li>
              )}
            </For>
          </Show>
        </Show>
      </ul>
      <CallOrchestrator onCall={() => props.onCall()} />
    </>
  );
}

/** The farm's one call, the chat's call button's too: calling, on it, or why it did not get through. */
export function OrchestratorScreen() {
  const call = createCall();
  return (
    <OrchestratorLine
      phase={call().phase}
      agentHere={call().agentHere}
      problem={call().problem}
      onKey={() => void (call().phase === "live" || call().phase === "connecting" ? voiceCall.end() : voiceCall.start())}
    />
  );
}

/** The call as it looks in each phase, the line itself kept out: what OrchestratorScreen draws, and its stories. */
export function OrchestratorLine(props: { phase: CallPhase; agentHere: boolean; problem?: string | undefined; onKey: () => void }) {
  const line = () => {
    switch (props.phase) {
      case "connecting":
        return t("web.farm.phone.phase.connecting");
      case "live":
        return props.agentHere ? t("web.farm.phone.phase.live") : t("web.farm.phone.phase.coming");
      case "ending":
        return t("web.farm.phone.phase.ending");
      case "idle":
        return props.problem ? t("web.farm.phone.phase.failed", { why: props.problem }) : t("web.farm.phone.phase.idle");
    }
  };
  const on = () => props.phase === "live" || props.phase === "connecting";
  return (
    <div data-testid="orchestrator-line" data-state={props.phase} data-problem={props.problem ? "" : undefined} {...stylex.attrs(styles.screenBody)}>
      <BigFace shake={props.phase === "connecting"}>
        <OrchestratorFace size={60} />
      </BigFace>
      <p {...stylex.attrs(styles.orchestratorName)}>{t("web.farm.phone.manager")}</p>
      <p {...stylex.attrs(styles.lineStatus, props.phase === "idle" && props.problem !== undefined && props.problem !== "" && styles.lineFailed)}>{line()}</p>
      <div {...stylex.attrs(styles.orchestratorActions)}>
        <RoundKey
          answer={!on()}
          testid="line-key"
          label={on() ? t("web.farm.phone.hangUp") : t("web.farm.phone.callOrchestrator")}
          onClick={() => props.onKey()}
        />
      </div>
    </div>
  );
}

interface App {
  readonly id: string;
  readonly label: string;
  readonly icon: () => JSX.Element;
  readonly badge?: () => number;
  readonly go: () => void;
}

const SokobanIcon = () => <span {...stylex.attrs(styles.sokobanIcon)}>×</span>;

/** The games, in one folder on the home screen. */
const games = (open: (app: PhoneApp) => void): App[] => [
  { id: "blocks", label: t("web.farm.phone.game.blocks"), icon: () => <BlocksIcon />, go: () => open("blocks") },
  { id: "sokoban", label: t("web.farm.phone.game.sokoban"), icon: SokobanIcon, go: () => open("sokoban") },
  { id: "dino", label: t("web.farm.phone.game.dino"), icon: () => <DinoIcon />, go: () => open("dino") },
  { id: "bugs", label: t("web.farm.phone.game.bugs"), icon: () => <BugSnakeIcon />, go: () => open("bugs") },
  { id: "merge", label: t("web.farm.phone.game.merge"), icon: () => <MergeIcon />, go: () => open("merge") },
];

/** The games folder's icon: four of them small, as a folder shows what is in it. */
const GamesIcon = () => (
  <span {...stylex.attrs(styles.gamesIcon)} aria-hidden="true">
    <BlocksIcon size={12} />
    <DinoIcon size={12} />
    <BugSnakeIcon size={12} />
    <MergeIcon size={12} />
  </span>
);

/** onOrchestrator: calls the orchestrator, its line with the phone unfolded to the farm chat beside it. */
export function HomeScreen(props: {
  missed: number;
  onOpen: (app: PhoneApp) => void;
  onOrchestrator: () => void;
  onChannels: () => void;
  onIssues: () => void;
}) {
  const apps: App[] = [
    {
      id: "missed",
      label: t("web.farm.phone.app.missed"),
      icon: () => <PhoneGlyph size={26} lit={props.missed > 0} />,
      badge: () => props.missed,
      go: () => props.onOpen("missed"),
    },
    { id: "log", label: t("web.farm.phone.log"), icon: () => <SpriteIcon name="icon-log" size={28} />, go: () => props.onOpen("log") },
    { id: "orchestrator", label: t("web.farm.phone.manager"), icon: () => <OrchestratorFace size={28} />, go: () => props.onOrchestrator() },
    { id: "channels", label: t("web.farm.phone.app.channels"), icon: () => <SpriteIcon name="icon-board" size={28} />, go: () => props.onChannels() },
    { id: "issues", label: t("web.farm.menu.issues"), icon: () => <SpriteIcon name="icon-task-board" size={28} />, go: () => props.onIssues() },
    { id: "games", label: t("web.farm.phone.app.games"), icon: GamesIcon, go: () => props.onOpen("games") },
  ];
  return <AppGrid apps={apps} />;
}

export function GamesScreen(props: { onOpen: (app: PhoneApp) => void }) {
  return <AppGrid apps={games(props.onOpen)} />;
}

function AppGrid(props: { apps: readonly App[] }) {
  return (
    <div {...stylex.attrs(styles.appGrid)}>
      <For each={props.apps}>
        {(a) => (
          <button type="button" data-key={a.id} onClick={() => a.go()} aria-label={a.label} {...styleProps([farmGroup, styles.app])}>
            <span {...styleProps(styles.appIcon)}>
              {a.icon()}
              <Show when={a.badge?.()}>
                <span {...stylex.attrs(styles.appBadge)}>{a.badge?.()}</span>
              </Show>
            </span>
            {a.label}
          </button>
        )}
      </For>
    </div>
  );
}

function BlocksIcon(props: { size?: number }) {
  return (
    <Cells
      cells={[
        [0, 5, 7, 2, lcd.dark],
        [1, 4, 2, 1, lcd.dark],
        [2, 1, 3, 1, lcd.ink],
        [3, 2, 1, 1, lcd.ink],
        [5, 4, 1, 1, lcd.mid],
        [4, 5, 1, 1, lcd.paper],
      ]}
      grid={[7, 7]}
      size={[props.size ?? 28, props.size ?? 28]}
    />
  );
}

const dinoRows = ["  ####", " ## ##", " #####", " ##   ", "####  ", "##### ", " ###  ", " # #  "];
const dinoCells: GlyphCell[] = [
  ...dinoRows.flatMap((row, y) => [...row].flatMap((c, x): GlyphCell[] => (c === "#" ? [[x, y, 1, 1, lcd.ink]] : []))),
  [-1, 8, 8, 1, lcd.dark],
];

const DinoIcon = (props: { size?: number }) => <Cells cells={dinoCells} grid={[8, 10]} size={[props.size ?? 28, props.size ?? 28]} origin={[-1, -1]} />;
