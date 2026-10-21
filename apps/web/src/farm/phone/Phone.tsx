// The farm phone: a wooden handset over the phone button, its screen showing a call ringing, else the app picked on the
// home screen; the games take the pad. Esc puts it away.

import { createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { InboxItem } from "@vibevalley/protocol";
import { missedOf, phoneCalls } from "./calls";
import { voiceCall } from "../../voice/call";
import { lcd } from "./lcd";
import type { PadButton } from "./pad";
import { playSound } from "../sound";
import { farm } from "../store";
import { useRouter } from "../../app/router";
import { padListening, phoneState, pressPad } from "../support";
import { BlocksGame } from "./games/BlocksGame";
import { BugSnakeGame } from "./games/BugSnakeGame";
import { DinoGame } from "./games/DinoGame";
import { MergeGame } from "./games/MergeGame";
import { SokobanGame } from "./games/SokobanGame";
import { HomeScreen, ListScreen, ManagerScreen, type PhoneApp, RingingScreen } from "./screens";

const games: ReadonlySet<PhoneApp> = new Set(["blocks", "dino", "sokoban", "bugs", "merge"]);

/** What rang, for the manager to open the call with. */
const aboutOf = (call: InboxItem) => `${call.who}：${call.words.label}。${call.text}`;

export function Phone() {
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
    // Answering is the call: the manager comes on and says what rang; the farm shows it meanwhile.
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
  return (
    <Handset
      big={game()}
      tall={game() || ringing() !== null}
      onClose={put}
      onHome={() => {
        playSound("tap");
        if (app() === "home" && ringing() === null) put();
        else {
          setApp("home");
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
            <Match when={app() === "missed" || app() === "log"}>
              <ListScreen screen={app() as "missed" | "log"} onScreen={setApp} onAnswer={(c) => settle(c, true)} onCall={() => open("manager")} />
            </Match>
            <Match when={app() === "manager"}>
              <ManagerScreen />
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

function Handset(props: { children: JSX.Element; big: boolean; tall: boolean; onClose: () => void; onHome: () => void }) {
  const [now, setNow] = createSignal(new Date());
  onSettled(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  });
  onSettled(() => {
    // On the capture phase, so Esc puts the phone away before the farm opens its menu.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });
  const listening = padListening();
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    <section
      aria-label="农场手机"
      class="pointer-events-auto px-[10px] pt-[10px] pb-3 font-pixel text-[12px] leading-[1.5] tabular-nums"
      style={{
        width: `${props.big ? 356 : 236}px`,
        background: body,
        // The outline over a 4 px dark band at the bottom and right and a light one at the top and left.
        "box-shadow": `${outline}, inset -4px -4px 0 0 #4a321e, inset 4px 4px 0 0 #8a6440, 3px 4px 0 0 #1e140a73`,
        color: lcd.ink,
      }}
    >
      <div class="mx-auto mb-2 h-1 w-10 bg-[#1e140b]" />
      <div
        class="flex flex-col p-[2px]"
        style={{ height: `${props.tall ? 440 : 300}px`, background: lcd.paper, "box-shadow": `${outline}, inset 3px 3px 0 0 #a8bd78` }}
      >
        <div class="flex items-center gap-1 px-1.5 py-0.5" style={{ "border-bottom": `2px solid ${lcd.dark}` }}>
          <Signal />
          <span>农场通</span>
          <span class="ml-auto">
            {two(now().getHours())}:{two(now().getMinutes())}
          </span>
          <Battery />
        </div>
        <div class="flex min-h-0 flex-1 flex-col overflow-hidden">{props.children}</div>
      </div>
      <div class="mt-2 flex items-center justify-between px-1">
        <Cross live={listening()} />
        <button
          type="button"
          aria-label="主屏"
          title="主屏"
          onClick={() => props.onHome()}
          class="block h-[18px] w-10 cursor-pointer active:translate-y-px"
          style={{ background: "#46301d", "box-shadow": `${outline}, inset 4px 4px 0 0 #5c4029` }}
        />
        <span class="flex gap-2">
          <AbKey button="b" label="B" live={listening()} />
          <AbKey button="a" label="A" live={listening()} />
        </span>
      </div>
    </section>
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

/** A pad key held with the mouse or a finger; dim and dead while no game listens. */
function createPress(button: () => PadButton, live: () => boolean) {
  const [down, setDown] = createSignal(false);
  const set = (d: boolean) => {
    if (!live() || d === down()) return;
    setDown(d);
    pressPad(button(), d);
  };
  return {
    down: () => down() && live(),
    onPointerDown: (e: PointerEvent) => {
      e.preventDefault();
      set(true);
    },
    onPointerUp: () => set(false),
    onPointerCancel: () => set(false),
    onPointerLeave: () => set(false),
  };
}

function CrossKey(props: { button: PadButton; label: string; live: boolean; at: string }) {
  const key = createPress(
    () => props.button,
    () => props.live,
  );
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-disabled={props.live ? "false" : "true"}
      onPointerDown={key.onPointerDown}
      onPointerUp={key.onPointerUp}
      onPointerCancel={key.onPointerCancel}
      onPointerLeave={key.onPointerLeave}
      class={["absolute size-4", props.at]}
      style={{ background: key.down() ? "#1e140b" : bark }}
    />
  );
}

function Cross(props: { live: boolean }) {
  return (
    <span class="relative block size-12" style={{ opacity: props.live ? 1 : 0.55 }}>
      <CrossKey button="up" label="上" live={props.live} at="top-0 left-4" />
      <CrossKey button="left" label="左" live={props.live} at="top-4 left-0" />
      <CrossKey button="right" label="右" live={props.live} at="top-4 right-0" />
      <CrossKey button="down" label="下" live={props.live} at="bottom-0 left-4" />
      <i class="absolute top-4 left-4 size-4" style={{ background: bark }} />
    </span>
  );
}

function AbKey(props: { button: PadButton; label: string; live: boolean }) {
  const key = createPress(
    () => props.button,
    () => props.live,
  );
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-disabled={props.live ? "false" : "true"}
      onPointerDown={key.onPointerDown}
      onPointerUp={key.onPointerUp}
      onPointerCancel={key.onPointerCancel}
      onPointerLeave={key.onPointerLeave}
      class="grid size-6 place-items-center leading-none text-[#f7e8c4]"
      style={{
        opacity: props.live ? 1 : 0.55,
        transform: key.down() ? "translateY(1px)" : undefined,
        background: "#c84a3a",
        "box-shadow": key.down() ? outline : `${outline}, inset -4px -4px 0 0 #9c3a2d`,
      }}
    >
      {props.label}
    </button>
  );
}
