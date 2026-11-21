import "../infra/polyfill";
import { cleanup, effect, host, keymap, Scroll, signal, Text, View, type JSX } from "nsh";

import { t, setLocale } from "@vibevalley/i18n";
import type { InboxItem } from "@vibevalley/protocol";

import { Root } from "../app/Root";
import { TextArea } from "../design/Field";
import { SpriteIcon } from "../design/pixel/icons";
import { useFollowed } from "../features/channel/model/follow";
import { api, newSendKey, reasonOf } from "../infra/api";
import { frame, call } from "../infra/bridge";
import { useBridge } from "../infra/bridged";
import { useCore } from "../infra/frame";
import { GameIcon, GamePad, PhoneGame, type GameId } from "./PhoneGames";

type Screen = "home" | "missed" | "log" | "orchestrator" | "games" | GameId;
type Calls = { open: boolean; narrow: boolean; ringing: InboxItem | null; missed: InboxItem[]; log: { call: InboxItem; answered: boolean }[] };
type Voice = { phase: "idle" | "connecting" | "live" | "stopping"; problem: string | null; heard: string; said: string };
const games = ["blocks", "sokoban", "dino", "bugs", "merge"] as const;
const isGame = (screen: Screen): screen is GameId => games.some((g) => g === screen);
const close = () => host.post("action", { type: "dismiss_farm_form" });
const route = (path: string) => host.post("action", { type: "global_route", path });

const labelTone = {
  ink: "text-lcd-ink",
  pale: "text-lcd-pale",
  muted: "text-bark-500",
  cream: "text-cream-50",
  error: "text-phone-failed",
} as const;

function Label(props: { children: JSX.Element; size?: 14 | 18 | 20; tone?: keyof typeof labelTone }) {
  const sizeClass = props.size === 20 ? "text-xl" : props.size === 18 ? "text-[18px]" : props.size === 14 ? "text-base" : "text-xs";
  return <Text class={`font-pixel ${sizeClass} ${labelTone[props.tone ?? "ink"]}`}>{props.children}</Text>;
}
function Press(props: { children: JSX.Element; run: () => void; id?: string; selected?: boolean }) {
  return (
    <View testID={props.id} role="button" onPress={props.run} class={`px-1.5 py-1 ${props.selected === true ? "bg-lcd-dark" : "bg-lcd-light"}`}>
      <Label tone={props.selected === true ? "pale" : "ink"}>{props.children}</Label>
    </View>
  );
}
function IconKey(props: { label: string; run: () => void; children: JSX.Element; id: string }) {
  return (
    <View testID={props.id} role="button" accessibilityLabel={props.label} onPress={props.run} class="w-1/3 items-center gap-1 pb-3">
      <View class="h-11 w-11 items-center justify-center border-2 border-lcd-dark bg-lcd-pale">{props.children}</View>
      <Label>{props.label}</Label>
    </View>
  );
}

function Chat(props: { fold: () => void; large: () => boolean; resize: () => void; heard: () => string; said: () => string }) {
  const core = useCore();
  const chosen = signal<string | undefined>(undefined);
  const menu = signal(false);
  const rooms = () => core()?.chat?.channels.filter((c) => c.archived === undefined) ?? [];
  const room = () => rooms().find((c) => c.id === chosen()) ?? rooms().find((c) => c.default) ?? rooms()[0];
  const messages = useFollowed(() => room()?.id);
  const input = signal("");
  const busy = signal(false);
  const problem = signal("");
  let pendingKey: { room: string; text: string; id: string } | undefined;
  const send = async (line: string) => {
    const id = room()?.id;
    const text = line.trim();
    if (!id || !text || busy()) return;
    if (pendingKey?.room !== id || pendingKey.text !== text) pendingKey = { room: id, text, id: newSendKey() };
    busy.set(true);
    problem.set("");
    try {
      await api.channel.message.send({ id, text, sendKey: pendingKey.id });
      if (input() === line) input.set("");
      pendingKey = undefined;
    } catch (e) {
      problem.set(reasonOf(e));
    } finally {
      busy.set(false);
    }
  };
  return (
    <View testID="farm-chat" class="min-w-0 flex-1 bg-cream-50">
      <View class="flex-row items-center gap-[3px] bg-cream-200 p-1">
        <View role="button" testID="chat-channel" onPress={() => menu.set(!menu())} class="flex-1">
          <Label>{room()?.title ?? t("web.farm.chat.channels")}</Label>
        </View>
        <View role="button" accessibilityLabel={t("web.farm.chat.enlarge")} onPress={props.resize}>
          <SpriteIcon name="button-fullscreen" size={16} />
        </View>
        <View role="button" accessibilityLabel={t("web.farm.chat.fold")} testID="chat-fold" onPress={props.fold}>
          <SpriteIcon name="button-collapse" size={16} />
        </View>
      </View>
      <If when={menu()}>
        <Scroll class="max-h-[172px]">
          <Each of={rooms()} key={(c) => c.id}>
            {(c) => (
              <Press
                selected={room()?.id === c().id}
                run={() => {
                  chosen.set(c().id);
                  menu.set(false);
                }}
              >
                {c().title}
              </Press>
            )}
          </Each>
        </Scroll>
      </If>
      <Scroll class="flex-1" contentClass="gap-1.5 p-2">
        <If when={messages().messages.length === 0}>
          <Label>{t("web.farm.chat.greeting")}</Label>
        </If>
        <Each of={messages().messages} key={(m) => m.id}>
          {(m) => (
            <View testID="farm-message" class="bg-cream-100 p-1.5">
              <Label tone="muted">{m().name}</Label>
              <Label>{m().text}</Label>
            </View>
          )}
        </Each>
        <If when={props.heard()}>{(s) => <Label>{s()}</Label>}</If>
        <If when={props.said()}>{(s) => <Label>{s()}</Label>}</If>
      </Scroll>
      <If when={problem()}>{(s) => <Label tone="error">{s()}</Label>}</If>
      <View class="gap-1 p-[5px]">
        <TextArea value={input()} onInput={(v) => input.set(v)} rows={2} submit testID="farm-chat-input" onSubmit={(s) => void send(s)} />
        <Press id="farm-chat-send" run={() => void send(input())}>
          {t("web.farm.chat.send")}
        </Press>
      </View>
    </View>
  );
}

function Handset(props: { calls: () => Calls }) {
  const app = signal<Screen>("home");
  const unfolded = signal(host.params.unfolded === true);
  const large = signal(false);
  const activeCall = signal<Voice>({ phase: "idle", problem: null, heard: "", said: "" });
  const voiceId = crypto.randomUUID();
  const error = signal("");
  const clock = signal(new Date());
  const timer = setInterval(() => clock.set(new Date()), 15000);
  cleanup(() => clearInterval(timer));
  cleanup(host.on("frame:unfold", () => unfolded.set(true)));
  const ringing = () => props.calls().ringing;
  const game = () => {
    const s = app();
    return !ringing() && isGame(s) ? s : undefined;
  };
  const chatOnly = () => unfolded() && props.calls().narrow;
  const active = () => activeCall().phase !== "idle";
  const voice = async (op: "host.voiceState" | "host.voiceStart" | "host.voiceStop") => {
    try {
      const result = await call<Voice>(op, { id: voiceId });
      if (result.bizCode !== 0) {
        error.set(result.message);
        return;
      }
      if (result.data) activeCall.set(result.data);
    } catch (e) {
      error.set(reasonOf(e));
    }
  };
  let poll = false;
  let disposed = false;
  let starting = false;
  const updates = setInterval(() => {
    if (active() && !poll) {
      poll = true;
      void voice("host.voiceState").finally(() => (poll = false));
    }
  }, 500);
  cleanup(() => {
    disposed = true;
    clearInterval(updates);
    if (active() || starting) void voice("host.voiceStop");
  });
  const dial = async () => {
    app.set("orchestrator");
    unfolded.set(true);
    if (active() || starting) return;
    starting = true;
    await voice("host.voiceStart");
    starting = false;
    if (disposed) await voice("host.voiceStop");
  };
  const back = () => {
    if (ringing()) {
      host.post("action", { type: "silence_farm_phone" });
      app.set("home");
      return;
    }
    if (isGame(app())) {
      app.set("games");
      return;
    }
    if (app() !== "home") {
      app.set("home");
      return;
    }
    close();
  };
  keymap.bind("escape", () => (unfolded() ? unfolded.set(false) : close()), { when: "always" });
  effect(() =>
    host.post("action", { type: "farm_handset", unfolded: unfolded(), large: large(), game: game() !== undefined && !chatOnly(), active_call: active() }),
  );
  const settle = (item: InboxItem, answered: boolean) => {
    host.post("action", { type: "farm_call", id: item.id, answered });
    if (!answered) return;
    void dial();
    if (item.target.kind === "chat") route(`/chat/${encodeURIComponent(item.target.channel)}`);
  };
  const helpers = [
    { id: "missed", label: t("web.farm.phone.app.missed"), icon: "icon-bell", run: () => app.set("missed") },
    { id: "log", label: t("web.farm.phone.log"), icon: "icon-log", run: () => app.set("log") },
    { id: "orchestrator", label: t("web.farm.phone.manager"), icon: "manager-face", run: () => void dial() },
    { id: "channels", label: t("web.farm.phone.app.channels"), icon: "icon-board", run: () => route("/chat") },
    { id: "issues", label: t("web.farm.menu.issues"), icon: "icon-task-board", run: () => route("/issues") },
    { id: "games", label: t("web.farm.phone.app.games"), icon: "icon-hand", run: () => app.set("games") },
  ];
  const time = () => [clock().getHours(), clock().getMinutes()].map((n) => String(n).padStart(2, "0")).join(":");
  return (
    <View class="flex-1 flex-row items-stretch">
      <View testID="farm-phone" class="flex-1 border-2 border-bark-900 bg-bark-600 px-2 pt-2 pb-2.5">
        <View class="mb-2 h-1 w-10 self-center bg-bark-950" />
        <View class="flex-1 border-2 border-bark-900 bg-lcd-paper">
          <View class="flex-row items-center gap-1 border-b-2 border-lcd-dark px-1.5 py-0.5">
            <View class="flex-row items-end gap-[1px]">
              <Each of={[3, 5, 7, 9]}>{(h) => <View class="w-0.5 bg-lcd-ink" style={{ height: h() }} />}</Each>
            </View>
            <View role="button" testID="phone-home" onPress={back} class="flex-1">
              <Label>{t("web.farm.phone.brand")}</Label>
            </View>
            <Label>{time()}</Label>
            <View class="h-2 w-[14px] border-2 border-lcd-ink bg-lcd-light" />
          </View>
          <View class="flex-1 flex-row">
            <If when={!chatOnly()}>
              <View style={{ flex: unfolded() ? 0 : 1, width: game() ? 332 : unfolded() ? 296 : 212 }}>
                <If
                  when={ringing()}
                  else={
                    <>
                      <If when={app() === "home"}>
                        <View class="flex-row flex-wrap px-2 pt-4">
                          <Each of={helpers}>
                            {(a) => (
                              <IconKey id={a().id} label={a().label} run={a().run}>
                                <SpriteIcon name={a().icon} size={28} />
                              </IconKey>
                            )}
                          </Each>
                        </View>
                      </If>
                      <If when={app() === "games"}>
                        <View testID="phone-games" class="flex-row flex-wrap px-2 pt-4">
                          <Each of={games}>
                            {(g) => (
                              <IconKey id={g()} label={t(`web.farm.phone.game.${g()}`)} run={() => app.set(g())}>
                                <GameIcon id={g()} />
                              </IconKey>
                            )}
                          </Each>
                        </View>
                      </If>
                      <If when={game()}>{(id) => <PhoneGame id={id()} onBack={() => app.set("games")} />}</If>
                      <If when={app() === "log" || app() === "missed"}>
                        <View class="flex-row">
                          <Press selected={app() === "missed"} run={() => app.set("missed")}>
                            {t("web.farm.phone.missed", { n: props.calls().missed.length })}
                          </Press>
                          <Press selected={app() === "log"} run={() => app.set("log")}>
                            {t("web.farm.phone.log")}
                          </Press>
                        </View>
                        <Scroll class="flex-1" contentClass="gap-1 p-1.5">
                          <If
                            when={app() === "missed"}
                            else={
                              <>
                                <If when={props.calls().log.length === 0}>
                                  <Label>{t("web.farm.phone.noCalls")}</Label>
                                </If>
                                <Each of={props.calls().log}>
                                  {(e) => (
                                    <Label>
                                      {e().call.who} · {e().call.words.label} · {e().answered ? t("web.farm.phone.answered") : t("web.farm.phone.declined")}
                                    </Label>
                                  )}
                                </Each>
                              </>
                            }
                          >
                            <If when={props.calls().missed.length === 0}>
                              <Label>{t("web.farm.phone.noMissed")}</Label>
                            </If>
                            <Each of={props.calls().missed}>
                              {(c) => (
                                <Press run={() => settle(c(), true)}>
                                  {c().who} · {c().words.label}
                                </Press>
                              )}
                            </Each>
                          </If>
                        </Scroll>
                        <Press run={() => void dial()}>{t("web.farm.phone.callOrchestrator")}</Press>
                      </If>
                      <If when={app() === "orchestrator"}>
                        <View class="flex-1 items-center justify-center gap-2">
                          <SpriteIcon name="manager-face" size={60} />
                          <Label size={18}>{t("web.farm.phone.manager")}</Label>
                          <Label>{error() || activeCall().problem || t(active() ? "web.farm.phone.phase.live" : "web.farm.phone.phase.idle")}</Label>
                          <Press run={() => (active() ? void voice("host.voiceStop") : void dial())}>
                            {t(active() ? "web.farm.phone.hangUp" : "web.farm.phone.callOrchestrator")}
                          </Press>
                        </View>
                      </If>
                    </>
                  }
                >
                  {(item) => (
                    <View class="flex-1 items-center justify-center gap-3">
                      <Label>{t("web.farm.phone.ringing")}</Label>
                      <SpriteIcon name="manager-face" size={60} />
                      <Label size={20}>{item().who}</Label>
                      <Label>{item().words.label}</Label>
                      <Label>{item().text}</Label>
                      <View class="flex-row gap-4">
                        <Press id="decline" run={() => settle(item(), false)}>
                          {t("web.farm.phone.decline")}
                        </Press>
                        <Press id="answer" run={() => settle(item(), true)}>
                          {t("web.farm.phone.answer")}
                        </Press>
                      </View>
                    </View>
                  )}
                </If>
              </View>
            </If>
            <If when={unfolded()}>
              <Chat
                fold={() => unfolded.set(false)}
                large={large}
                resize={() => large.set(!large())}
                heard={() => activeCall().heard}
                said={() => activeCall().said}
              />
            </If>
          </View>
        </View>
        <If when={game() && !chatOnly()}>
          <GamePad />
        </If>
      </View>
      <If when={!unfolded()}>
        <View
          role="button"
          accessibilityLabel={t("web.farm.phone.openChat")}
          testID="phone-chat"
          onPress={() => unfolded.set(true)}
          class="mt-16 w-8 self-start border-2 border-bark-900 bg-bark-600 p-1.5"
        >
          <Label tone="cream" size={14}>
            {[...t("web.farm.phone.chatTab")].join("\n")}
          </Label>
        </View>
      </If>
    </View>
  );
}

const emptyCalls: Calls = { open: false, narrow: false, ringing: null, missed: [], log: [] };

function isCalls(value: unknown): value is Calls {
  return (
    typeof value === "object" &&
    value !== null &&
    "open" in value &&
    typeof value.open === "boolean" &&
    "narrow" in value &&
    typeof value.narrow === "boolean" &&
    "missed" in value &&
    Array.isArray(value.missed) &&
    "log" in value &&
    Array.isArray(value.log)
  );
}

export function FarmPhone() {
  setLocale(host.params.locale === "en" ? "en" : "zh");
  useBridge();
  const initial = isCalls(host.params.calls) ? host.params.calls : emptyCalls;
  const updates = frame<Calls>("calls");
  const calls = () => updates() ?? initial;
  return (
    <Root>
      <If when={calls().open}>
        <Handset calls={calls} />
      </If>
    </Root>
  );
}
