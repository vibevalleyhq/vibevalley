import "../polyfill";
import { cleanup, effect, host, keymap, Scroll, signal, Text, View, type JSX } from "nsh";

import { t, setLocale } from "@vibevalley/i18n";
import type { InboxItem } from "@vibevalley/protocol";

import { frame, call } from "../../bridge";
import { Root } from "../web/app/Root";
import { useFollowed } from "../web/features/channel/model/follow";
import { api, newSendKey, reasonOf } from "../web/infra/api";
import { useBridge } from "../web/infra/bridged";
import { useCore } from "../web/infra/frame";
import { TextArea } from "../web/ui/Field";
import { SpriteIcon } from "../web/ui/pixel/icons";
import { GameIcon, GamePad, PhoneGame, type GameId } from "./PhoneGames";

type Screen = "home" | "missed" | "log" | "orchestrator" | "games" | GameId;
type Calls = { open: boolean; narrow: boolean; ringing: InboxItem | null; missed: InboxItem[]; log: { call: InboxItem; answered: boolean }[] };
type Voice = { phase: "idle" | "connecting" | "live" | "stopping"; problem: string | null; heard: string; said: string };
const games = ["blocks", "sokoban", "dino", "bugs", "merge"] as const;
const isGame = (screen: Screen): screen is GameId => games.some((g) => g === screen);
const colors = { ink: "#22341a", dark: "#3d5a2a", paper: "#c9dc9a", pale: "#e8f0c8", light: "#b9cf8c", rule: "#9fb07a", bark: "#67482d" };
const close = () => host.post("action", { type: "dismiss_farm_form" });
const route = (path: string) => host.post("action", { type: "global_route", path });

function Label(props: { children: JSX.Element; size?: number; color?: string }) {
  return <Text style={{ fontSize: props.size ?? 12, fontFamily: "Fusion Pixel 12px Prop zh-Hans", color: props.color ?? colors.ink }}>{props.children}</Text>;
}
function Press(props: { children: JSX.Element; run: () => void; id?: string; selected?: boolean }) {
  return (
    <View
      testID={props.id}
      role="button"
      onPress={props.run}
      style={{ paddingHorizontal: 6, paddingVertical: 4, backgroundColor: props.selected ? colors.dark : colors.light }}
    >
      <Label color={props.selected ? colors.pale : colors.ink}>{props.children}</Label>
    </View>
  );
}
function IconKey(props: { label: string; run: () => void; children: JSX.Element; id: string }) {
  return (
    <View
      testID={props.id}
      role="button"
      accessibilityLabel={props.label}
      onPress={props.run}
      style={{ width: "33.333%", alignItems: "center", gap: 4, paddingBottom: 12 }}
    >
      <View
        style={{
          width: 44,
          height: 44,
          backgroundColor: colors.pale,
          borderWidth: 2,
          borderColor: colors.dark,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {props.children}
      </View>
      <Label>{props.label}</Label>
    </View>
  );
}

function Chat(props: { fold: () => void; large: () => boolean; resize: () => void; heard: () => string; said: () => string }) {
  const core = useCore();
  const chosen = signal<string | undefined>(undefined);
  const menu = signal(false);
  const rooms = () => core()?.chat?.channels.filter((c) => !c.archived) ?? [];
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
    <View testID="farm-chat" style={{ flex: 1, minWidth: 0, backgroundColor: "#f7e8c4" }}>
      <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: "#e2c995", padding: 4, gap: 3 }}>
        <View role="button" testID="chat-channel" onPress={() => menu.set(!menu())} style={{ flex: 1 }}>
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
        <Scroll style={{ maxHeight: 172 }}>
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
      <Scroll style={{ flex: 1 }} contentStyle={{ padding: 8, gap: 6 }}>
        <If when={!messages().messages.length}>
          <Label>{t("web.farm.chat.greeting")}</Label>
        </If>
        <Each of={messages().messages} key={(m) => m.id}>
          {(m) => (
            <View testID="farm-message" style={{ padding: 6, backgroundColor: "#eedcb2" }}>
              <Label color="#7f5b3b">{m().name}</Label>
              <Label>{m().text}</Label>
            </View>
          )}
        </Each>
        <If when={props.heard()}>{(s) => <Label>{s()}</Label>}</If>
        <If when={props.said()}>{(s) => <Label>{s()}</Label>}</If>
      </Scroll>
      <If when={problem()}>{(s) => <Label color="#963326">{s()}</Label>}</If>
      <View style={{ padding: 5, gap: 4 }}>
        <TextArea value={input()} onInput={input.set} rows={2} submit testID="farm-chat-input" onSubmit={(s) => void send(s)} />
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
    <View style={{ flex: 1, flexDirection: "row", alignItems: "stretch" }}>
      <View
        testID="farm-phone"
        style={{ flex: 1, backgroundColor: colors.bark, borderWidth: 2, borderColor: "#2f1f13", paddingHorizontal: 8, paddingTop: 8, paddingBottom: 10 }}
      >
        <View style={{ alignSelf: "center", width: 40, height: 4, backgroundColor: "#1e140b", marginBottom: 8 }} />
        <View style={{ flex: 1, borderWidth: 2, borderColor: "#2f1f13", backgroundColor: colors.paper }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 6,
              paddingVertical: 2,
              borderBottomWidth: 2,
              borderColor: colors.dark,
              gap: 4,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 1 }}>
              <Each of={[3, 5, 7, 9]}>{(h) => <View style={{ width: 2, height: h(), backgroundColor: colors.ink }} />}</Each>
            </View>
            <View role="button" testID="phone-home" onPress={back} style={{ flex: 1 }}>
              <Label>{t("web.farm.phone.brand")}</Label>
            </View>
            <Label>{time()}</Label>
            <View style={{ width: 14, height: 8, borderWidth: 2, borderColor: colors.ink, backgroundColor: colors.light }} />
          </View>
          <View style={{ flex: 1, flexDirection: "row" }}>
            <If when={!chatOnly()}>
              <View style={{ flex: unfolded() ? 0 : 1, width: game() ? 332 : unfolded() ? 296 : 212 }}>
                <If
                  when={ringing()}
                  else={
                    <>
                      <If when={app() === "home"}>
                        <View style={{ flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 8, paddingTop: 16 }}>
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
                        <View testID="phone-games" style={{ flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 8, paddingTop: 16 }}>
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
                        <View style={{ flexDirection: "row" }}>
                          <Press selected={app() === "missed"} run={() => app.set("missed")}>
                            {t("web.farm.phone.missed", { n: props.calls().missed.length })}
                          </Press>
                          <Press selected={app() === "log"} run={() => app.set("log")}>
                            {t("web.farm.phone.log")}
                          </Press>
                        </View>
                        <Scroll style={{ flex: 1 }} contentStyle={{ padding: 6, gap: 4 }}>
                          <If
                            when={app() === "missed"}
                            else={
                              <>
                                <If when={!props.calls().log.length}>
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
                            <If when={!props.calls().missed.length}>
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
                        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }}>
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
                    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
                      <Label>{t("web.farm.phone.ringing")}</Label>
                      <SpriteIcon name="manager-face" size={60} />
                      <Label size={20}>{item().who}</Label>
                      <Label>{item().words.label}</Label>
                      <Label>{item().text}</Label>
                      <View style={{ flexDirection: "row", gap: 16 }}>
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
          style={{ alignSelf: "flex-start", marginTop: 64, width: 32, padding: 6, backgroundColor: colors.bark, borderWidth: 2, borderColor: "#2f1f13" }}
        >
          <Label color="#f7e8c4" size={14}>
            {[...t("web.farm.phone.chatTab")].join("\n")}
          </Label>
        </View>
      </If>
    </View>
  );
}

export function FarmPhone() {
  setLocale(host.params.locale === "en" ? "en" : "zh");
  useBridge();
  const initial = host.params.calls as unknown as Calls;
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
