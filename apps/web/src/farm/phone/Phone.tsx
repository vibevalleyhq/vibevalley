import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Match, onSettled, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { InboxItem } from "@vibevalley/protocol";

import { useInterval } from "#/base/timer.ts";
import { ChatWindow } from "#/farm/chat/ChatWindow.tsx";
import { farm, useFarm } from "#/farm/store.ts";
import { unreadTotal } from "#/features/channel/index.ts";
import { voiceCall } from "#/features/voice/index.ts";
import { useCore } from "#/infra/frame.ts";
import { useRouter } from "#/infra/router.ts";
import { playSound } from "#/ui/pixel/sound.ts";
import { styleProps } from "#/ui/positioner.ts";

import { missedOf, phoneCalls, phoneState } from "./calls";
import { BlocksGame } from "./games/BlocksGame";
import { BugSnakeGame } from "./games/BugSnakeGame";
import { DinoGame } from "./games/DinoGame";
import { MergeGame } from "./games/MergeGame";
import { SokobanGame } from "./games/SokobanGame";
import { lcd } from "./lcd";
import { type PadButton, padListening, pressPad } from "./pad";
import { GamesScreen, HomeScreen, ListScreen, OrchestratorScreen, type PhoneApp, RingingScreen } from "./screens";

const viewStyles = stylex.create({
  crossKey: { position: "absolute", width: "calc(var(--spacing) * 4)", height: "calc(var(--spacing) * 4)" },
  crossUp: { top: 0, left: "calc(var(--spacing) * 4)" },
  crossLeft: { top: "calc(var(--spacing) * 4)", left: 0 },
  crossRight: { top: "calc(var(--spacing) * 4)", right: 0 },
  crossDown: { bottom: 0, left: "calc(var(--spacing) * 4)" },
  phone: {
    pointerEvents: "auto",
    position: "relative",
    paddingInline: "10px",
    paddingTop: "10px",
    paddingBottom: "calc(var(--spacing) * 3)",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.5",
    fontVariantNumeric: "tabular-nums",
  },
  handsetDiv: {
    marginInline: "auto",
    marginBottom: "calc(var(--spacing) * 2)",
    height: "var(--spacing)",
    width: "calc(var(--spacing) * 10)",
    backgroundColor: "var(--color-bark-950)",
  },
  handsetDiv2: {
    display: "flex",
    flexDirection: "column",
    padding: "2px",
  },
  handsetDiv3: {
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    paddingBlock: "calc(var(--spacing) * .5)",
  },
  phoneHome: {
    cursor: "pointer",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  handsetSpan: {
    marginLeft: "auto",
  },
  handsetDiv4: {
    display: "flex",
    minHeight: "0",
    flex: "1",
  },
  handsetDiv5: {
    display: "flex",
    minHeight: "0",
    flexShrink: "0",
    flexDirection: "column",
    overflow: "hidden",
  },
  handsetI: {
    display: "block",
    width: "2px",
    flexShrink: "0",
  },
  handsetDiv6: {
    minHeight: "0",
    flexShrink: "0",
  },
  pad: {
    marginTop: "calc(var(--spacing) * 2)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingInline: "var(--spacing)",
  },
  handsetSpan2: {
    display: "flex",
    gap: "calc(var(--spacing) * 2)",
  },
  phoneChat: {
    position: "absolute",
    top: "calc(var(--spacing) * 16)",
    left: "100%",
    display: "flex",
    width: "calc(var(--spacing) * 8)",
    cursor: "pointer",
    flexDirection: "column",
    alignItems: "center",
    gap: "calc(var(--spacing) * .5)",
    paddingBlock: "calc(var(--spacing) * 2.5)",
    fontSize: "13px",
    lineHeight: "15px",
    color: "var(--color-cream-50)",
    translate: {
      default: null,
      ":active": "1px 0",
    },
  },
  unfoldTabSpan: {
    display: "block",
    width: "calc(var(--spacing) * 2.5)",
    height: "calc(var(--spacing) * 2.5)",
    backgroundColor: "var(--color-berry)",
    boxShadow: "inset 0 0 0 2px var(--color-px-dent)",
  },
  signalSpan: {
    display: "flex",
    alignItems: "flex-end",
    gap: "1px",
  },
  signalI: {
    display: "block",
    width: "2px",
  },
  batterySpan: {
    display: "flex",
    alignItems: "center",
  },
  batteryI: {
    position: "relative",
    display: "block",
    height: "calc(var(--spacing) * 2)",
    width: "14px",
  },
  batteryI2: {
    position: "absolute",
    top: "2px",
    right: "2px",
    display: "block",
    width: "var(--spacing)",
    height: "var(--spacing)",
  },
  batteryI3: {
    display: "block",
    height: "var(--spacing)",
    width: "2px",
  },
  crossSpan: {
    position: "relative",
    display: "block",
    width: "calc(var(--spacing) * 12)",
    height: "calc(var(--spacing) * 12)",
  },
  crossI: {
    position: "absolute",
    top: "calc(var(--spacing) * 4)",
    left: "calc(var(--spacing) * 4)",
    width: "calc(var(--spacing) * 4)",
    height: "calc(var(--spacing) * 4)",
  },
  abKeyButton: {
    display: "grid",
    width: "calc(var(--spacing) * 6)",
    height: "calc(var(--spacing) * 6)",
    placeItems: "center",
    lineHeight: "1",
    color: "var(--color-cream-50)",
  },
});

const games: ReadonlySet<PhoneApp> = new Set(["blocks", "dino", "sokoban", "bugs", "merge"]);

/** What rang, for the orchestrator to open the call with. */
const aboutOf = (call: InboxItem) => t("shared.join.sentence", { text: t("shared.join.labeled", { label: call.who, text: call.words.label }) }) + call.text;

/** room: the most it may take, inside the farm's box. */
const listOf = (app: PhoneApp) => (app === "missed" || app === "log" ? app : undefined);

export function Phone(props: { room: { w: number; h: number } }) {
  const phone = phoneState();
  const router = useRouter();
  const [app, setApp] = createSignal<PhoneApp>("home");
  const ringing = () => phone().ringing;
  const put = () => farm.phoneOpen(false);
  const open = (next: PhoneApp) => {
    playSound("tap");
    setApp(next);
  };
  const settle = (call: InboxItem, answered: boolean) => {
    phoneCalls.settle(call, answered);
    if (!answered) return;
    // Answering is the call: the orchestrator comes on and says what rang, on the phone unfolded to the farm chat; the farm shows
    // what called beside it.
    farm.chatOpen(true);
    void voiceCall.start(aboutOf(call));
    switch (call.target.kind) {
      case "session":
        return farm.select(call.target.id);
      case "issue":
        return router.navigate(`/issues/${call.target.id}`);
      case "chat":
        return router.navigate(`/chat/${call.target.channel}`);
    }
  };
  const game = () => ringing() === undefined && games.has(app());
  const core = useCore();
  const unfolded = useFarm((s) => s.chatOpen);
  const large = useFarm((s) => s.chatLarge);
  return (
    <Handset
      screen={ringing() === undefined ? app() : "ringing"}
      big={game()}
      tall={game() || ringing() !== undefined}
      unfolded={unfolded()}
      large={large()}
      narrow={props.room.w < 640}
      room={props.room}
      unread={unreadTotal(core()?.chat)}
      chat={<ChatWindow />}
      onClose={put}
      onHome={() => {
        playSound("tap");
        if (app() === "home" && ringing() === undefined) put();
        else {
          // A game goes back to the games folder, the rest to the home screen.
          setApp(ringing() === undefined && games.has(app()) ? "games" : "home");
          phoneCalls.silence();
        }
      }}
    >
      <Show
        when={ringing()}
        fallback={
          <Switch>
            <Match when={app() === "home"}>
              <HomeScreen
                missed={missedOf(phone()).length}
                onOpen={open}
                // Tapping the orchestrator is calling it: its line on the left, the farm chat unfolded beside it where what is said shows. A call
                // already on is not dialed again.
                onOrchestrator={() => {
                  open("orchestrator");
                  farm.chatOpen(true);
                  void voiceCall.start();
                }}
                onChannels={() => {
                  put();
                  router.navigate("/chat");
                }}
                onIssues={() => {
                  put();
                  router.navigate("/issues");
                }}
              />
            </Match>
            <Match when={app() === "games"}>
              <GamesScreen onOpen={open} />
            </Match>
            <Match when={listOf(app())}>
              {(screen) => <ListScreen screen={screen()} onScreen={setApp} onAnswer={(c) => settle(c, true)} onCall={() => open("orchestrator")} />}
            </Match>
            <Match when={app() === "orchestrator"}>
              <OrchestratorScreen />
            </Match>
            <Match when={app() === "blocks"}>
              <BlocksGame big />
            </Match>
            <Match when={app() === "sokoban"}>
              <SokobanGame />
            </Match>
            <Match when={app() === "dino"}>
              <DinoGame big />
            </Match>
            <Match when={app() === "bugs"}>
              <BugSnakeGame />
            </Match>
            <Match when={app() === "merge"}>
              <MergeGame />
            </Match>
          </Switch>
        }
      >
        {(call) => <RingingScreen call={call()} onAnswer={() => settle(call(), true)} onDecline={() => settle(call(), false)} />}
      </Show>
    </Handset>
  );
}

const body = "#67482d";
const bark = "#2f1f13";
const outline = `inset 0 0 0 2px ${bark}`;

function Handset(props: {
  screen: string;
  children: JSX.Element;
  big: boolean;
  tall: boolean;
  unfolded: boolean;
  large: boolean;
  narrow: boolean;
  room: { w: number; h: number };
  unread: number;
  chat: JSX.Element;
  onClose: () => void;
  onHome: () => void;
}) {
  const [now, setNow] = createSignal(new Date());
  useInterval(() => setNow(new Date()), 15_000);
  onSettled(() => {
    // On the capture phase, so Esc folds or puts the phone away before the farm opens its menu; a dialog over it (the
    // channel menu) takes its Esc first.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("dialog[open]") !== null) return;
      e.preventDefault();
      e.stopPropagation();
      playSound("close");
      if (props.unfolded) farm.chatOpen(false);
      else props.onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });
  const listening = padListening();
  const two = (n: number) => String(n).padStart(2, "0");
  // Unfolded it is one handset with one screen, the phone's apps and the chat side by side over a thin seam, as a foldable shows two views.
  const chatOnly = () => props.unfolded && props.narrow;
  const pad = () => listening() && !chatOnly();
  const chrome = () => (pad() ? 90 : 34);
  const fit = (want: number) => Math.max(200, Math.min(want, props.room.h - chrome()));
  const screen = () => (props.unfolded ? fit(props.large ? 680 : 440) : props.tall ? fit(440) : fit(300));
  const both = () => props.unfolded && !props.narrow;
  const appsWidth = () => (props.big ? 356 : both() ? 320 : 236) - 24;
  const chatWidth = () => (props.narrow ? props.room.w - 24 : props.large ? Math.max(320, Math.min(560, props.room.w - 380)) : 320);
  const width = () => (!props.unfolded ? appsWidth() : props.narrow ? chatWidth() : appsWidth() + 2 + chatWidth()) + 24;
  return (
    <section
      aria-label={t("web.farm.phone.label")}
      data-testid="phone"
      data-screen={props.screen}
      {...stylex.attrs(viewStyles.phone)}
      style={{
        width: `${width()}px`,
        background: body,
        // The outline over a 4 px dark band at the bottom and right and a light one at the top and left.
        "box-shadow": `${outline}, inset -4px -4px 0 0 #4a321e, inset 4px 4px 0 0 #8a6440, 3px 4px 0 0 #1e140a73`,
        color: lcd.ink,
      }}
    >
      <div {...stylex.attrs(viewStyles.handsetDiv)} />
      <div
        {...stylex.attrs(viewStyles.handsetDiv2)}
        style={{ height: `${screen()}px`, background: lcd.paper, "box-shadow": `${outline}, inset 3px 3px 0 0 #a8bd78` }}
      >
        <div {...stylex.attrs(viewStyles.handsetDiv3)} style={{ "border-bottom": `2px solid ${lcd.dark}` }}>
          <Signal />
          {/* The phone has no keys outside a game: its name in the status bar goes back to the home screen. */}
          <button
            type="button"
            aria-label={t("web.farm.phone.home")}
            data-testid="phone-home"
            title={t("web.farm.phone.homeHint")}
            onClick={() => props.onHome()}
            {...stylex.attrs(viewStyles.phoneHome)}
          >
            {t("web.farm.phone.brand")}
          </button>
          <span {...stylex.attrs(viewStyles.handsetSpan)}>
            {two(now().getHours())}:{two(now().getMinutes())}
          </span>
          <Battery />
        </div>
        <div {...stylex.attrs(viewStyles.handsetDiv4)}>
          <Show when={!(props.unfolded && props.narrow)}>
            <div {...stylex.attrs(viewStyles.handsetDiv5)} style={{ width: `${appsWidth()}px` }}>
              {props.children}
            </div>
          </Show>
          <Show when={props.unfolded}>
            <Show when={!props.narrow}>
              <i {...stylex.attrs(viewStyles.handsetI)} style={{ background: lcd.dark }} aria-hidden="true" />
            </Show>
            <div {...stylex.attrs(viewStyles.handsetDiv6)} style={{ width: `${chatWidth()}px` }}>
              {props.chat}
            </div>
          </Show>
        </div>
      </div>
      <Show when={pad()}>
        <div data-testid="pad" {...stylex.attrs(viewStyles.pad)}>
          <Cross />
          <span {...stylex.attrs(viewStyles.handsetSpan2)}>
            <AbKey button="b" label="B" />
            <AbKey button="a" label="A" />
          </span>
        </div>
      </Show>
      <Show when={!props.unfolded}>
        <UnfoldTab unread={props.unread} />
      </Show>
    </section>
  );
}

/** The folded phone's edge: unfolds it to the chat, with a dot while there is something new in it. */
function UnfoldTab(props: { unread: number }) {
  return (
    <button
      type="button"
      aria-label={props.unread > 0 ? t("web.farm.phone.openChatUnread", { n: props.unread }) : t("web.farm.phone.openChat")}
      data-testid="phone-chat"
      data-unread={props.unread}
      title={t("web.farm.phone.openChat")}
      onClick={() => {
        playSound("open");
        farm.chatOpen(true);
      }}
      {...stylex.attrs(viewStyles.phoneChat)}
      style={{ background: body, "box-shadow": `${outline}, inset -3px -3px 0 0 #4a321e, 3px 4px 0 0 #1e140a73` }}
    >
      <For each={[...t("web.farm.phone.chatTab")]}>{(c) => <span>{c}</span>}</For>
      <Show when={props.unread > 0}>
        <span {...stylex.attrs(viewStyles.unfoldTabSpan)} />
      </Show>
    </button>
  );
}

function Signal() {
  return (
    <span {...stylex.attrs(viewStyles.signalSpan)} aria-hidden="true">
      <For each={[3, 5, 7, 9]}>{(h) => <i {...stylex.attrs(viewStyles.signalI)} style={{ height: `${h}px`, background: lcd.ink }} />}</For>
    </span>
  );
}

function Battery() {
  return (
    <span {...stylex.attrs(viewStyles.batterySpan)} aria-hidden="true">
      <i {...stylex.attrs(viewStyles.batteryI)} style={{ background: lcd.ink }}>
        <i {...stylex.attrs(viewStyles.batteryI2)} style={{ background: lcd.light }} />
      </i>
      <i {...stylex.attrs(viewStyles.batteryI3)} style={{ background: lcd.ink }} />
    </span>
  );
}

/** A pad key held with the mouse or a finger; the pad shows only while a game listens. */
function createPress(button: () => PadButton) {
  const [down, setDown] = createSignal(false);
  const set = (d: boolean) => {
    if (d === down()) return;
    setDown(d);
    pressPad(button(), d);
  };
  return {
    down,
    onPointerDown: (e: PointerEvent) => {
      e.preventDefault();
      set(true);
    },
    onPointerUp: () => set(false),
    onPointerCancel: () => set(false),
    onPointerLeave: () => set(false),
  };
}

function CrossKey(props: { button: PadButton; label: string; styles: stylex.StyleXStyles }) {
  const key = createPress(() => props.button);
  return (
    <button
      type="button"
      aria-label={props.label}
      onPointerDown={key.onPointerDown}
      onPointerUp={key.onPointerUp}
      onPointerCancel={key.onPointerCancel}
      onPointerLeave={key.onPointerLeave}
      {...styleProps([viewStyles.crossKey, props.styles], { background: key.down() ? "#1e140b" : bark })}
    />
  );
}

function Cross() {
  return (
    <span {...stylex.attrs(viewStyles.crossSpan)}>
      <CrossKey button="up" label={t("web.farm.phone.key.up")} styles={viewStyles.crossUp} />
      <CrossKey button="left" label={t("web.farm.phone.key.left")} styles={viewStyles.crossLeft} />
      <CrossKey button="right" label={t("web.farm.phone.key.right")} styles={viewStyles.crossRight} />
      <CrossKey button="down" label={t("web.farm.phone.key.down")} styles={viewStyles.crossDown} />
      <i {...stylex.attrs(viewStyles.crossI)} style={{ background: bark }} />
    </span>
  );
}

function AbKey(props: { button: PadButton; label: string }) {
  const key = createPress(() => props.button);
  return (
    <button
      type="button"
      aria-label={props.label}
      onPointerDown={key.onPointerDown}
      onPointerUp={key.onPointerUp}
      onPointerCancel={key.onPointerCancel}
      onPointerLeave={key.onPointerLeave}
      {...stylex.attrs(viewStyles.abKeyButton)}
      style={{
        transform: key.down() ? "translateY(1px)" : undefined,
        background: "#c84a3a",
        "box-shadow": key.down() ? outline : `${outline}, inset -4px -4px 0 0 #9c3a2d`,
      }}
    >
      {props.label}
    </button>
  );
}
