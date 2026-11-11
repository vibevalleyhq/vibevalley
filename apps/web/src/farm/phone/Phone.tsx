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
import { type PadButton, padListening, pressPad } from "./pad";
import { GamesScreen, HomeScreen, ListScreen, OrchestratorScreen, type PhoneApp, RingingScreen } from "./screens";

const styles = stylex.create({
  crossKey: { position: "absolute", width: "1rem", height: "1rem" },
  crossKeyIdle: { backgroundColor: "var(--color-bark-900)" },
  crossKeyDown: { backgroundColor: "var(--color-bark-950)" },
  crossUp: { top: 0, left: "1rem" },
  crossLeft: { top: "1rem", left: 0 },
  crossRight: { top: "1rem", right: 0 },
  crossDown: { bottom: 0, left: "1rem" },
  phone: (width: number) => ({
    pointerEvents: "auto",
    position: "relative",
    width,
    backgroundColor: "var(--color-bark-600)",
    paddingInline: "10px",
    paddingTop: "10px",
    paddingBottom: "0.75rem",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.5",
    fontVariantNumeric: "tabular-nums",
    color: "var(--color-lcd-ink)",
    // The outline over a 4 px dark band at the bottom and right and a light one at the top and left.
    boxShadow:
      "inset 0 0 0 2px var(--color-bark-900), inset -4px -4px 0 0 var(--color-phone-shade), inset 4px 4px 0 0 var(--color-phone-lit), 3px 4px 0 0 var(--color-px-scrim)",
  }),
  speakerSlot: {
    marginInline: "auto",
    marginBottom: "0.5rem",
    height: "0.25rem",
    width: "2.5rem",
    backgroundColor: "var(--color-bark-950)",
  },
  screen: (height: number) => ({
    display: "flex",
    height,
    flexDirection: "column",
    backgroundColor: "var(--color-lcd-paper)",
    padding: "2px",
    boxShadow: "inset 0 0 0 2px var(--color-bark-900), inset 3px 3px 0 0 var(--color-lcd-bevel)",
  }),
  statusBar: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    borderBottomStyle: "solid",
    borderBottomWidth: "2px",
    borderColor: "var(--color-lcd-dark)",
    paddingInline: "0.375rem",
    paddingBlock: "0.125rem",
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
  clock: {
    marginLeft: "auto",
  },
  panes: {
    display: "flex",
    minHeight: "0",
    flex: "1",
  },
  appsPane: (width: number) => ({
    display: "flex",
    width,
    minHeight: "0",
    flexShrink: "0",
    flexDirection: "column",
    overflow: "hidden",
  }),
  seam: {
    display: "block",
    width: "2px",
    flexShrink: "0",
    backgroundColor: "var(--color-lcd-dark)",
  },
  chatPane: (width: number) => ({
    width,
    minHeight: "0",
    flexShrink: "0",
  }),
  pad: {
    marginTop: "0.5rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingInline: "0.25rem",
  },
  abButtons: {
    display: "flex",
    gap: "0.5rem",
  },
  phoneChat: {
    position: "absolute",
    top: "4rem",
    left: "100%",
    display: "flex",
    width: "2rem",
    cursor: "pointer",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.125rem",
    backgroundColor: "var(--color-bark-600)",
    paddingBlock: "0.625rem",
    fontSize: "13px",
    lineHeight: "15px",
    color: "var(--color-cream-50)",
    boxShadow: "inset 0 0 0 2px var(--color-bark-900), inset -3px -3px 0 0 var(--color-phone-shade), 3px 4px 0 0 var(--color-px-scrim)",
    translate: {
      default: null,
      ":active": "1px 0",
    },
  },
  unreadDot: {
    display: "block",
    width: "0.625rem",
    height: "0.625rem",
    backgroundColor: "var(--color-berry)",
    boxShadow: "inset 0 0 0 2px var(--color-px-dent)",
  },
  signal: {
    display: "flex",
    alignItems: "flex-end",
    gap: "1px",
  },
  signalBar: (height: number) => ({
    display: "block",
    width: "2px",
    height,
    backgroundColor: "var(--color-lcd-ink)",
  }),
  battery: {
    display: "flex",
    alignItems: "center",
  },
  batteryBody: {
    position: "relative",
    display: "block",
    height: "0.5rem",
    width: "14px",
    backgroundColor: "var(--color-lcd-ink)",
  },
  batteryGap: {
    position: "absolute",
    top: "2px",
    right: "2px",
    display: "block",
    width: "0.25rem",
    height: "0.25rem",
    backgroundColor: "var(--color-lcd-light)",
  },
  batteryCap: {
    display: "block",
    height: "0.25rem",
    width: "2px",
    backgroundColor: "var(--color-lcd-ink)",
  },
  cross: {
    position: "relative",
    display: "block",
    width: "3rem",
    height: "3rem",
  },
  crossCenter: {
    position: "absolute",
    top: "1rem",
    left: "1rem",
    width: "1rem",
    height: "1rem",
    backgroundColor: "var(--color-bark-900)",
  },
  abKey: {
    display: "grid",
    width: "1.5rem",
    height: "1.5rem",
    placeItems: "center",
    backgroundColor: "var(--color-berry-500)",
    lineHeight: "1",
    color: "var(--color-cream-50)",
  },
  abKeyIdle: {
    boxShadow: "inset 0 0 0 2px var(--color-bark-900), inset -4px -4px 0 0 var(--color-phone-key-shade)",
  },
  abKeyDown: {
    transform: "translateY(1px)",
    boxShadow: "inset 0 0 0 2px var(--color-bark-900)",
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
    <section aria-label={t("web.farm.phone.label")} data-testid="phone" data-screen={props.screen} {...styleProps(styles.phone(width()))}>
      <div {...stylex.attrs(styles.speakerSlot)} />
      <div {...styleProps(styles.screen(screen()))}>
        <div {...stylex.attrs(styles.statusBar)}>
          <Signal />
          {/* The phone has no keys outside a game: its name in the status bar goes back to the home screen. */}
          <button
            type="button"
            aria-label={t("web.farm.phone.home")}
            data-testid="phone-home"
            title={t("web.farm.phone.homeHint")}
            onClick={() => props.onHome()}
            {...stylex.attrs(styles.phoneHome)}
          >
            {t("web.farm.phone.brand")}
          </button>
          <span {...stylex.attrs(styles.clock)}>
            {two(now().getHours())}:{two(now().getMinutes())}
          </span>
          <Battery />
        </div>
        <div {...stylex.attrs(styles.panes)}>
          <Show when={!(props.unfolded && props.narrow)}>
            <div {...styleProps(styles.appsPane(appsWidth()))}>{props.children}</div>
          </Show>
          <Show when={props.unfolded}>
            <Show when={!props.narrow}>
              <i {...stylex.attrs(styles.seam)} aria-hidden="true" />
            </Show>
            <div {...styleProps(styles.chatPane(chatWidth()))}>{props.chat}</div>
          </Show>
        </div>
      </div>
      <Show when={pad()}>
        <div data-testid="pad" {...stylex.attrs(styles.pad)}>
          <Cross />
          <span {...stylex.attrs(styles.abButtons)}>
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
      {...stylex.attrs(styles.phoneChat)}
    >
      <For each={[...t("web.farm.phone.chatTab")]}>{(c) => <span>{c}</span>}</For>
      <Show when={props.unread > 0}>
        <span {...stylex.attrs(styles.unreadDot)} />
      </Show>
    </button>
  );
}

function Signal() {
  return (
    <span {...stylex.attrs(styles.signal)} aria-hidden="true">
      <For each={[3, 5, 7, 9]}>{(h) => <i {...styleProps(styles.signalBar(h))} />}</For>
    </span>
  );
}

function Battery() {
  return (
    <span {...stylex.attrs(styles.battery)} aria-hidden="true">
      <i {...stylex.attrs(styles.batteryBody)}>
        <i {...stylex.attrs(styles.batteryGap)} />
      </i>
      <i {...stylex.attrs(styles.batteryCap)} />
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
      {...styleProps([styles.crossKey, props.styles, key.down() ? styles.crossKeyDown : styles.crossKeyIdle])}
    />
  );
}

function Cross() {
  return (
    <span {...stylex.attrs(styles.cross)}>
      <CrossKey button="up" label={t("web.farm.phone.key.up")} styles={styles.crossUp} />
      <CrossKey button="left" label={t("web.farm.phone.key.left")} styles={styles.crossLeft} />
      <CrossKey button="right" label={t("web.farm.phone.key.right")} styles={styles.crossRight} />
      <CrossKey button="down" label={t("web.farm.phone.key.down")} styles={styles.crossDown} />
      <i {...stylex.attrs(styles.crossCenter)} />
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
      {...stylex.attrs(styles.abKey, key.down() ? styles.abKeyDown : styles.abKeyIdle)}
    >
      {props.label}
    </button>
  );
}
