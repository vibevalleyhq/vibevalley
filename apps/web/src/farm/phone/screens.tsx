import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { InboxItem } from "@vibevalley/protocol";

import { aria } from "#/base/dom.tsx";
import { type CallPhase, createCall, voiceCall } from "#/features/voice/index.ts";
import { useAgent } from "#/infra/agents.ts";
import { useCore } from "#/infra/frame.ts";
import { AgentFace, OrchestratorFace } from "#/ui/domain/Face.tsx";
import { SpriteIcon } from "#/ui/pixel/index.ts";
import type { GlyphCell } from "#/ui/pixel/PixelCard.tsx";

import { missedOf, phoneState } from "./calls";
import { BugSnakeIcon } from "./games/BugSnakeGame";
import { MergeIcon } from "./games/MergeGame";
import { lcd, phoneCells } from "./lcd";

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
      class="shrink-0"
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
  <span
    class={[
      "grid w-18 h-18 place-items-center bg-lcd-pale [box-shadow:inset_0_0_0_2px_var(--color-lcd-dark)]",
      !(props.shake !== true) && "[animation-name:shake] motion-reduce:[animation-name:none] [animation-duration:500ms] [animation-iteration-count:infinite]",
    ]}
  >
    {props.children}
  </span>
);

const SmallFace = (props: { children: JSX.Element }) => (
  <span class="grid w-8 h-8 shrink-0 place-items-center overflow-hidden bg-lcd-pale">{props.children}</span>
);

export function RingingScreen(props: { call: InboxItem; onAnswer: () => void; onDecline: () => void }) {
  return (
    <div data-testid="ringing" data-key={props.call.id} data-kind={props.call.kind} class="flex min-h-0 flex-1 flex-col items-center px-3 pt-5 text-center">
      <span class="[animation-name:blink] motion-reduce:[animation-name:none] [animation-duration:1000ms] [animation-iteration-count:infinite]">
        {t("web.farm.phone.ringing")}
      </span>
      <span class="mt-3">
        <BigFace shake>
          <CallerFace call={props.call} size={60} />
        </BigFace>
      </span>
      <p class="mt-3 text-2xl leading-none">{props.call.who}</p>
      <p class="mt-2 bg-lcd-dark px-2 text-lcd-pale">{props.call.words.label}</p>
      <p class="mt-2 line-clamp-3 leading-relaxed">{props.call.text}</p>
      <div class="mt-auto mb-5 flex gap-8">
        <RoundKey answer={false} testid="decline" label={t("web.farm.phone.decline")} onClick={() => props.onDecline()} />
        <RoundKey answer testid="answer" label={t("web.farm.phone.answer")} onClick={() => props.onAnswer()} />
      </div>
    </div>
  );
}

function RoundKey(props: { answer: boolean; testid: string; label: string; onClick: () => void }) {
  return (
    <button type="button" data-testid={props.testid} onClick={() => props.onClick()} class="flex cursor-pointer flex-col items-center gap-1">
      <span
        class={[
          "grid w-11 h-11 place-items-center [box-shadow:inset_0_0_0_2px_var(--color-bark-900),_inset_-3px_-3px_0_0_var(--color-px-key-dent)]",
          props.answer ? "bg-leaf-600" : "bg-berry-500",
        ]}
      >
        <span class={["flex", !props.answer && "[transform:rotate(135deg)]"]}>
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
    <button
      type="button"
      data-testid="call-orchestrator"
      onClick={() => props.onCall()}
      class="m-2 flex cursor-pointer items-center justify-center gap-2 bg-leaf-600 py-1.5 text-cream-50 [box-shadow:inset_0_0_0_2px_var(--color-bark-900)] hover:[filter:brightness(110%)]"
    >
      <PhoneGlyph size={14} lit />
      {t("web.farm.phone.callOrchestrator")}
    </button>
  );
}

export function ListScreen(props: { screen: "missed" | "log"; onScreen: (s: "missed" | "log") => void; onAnswer: (c: InboxItem) => void; onCall: () => void }) {
  const phone = phoneState();
  const missed = () => missedOf(phone());
  const empty = (text: string) => (
    <li data-testid="calls-empty" class="px-3 py-6 text-center text-lcd-dark">
      {text}
    </li>
  );
  return (
    <>
      <div class="flex border-b-2 border-lcd-dark">
        <For each={["missed", "log"] as const}>
          {(s) => (
            <button
              type="button"
              data-key={s}
              onClick={() => props.onScreen(s)}
              aria-pressed={aria(props.screen === s)}
              class={["flex-1 cursor-pointer py-1", props.screen === s ? "bg-lcd-dark text-lcd-pale" : "hover:bg-lcd-light"]}
            >
              {s === "missed" ? t("web.farm.phone.missed", { n: missed().length }) : t("web.farm.phone.log")}
            </button>
          )}
        </For>
      </div>
      <ul class="min-h-0 flex-1 overflow-y-auto">
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
                    class={["flex w-full items-center gap-2 px-2 py-1.5 text-left", "border-b border-lcd-rule"]}
                  >
                    <SmallFace>
                      <CallerFace call={e().call} size={28} />
                    </SmallFace>
                    <span class="min-w-0 flex-1 truncate">
                      {e().call.who} · {e().call.words.label}
                    </span>
                    <span class={e().answered ? "text-lcd-dark" : "text-berry-500"}>
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
                <li class="border-b border-lcd-rule">
                  <button
                    type="button"
                    data-testid="missed-call"
                    data-key={c().id}
                    onClick={() => props.onAnswer(c())}
                    aria-label={t("shared.join.labeled", { label: c().who, text: c().words.label })}
                    class={["flex w-full items-center gap-2 px-2 py-1.5 text-left", "cursor-pointer hover:bg-lcd-light"]}
                  >
                    <SmallFace>
                      <CallerFace call={c()} size={28} />
                    </SmallFace>
                    <span class="min-w-0 flex-1">
                      <span class="flex">
                        {c().who}
                        <span class="ml-auto text-berry-500">{c().words.label}</span>
                      </span>
                      <span class="block truncate text-lcd-dark">{c().text}</span>
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
    <div
      data-testid="orchestrator-line"
      data-state={props.phase}
      data-problem={props.problem ? "" : undefined}
      class="flex min-h-0 flex-1 flex-col items-center px-3 pt-5 text-center"
    >
      <BigFace shake={props.phase === "connecting"}>
        <OrchestratorFace size={60} />
      </BigFace>
      <p class="mt-2 text-2xl leading-none">{t("web.farm.phone.manager")}</p>
      <p class={["mt-3 line-clamp-4 leading-relaxed", props.phase === "idle" && props.problem !== undefined && props.problem !== "" && "text-phone-failed"]}>
        {line()}
      </p>
      <div class="mt-auto mb-5">
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

const SokobanIcon = () => (
  <span class="grid w-7 h-7 place-items-center text-[length:18px] leading-none [box-shadow:inset_0_0_0_2px_var(--color-lcd-ink)]">×</span>
);

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
  <span class="grid grid-cols-2 gap-px" aria-hidden="true">
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
    <div class="grid grid-cols-3 content-start gap-y-3 px-2 pt-4">
      <For each={props.apps}>
        {(a) => (
          <button
            type="button"
            data-key={a.id}
            onClick={() => a.go()}
            aria-label={a.label}
            class={["group/farm-group", "flex cursor-pointer flex-col items-center gap-1"]}
          >
            <span class="relative grid w-11 h-11 place-items-center bg-lcd-pale group-hover/farm-group:bg-lcd-pale-hover [box-shadow:inset_0_0_0_2px_var(--color-lcd-dark)] group-active/farm-group:[translate:0_1px]">
              {a.icon()}
              <Show when={a.badge?.()}>
                <span class="absolute -top-1.5 -right-1.5 bg-berry-500 px-1 leading-2xs text-cream-50">{a.badge?.()}</span>
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
