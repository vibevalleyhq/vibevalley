// The farm phone: a wooden handset over the phone button, its screen showing a call ringing, else the app picked on the
// home screen; the games take the pad. It folds like a foldable: folded, a tab on its right edge says 田头 and whether
// there is something new; unfolded, its right screen is the chat (ChatWindow), and on a narrow screen only the chat
// shows. Esc folds it, then puts it away; put away, it comes out folded.

import { phoneWording } from "./words";
import { createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { InboxItem } from "@vibevalley/protocol";
import { missedOf, phoneCalls } from "./calls";
import { ChatWindow } from "../chat/ChatWindow";
import { useCore } from "../../base/frame";
import { unreadTotal } from "../../rules/chat";
import { useFarm } from "../state";
import { voiceCall } from "../../voice/call";
import { lcd } from "./lcd";
import type { PadButton } from "./pad";
import { playSound } from "../../ui/pixel/sound";
import { farm } from "../store";
import { useRouter } from "../../base/router";
import { padListening, phoneState, pressPad } from "../support";
import { BlocksGame } from "./games/BlocksGame";
import { BugSnakeGame } from "./games/BugSnakeGame";
import { DinoGame } from "./games/DinoGame";
import { MergeGame } from "./games/MergeGame";
import { SokobanGame } from "./games/SokobanGame";
import { GamesScreen, HomeScreen, ListScreen, OrchestratorScreen, type PhoneApp, RingingScreen } from "./screens";

const games: ReadonlySet<PhoneApp> = new Set(["blocks", "dino", "sokoban", "bugs", "merge"]);

/** What rang, for the orchestrator to open the call with. */
const aboutOf = (call: InboxItem) => `${call.who}：${call.words.label}。${call.text}`;

/** room: the most it may take, inside the farm's box. */
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
    // Answering is the call: the orchestrator comes on and says what rang, on the phone unfolded to 田头; the farm shows
    // what called beside it.
    farm.chatOpen(true);
    void voiceCall.start(aboutOf(call));
    switch (call.target.kind) {
      case "session":
        return farm.select(call.target.id);
      case "graph":
        return farm.openTaskBoard(call.target.graph);
      case "chat":
        return router.navigate(`/chat/${call.target.conversation}`);
    }
  };
  const game = () => ringing() === null && games.has(app());
  const core = useCore();
  const unfolded = useFarm((s) => s.chatOpen);
  const large = useFarm((s) => s.chatLarge);
  return (
    <Handset
      big={game()}
      tall={game() || ringing() !== null}
      unfolded={unfolded()}
      large={large()}
      narrow={props.room.w < 640}
      room={props.room}
      unread={unreadTotal(core()?.chat)}
      chat={<ChatWindow />}
      onClose={put}
      onHome={() => {
        playSound("tap");
        if (app() === "home" && ringing() === null) put();
        else {
          // A game goes back to the games folder, the rest to the home screen.
          setApp(ringing() === null && games.has(app()) ? "games" : "home");
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
                // Tapping 管家 is calling it: its line on the left, 田头 unfolded beside it where what is said shows. A call
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
                onTaskBoard={() => {
                  put();
                  farm.openTaskBoard();
                }}
              />
            </Match>
            <Match when={app() === "games"}>
              <GamesScreen onOpen={open} />
            </Match>
            <Match when={app() === "missed" || app() === "log"}>
              <ListScreen screen={app() as "missed" | "log"} onScreen={setApp} onAnswer={(c) => settle(c, true)} onCall={() => open("orchestrator")} />
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
  onSettled(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  });
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
  // Unfolded it is one handset with one screen, the phone's apps and the chat side by side over a thin seam, as a foldable
  // shows two views; the screen is tall to give the chat room, large as tall as the farm's box lets it be. A handset's
  // chrome around its screen (the speaker and the padding) is about 34 px tall, 90 with the pad, which shows only while a
  // game takes it.
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
      aria-label={phoneWording().label}
      class="pointer-events-auto relative px-[10px] pt-[10px] pb-3 font-pixel text-[12px] leading-[1.5] tabular-nums"
      style={{
        width: `${width()}px`,
        background: body,
        // The outline over a 4 px dark band at the bottom and right and a light one at the top and left.
        "box-shadow": `${outline}, inset -4px -4px 0 0 #4a321e, inset 4px 4px 0 0 #8a6440, 3px 4px 0 0 #1e140a73`,
        color: lcd.ink,
      }}
    >
      <div class="mx-auto mb-2 h-1 w-10 bg-[#1e140b]" />
      <div class="flex flex-col p-[2px]" style={{ height: `${screen()}px`, background: lcd.paper, "box-shadow": `${outline}, inset 3px 3px 0 0 #a8bd78` }}>
        <div class="flex items-center gap-1 px-1.5 py-0.5" style={{ "border-bottom": `2px solid ${lcd.dark}` }}>
          <Signal />
          {/* The phone has no keys outside a game: its name in the status bar goes back to the home screen. */}
          <button
            type="button"
            aria-label={phoneWording().home}
            title={phoneWording().homeHint}
            onClick={() => props.onHome()}
            class="cursor-pointer hover:underline"
          >
            {phoneWording().brand}
          </button>
          <span class="ml-auto">
            {two(now().getHours())}:{two(now().getMinutes())}
          </span>
          <Battery />
        </div>
        <div class="flex min-h-0 flex-1">
          <Show when={!(props.unfolded && props.narrow)}>
            <div class="flex min-h-0 shrink-0 flex-col overflow-hidden" style={{ width: `${appsWidth()}px` }}>
              {props.children}
            </div>
          </Show>
          <Show when={props.unfolded}>
            <Show when={!props.narrow}>
              <i class="block w-[2px] shrink-0" style={{ background: lcd.dark }} aria-hidden="true" />
            </Show>
            <div class="min-h-0 shrink-0" style={{ width: `${chatWidth()}px` }}>
              {props.chat}
            </div>
          </Show>
        </div>
      </div>
      <Show when={pad()}>
        <div class="mt-2 flex items-center justify-between px-1">
          <Cross />
          <span class="flex gap-2">
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
      aria-label={props.unread > 0 ? phoneWording().openChatUnread(props.unread) : phoneWording().openChat}
      title={phoneWording().openChat}
      onClick={() => {
        playSound("open");
        farm.chatOpen(true);
      }}
      class="absolute top-16 left-full flex w-8 cursor-pointer flex-col items-center gap-0.5 py-2.5 text-[13px] leading-[15px] text-[#f7e8c4] active:translate-x-px"
      style={{ background: body, "box-shadow": `${outline}, inset -3px -3px 0 0 #4a321e, 3px 4px 0 0 #1e140a73` }}
    >
      <For each={phoneWording().chatTab}>{(c) => <span>{c}</span>}</For>
      <Show when={props.unread > 0}>
        <span class="block size-2.5 bg-berry shadow-[inset_0_0_0_2px_#2f1f1340]" />
      </Show>
    </button>
  );
}

function Signal() {
  return (
    <span class="flex items-end gap-px" aria-hidden="true">
      <For each={[3, 5, 7, 9]}>{(h) => <i class="block w-[2px]" style={{ height: `${h}px`, background: lcd.ink }} />}</For>
    </span>
  );
}

function Battery() {
  return (
    <span class="flex items-center" aria-hidden="true">
      <i class="relative block h-2 w-[14px]" style={{ background: lcd.ink }}>
        <i class="absolute top-[2px] right-[2px] block size-1" style={{ background: lcd.light }} />
      </i>
      <i class="block h-1 w-[2px]" style={{ background: lcd.ink }} />
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

function CrossKey(props: { button: PadButton; label: string; at: string }) {
  const key = createPress(() => props.button);
  return (
    <button
      type="button"
      aria-label={props.label}
      onPointerDown={key.onPointerDown}
      onPointerUp={key.onPointerUp}
      onPointerCancel={key.onPointerCancel}
      onPointerLeave={key.onPointerLeave}
      class={["absolute size-4", props.at]}
      style={{ background: key.down() ? "#1e140b" : bark }}
    />
  );
}

function Cross() {
  return (
    <span class="relative block size-12">
      <CrossKey button="up" label={phoneWording().key.up} at="top-0 left-4" />
      <CrossKey button="left" label={phoneWording().key.left} at="top-4 left-0" />
      <CrossKey button="right" label={phoneWording().key.right} at="top-4 right-0" />
      <CrossKey button="down" label={phoneWording().key.down} at="bottom-0 left-4" />
      <i class="absolute top-4 left-4 size-4" style={{ background: bark }} />
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
      class="grid size-6 place-items-center leading-none text-[#f7e8c4]"
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
