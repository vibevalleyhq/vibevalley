import type { JSX } from "@solidjs/web";
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

import { missedOf, phoneCalls, phoneState } from "./calls";
import { BlocksGame } from "./games/BlocksGame";
import { BugSnakeGame } from "./games/BugSnakeGame";
import { DinoGame } from "./games/DinoGame";
import { MergeGame } from "./games/MergeGame";
import { SokobanGame } from "./games/SokobanGame";
import { type PadButton, padListening, pressPad } from "./pad";
import { GamesScreen, HomeScreen, ListScreen, OrchestratorScreen, type PhoneApp, RingingScreen } from "./screens";

const styles = {
  phone: (width: number): JSX.CSSProperties => ({ width: `${width}px` }),
  screen: (height: number): JSX.CSSProperties => ({ height: `${height}px` }),
  appsPane: (width: number): JSX.CSSProperties => ({ width: `${width}px` }),
  chatPane: (width: number): JSX.CSSProperties => ({ width: `${width}px` }),
  signalBar: (height: number): JSX.CSSProperties => ({ height: `${height}px` }),
};

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
    <section
      aria-label={t("web.farm.phone.label")}
      data-testid="phone"
      data-screen={props.screen}
      class="pointer-events-auto relative bg-bark-600 px-2.5 pt-2.5 pb-3 font-pixel text-xs leading-[1.5] tabular-nums text-lcd-ink [box-shadow:inset_0_0_0_2px_var(--color-bark-900),_inset_-4px_-4px_0_0_var(--color-phone-shade),_inset_4px_4px_0_0_var(--color-phone-lit),_3px_4px_0_0_var(--color-px-scrim)]"
      style={styles.phone(width())}
    >
      <div class="mx-auto mb-2 h-1 w-10 bg-bark-950" />
      <div
        class="flex flex-col bg-lcd-paper p-0.5 [box-shadow:inset_0_0_0_2px_var(--color-bark-900),_inset_3px_3px_0_0_var(--color-lcd-bevel)]"
        style={styles.screen(screen())}
      >
        <div class="flex items-center gap-1 border-b-2 border-lcd-dark px-1.5 py-0.5">
          <Signal />
          {/* The phone has no keys outside a game: its name in the status bar goes back to the home screen. */}
          <button
            type="button"
            aria-label={t("web.farm.phone.home")}
            data-testid="phone-home"
            title={t("web.farm.phone.homeHint")}
            onClick={() => props.onHome()}
            class="cursor-pointer hover:underline"
          >
            {t("web.farm.phone.brand")}
          </button>
          <span class="ml-auto">
            {two(now().getHours())}:{two(now().getMinutes())}
          </span>
          <Battery />
        </div>
        <div class="flex min-h-0 flex-1">
          <Show when={!(props.unfolded && props.narrow)}>
            <div class="flex min-h-0 shrink-0 flex-col overflow-hidden" style={styles.appsPane(appsWidth())}>
              {props.children}
            </div>
          </Show>
          <Show when={props.unfolded}>
            <Show when={!props.narrow}>
              <i class="block w-0.5 shrink-0 bg-lcd-dark" aria-hidden="true" />
            </Show>
            <div class="min-h-0 shrink-0" style={styles.chatPane(chatWidth())}>
              {props.chat}
            </div>
          </Show>
        </div>
      </div>
      <Show when={pad()}>
        <div data-testid="pad" class="mt-2 flex items-center justify-between px-1">
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
      aria-label={props.unread > 0 ? t("web.farm.phone.openChatUnread", { n: props.unread }) : t("web.farm.phone.openChat")}
      data-testid="phone-chat"
      data-unread={props.unread}
      title={t("web.farm.phone.openChat")}
      onClick={() => {
        playSound("open");
        farm.chatOpen(true);
      }}
      class="absolute top-16 left-full flex w-8 cursor-pointer flex-col items-center gap-0.5 bg-bark-600 py-2.5 text-sm leading-[15px] text-cream-50 [box-shadow:inset_0_0_0_2px_var(--color-bark-900),_inset_-3px_-3px_0_0_var(--color-phone-shade),_3px_4px_0_0_var(--color-px-scrim)] active:[translate:1px_0]"
    >
      <For each={[...t("web.farm.phone.chatTab")]}>{(c) => <span>{c}</span>}</For>
      <Show when={props.unread > 0}>
        <span class="block w-2.5 h-2.5 bg-berry [box-shadow:inset_0_0_0_2px_var(--color-px-dent)]" />
      </Show>
    </button>
  );
}

function Signal() {
  return (
    <span class="flex items-end gap-px" aria-hidden="true">
      <For each={[3, 5, 7, 9]}>{(h) => <i class="block w-0.5 bg-lcd-ink" style={styles.signalBar(h)} />}</For>
    </span>
  );
}

function Battery() {
  return (
    <span class="flex items-center" aria-hidden="true">
      <i class="relative block h-2 w-3.5 bg-lcd-ink">
        <i class="absolute top-0.5 right-0.5 block w-1 h-1 bg-lcd-light" />
      </i>
      <i class="block h-1 w-0.5 bg-lcd-ink" />
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

function CrossKey(props: { button: PadButton; label: string; class: JSX.ClassValue | undefined }) {
  const key = createPress(() => props.button);
  return (
    <button
      type="button"
      aria-label={props.label}
      onPointerDown={key.onPointerDown}
      onPointerUp={key.onPointerUp}
      onPointerCancel={key.onPointerCancel}
      onPointerLeave={key.onPointerLeave}
      class={["absolute w-4 h-4", props.class, key.down() ? "bg-bark-950" : "bg-bark-900"]}
    />
  );
}

function Cross() {
  return (
    <span class="relative block w-12 h-12">
      <CrossKey button="up" label={t("web.farm.phone.key.up")} class="top-0 left-4" />
      <CrossKey button="left" label={t("web.farm.phone.key.left")} class="top-4 left-0" />
      <CrossKey button="right" label={t("web.farm.phone.key.right")} class="top-4 right-0" />
      <CrossKey button="down" label={t("web.farm.phone.key.down")} class="bottom-0 left-4" />
      <i class="absolute top-4 left-4 w-4 h-4 bg-bark-900" />
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
      class={[
        "grid w-6 h-6 place-items-center bg-berry-500 leading-none text-cream-50",
        key.down()
          ? "[transform:translateY(1px)] [box-shadow:inset_0_0_0_2px_var(--color-bark-900)]"
          : "[box-shadow:inset_0_0_0_2px_var(--color-bark-900),_inset_-4px_-4px_0_0_var(--color-phone-key-shade)]",
      ]}
    >
      {props.label}
    </button>
  );
}
