import "../infra/polyfill";
import { cleanup, computed, effect, ErrorBoundary, host, keymap, Scroll, signal, Text, untracked, View, type JSX } from "nsh";
import { z } from "zod";

import { setLocale, t } from "@vibevalley/i18n";
import type { InboxItem } from "@vibevalley/protocol";
import { InboxSlice } from "@vibevalley/protocol/schema";

import { OrchestratorFace } from "../design/domain/Face";
import { TextArea } from "../design/Field";
import { Icon } from "../design/Icon";
import type { IconName } from "../design/icons";
import { useFollowed } from "../features/channel/model/follow";
import { api, newSendKey, reasonOf } from "../infra/api";
import { callDecoded, frame } from "../infra/bridge";
import { useCollabSlice } from "../infra/frame";
import { farmCallsSchema, readFarmPhoneParams, readHostLocale, type FarmCalls } from "../infra/hostParams";
import { Root } from "../infra/Root";
import { GameIcon, GamePad, PhoneGame, type GameId } from "./PhoneGames";

type Screen = "home" | "missed" | "log" | "orchestrator" | "games" | GameId;
type Calls = FarmCalls;
const activeCallPhases = InboxSlice.shape.call.exclude(["ending", "error"]);
const voiceSchema = z.object({
  phase: z.enum([...activeCallPhases.options, "stopping"]),
  problem: z.string().nullable(),
  heard: z.string(),
  said: z.string(),
});
type Voice = z.infer<typeof voiceSchema>;
const games = ["blocks", "sokoban", "dino", "bugs", "merge"] as const;
const isGame = (screen: Screen): screen is GameId => games.some((g) => g === screen);
const close = () => host.post("action", { type: "dismiss_farm_form" });
const route = (path: string) => host.post("action", { type: "global_route", path });

const labelTone = {
  ink: "text-ink",
  onAccent: "text-page",
  muted: "text-muted",
  faint: "text-faint",
  accent: "text-accent",
  error: "text-berry",
} as const;

function Label(props: { children: JSX.Element; size?: 14 | 18 | 20; tone?: keyof typeof labelTone; mono?: boolean; class?: string }) {
  const sizeClass =
    props.size === 20 ? "text-lg font-semibold" : props.size === 18 ? "text-base font-medium" : props.size === 14 ? "text-sm font-medium" : "text-xs";
  const familyClass = props.mono === true ? "font-mono tabular-nums" : "font-sans";
  return <Text class={`${familyClass} ${sizeClass} ${labelTone[props.tone ?? "ink"]} ${props.class ?? ""}`}>{props.children}</Text>;
}

function Press(props: { children: JSX.Element; run: () => void; id?: string; selected?: boolean; disabled?: boolean; class?: string }) {
  return (
    <View
      testID={props.id}
      role="button"
      disabled={props.disabled}
      onPress={() => {
        if (props.disabled !== true) props.run();
      }}
      class={`items-center justify-center rounded-md border px-2.5 py-1.5 ${
        props.selected === true ? "border-accent bg-accent" : "border-line bg-elevated hover:bg-hover"
      } ${props.disabled === true ? "opacity-50" : ""} ${props.class ?? ""}`}
    >
      <Label tone={props.selected === true ? "onAccent" : "ink"}>{props.children}</Label>
    </View>
  );
}

function IconKey(props: { label: string; run: () => void; children: JSX.Element; id: string }) {
  return (
    <View testID={props.id} role="button" accessibilityLabel={props.label} onPress={props.run} class="group items-center gap-1.5">
      <View class="h-11 w-11 items-center justify-center rounded-xl border border-line bg-elevated shadow-raise group-hover:border-line-strong group-hover:bg-hover">
        {props.children}
      </View>
      <Label tone="muted" class="text-center">
        {props.label}
      </Label>
    </View>
  );
}

function PhoneIdleCard() {
  return (
    <View testID="farm-phone-idle" class="flex-1 items-center justify-center p-2">
      <View class="w-full flex-1 items-center justify-center gap-3 rounded-2xl border border-line-strong bg-elevated p-5 shadow-float">
        <OrchestratorFace size={44} />
        <View class="items-center gap-1">
          <Label size={18}>{t("web.farm.phone.brand")}</Label>
          <Label tone="muted" class="text-center">
            {t("web.farm.phone.phase.idle")}
          </Label>
        </View>
        <View class="flex-row items-center gap-2 pt-1">
          <Press id="farm-phone-idle-workbench" run={() => route("/issues")}>
            {t("web.farm.hud.workbench")}
          </Press>
          <Press id="farm-phone-idle-close" run={close}>
            {t("web.farm.native.close")}
          </Press>
        </View>
      </View>
    </View>
  );
}

function PhoneErrorFallback(props: { readonly error: unknown; readonly reset: () => void }) {
  const detail = () => (props.error instanceof Error ? props.error.message : String(props.error));
  return (
    <View testID="farm-error-fallback" class="flex-1 items-center justify-center p-2">
      <View class="w-full flex-1 items-center justify-center gap-3 rounded-2xl border border-line-strong bg-elevated p-5 shadow-float">
        <View class="size-10 items-center justify-center rounded-full border border-berry bg-bad-soft">
          <Icon name="warn" size={18} tone="berry" />
        </View>
        <Label size={14}>{t("web.base.unreachable")}</Label>
        <Label tone="muted" class="text-center">
          {detail()}
        </Label>
        <View class="flex-row items-center gap-2 pt-1">
          <Press id="farm-error-retry" selected run={props.reset}>
            {t("web.farm.sow.retry")}
          </Press>
          <Press id="farm-error-close" run={close}>
            {t("web.farm.native.close")}
          </Press>
        </View>
      </View>
    </View>
  );
}

function Chat(props: { fold: () => void; large: () => boolean; resize: () => void; chatOnly: () => boolean; heard: () => string; said: () => string }) {
  const collab = useCollabSlice();
  const chosen = signal<string | undefined>(undefined);
  const menu = signal(false);
  const rooms = computed(() => collab()?.chat?.channels.filter((c) => c.archived === undefined) ?? []);
  const room = computed(() => rooms().find((c) => c.id === chosen()) ?? rooms().find((c) => c.default) ?? rooms()[0]);
  const messages = useFollowed(() => room()?.id);
  const input = signal("");
  const busy = signal(false);
  const problem = signal("");
  const canSend = computed(() => !busy() && input().trim().length > 0 && room() !== undefined);
  let pendingKey: { room: string; text: string; id: string } | undefined;
  const send = async (line: string) => {
    const id = untracked(room)?.id;
    const text = line.trim();
    if (!id || !text || untracked(busy)) return;
    if (pendingKey?.room !== id || pendingKey.text !== text) pendingKey = { room: id, text, id: newSendKey() };
    busy.set(true);
    problem.set("");
    input.set("");
    try {
      await api.channel.message.send({ id, text, sendKey: pendingKey.id });
      pendingKey = undefined;
    } catch (e) {
      if (untracked(input) === "") input.set(line);
      problem.set(reasonOf(e));
    } finally {
      busy.set(false);
    }
  };
  return (
    <View testID="farm-chat" class={`min-w-0 flex-1 bg-page ${props.chatOnly() ? "" : "border-l border-line"}`}>
      <View class="flex-row items-center gap-1 border-b border-line bg-side px-2.5 py-1.5">
        <View role="button" testID="chat-channel" onPress={() => menu.set(!menu())} class="min-w-0 flex-1 rounded-sm px-1 py-0.5 hover:bg-hover">
          <Label size={14}>{room()?.title ?? t("web.farm.chat.channels")}</Label>
        </View>
        <View role="button" accessibilityLabel={t("web.farm.chat.enlarge")} onPress={props.resize} class="rounded-sm p-1 hover:bg-hover">
          <Icon name="enlarge" size={14} tone="muted" />
        </View>
        <View role="button" accessibilityLabel={t("web.farm.chat.fold")} testID="chat-fold" onPress={props.fold} class="rounded-sm p-1 hover:bg-hover">
          <Icon name="collapse" size={14} tone="muted" />
        </View>
      </View>
      <If when={menu()}>
        <Scroll class="max-h-44 border-b border-line bg-side" contentClass="gap-1 p-1.5">
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
      <Scroll class="flex-1" contentClass="gap-2 p-2.5">
        <If when={messages().messages.length === 0}>
          <View class="rounded-lg border border-line bg-side p-2.5">
            <Label tone="muted">{t("web.farm.chat.greeting")}</Label>
          </View>
        </If>
        <Each of={messages().messages} key={(m) => m.id}>
          {(m) => (
            <View testID="farm-message" class="gap-0.5 rounded-lg border border-line bg-elevated px-2.5 py-1.5 shadow-raise">
              <Label tone="accent">{m().name}</Label>
              <Label>{m().text}</Label>
            </View>
          )}
        </Each>
        <If when={props.heard()}>
          {(s) => (
            <View class="rounded-lg border border-line bg-side px-2.5 py-1.5">
              <Label>{s()}</Label>
            </View>
          )}
        </If>
        <If when={props.said()}>
          {(s) => (
            <View class="rounded-lg border border-line bg-side px-2.5 py-1.5">
              <Label>{s()}</Label>
            </View>
          )}
        </If>
      </Scroll>
      <If when={problem()}>
        {(s) => (
          <View class="mx-2 mb-1 rounded-md border border-berry bg-bad-soft px-2.5 py-1.5">
            <Label tone="error">{s()}</Label>
          </View>
        )}
      </If>
      <View class="gap-1.5 border-t border-line bg-side p-2">
        <TextArea value={input()} onInput={(v) => input.set(v)} rows={2} submit testID="farm-chat-input" onSubmit={(s) => void send(s)} />
        <Press id="farm-chat-send" selected={canSend()} disabled={!canSend()} run={() => void send(untracked(input))}>
          {t("web.farm.chat.send")}
        </Press>
      </View>
    </View>
  );
}

function Handset(props: { calls: () => Calls }) {
  const app = signal<Screen>("home");
  const unfolded = signal(readFarmPhoneParams().unfolded);
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
      const result = await callDecoded(op, { id: voiceId }, voiceSchema);
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
    switch (item.target.kind) {
      case "chat":
        route(`/chat/${encodeURIComponent(item.target.channel)}`);
        break;
      case "issue":
      case "session":
      case "runtime":
        break;
    }
  };
  const helpers: readonly { id: string; label: string; icon?: IconName; run: () => void }[] = [
    { id: "missed", label: t("web.farm.phone.app.missed"), icon: "inbox", run: () => app.set("missed") },
    { id: "log", label: t("web.farm.phone.log"), icon: "log", run: () => app.set("log") },
    { id: "orchestrator", label: t("web.farm.phone.manager"), run: () => void dial() },
    { id: "channels", label: t("web.farm.phone.app.channels"), icon: "chat", run: () => route("/chat") },
    { id: "issues", label: t("web.farm.menu.issues"), icon: "issues", run: () => route("/issues") },
    { id: "games", label: t("web.farm.phone.app.games"), icon: "bolt", run: () => app.set("games") },
  ];
  const time = () => [clock().getHours(), clock().getMinutes()].map((n) => String(n).padStart(2, "0")).join(":");
  return (
    <View class="flex-1 flex-row items-stretch">
      <View testID="farm-phone" class="flex-1 rounded-2xl border border-line-strong bg-side p-2 shadow-float">
        <View class="mb-2 h-1 w-10 self-center rounded-full bg-line-strong" />
        <View class="flex-1 overflow-hidden rounded-xl border border-line bg-page">
          <View class="flex-row items-center gap-1.5 border-b border-line bg-side px-2.5 py-1.5">
            <View class="flex-row items-end gap-0.5">
              <Each of={[3, 5, 7, 9]}>{(h) => <View class="w-0.5 rounded-xs bg-accent" style={{ height: h() }} />}</Each>
            </View>
            <View role="button" testID="phone-home" onPress={back} class="flex-1">
              <Label size={14}>{t("web.farm.phone.brand")}</Label>
            </View>
            <Label mono tone="muted">
              {time()}
            </Label>
            <View class="h-2.5 w-3.5 rounded-xs border border-line-strong bg-leaf" />
          </View>
          <View class="flex-1 flex-row">
            <If when={!chatOnly()}>
              <View style={{ flex: unfolded() ? 0 : 1, width: game() ? 332 : unfolded() ? 296 : "100%" }}>
                <If
                  when={ringing()}
                  else={
                    <>
                      <If when={app() === "home"}>
                        <View class="grid grid-cols-3 gap-x-2 gap-y-3.5 px-3 pt-4">
                          <Each of={helpers} key={(a) => a.id}>
                            {(a) => (
                              <IconKey id={a().id} label={a().label} run={a().run}>
                                <If when={a().icon} else={<OrchestratorFace size={28} />}>
                                  {(icon) => <Icon name={icon()} size={20} tone="ink" />}
                                </If>
                              </IconKey>
                            )}
                          </Each>
                        </View>
                      </If>
                      <If when={app() === "games"}>
                        <View testID="phone-games" class="grid grid-cols-3 gap-x-2 gap-y-3.5 px-3 pt-4">
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
                        <View class="flex-row gap-1.5 border-b border-line bg-side p-2">
                          <Press class="flex-1" selected={app() === "missed"} run={() => app.set("missed")}>
                            {t("web.farm.phone.missed", { n: props.calls().missed.length })}
                          </Press>
                          <Press class="flex-1" selected={app() === "log"} run={() => app.set("log")}>
                            {t("web.farm.phone.log")}
                          </Press>
                        </View>
                        <Scroll class="flex-1" contentClass="gap-2 p-2.5">
                          <If
                            when={app() === "missed"}
                            else={
                              <>
                                <If when={props.calls().log.length === 0}>
                                  <View class="rounded-lg border border-line bg-side p-3">
                                    <Label tone="muted">{t("web.farm.phone.noCalls")}</Label>
                                  </View>
                                </If>
                                <Each of={props.calls().log}>
                                  {(e) => (
                                    <View class="rounded-lg border border-line bg-elevated px-2.5 py-2 shadow-raise">
                                      <Label>
                                        {e().call.who} · {e().call.words.label} · {e().answered ? t("web.farm.phone.answered") : t("web.farm.phone.declined")}
                                      </Label>
                                    </View>
                                  )}
                                </Each>
                              </>
                            }
                          >
                            <If when={props.calls().missed.length === 0}>
                              <View class="rounded-lg border border-line bg-side p-3">
                                <Label tone="muted">{t("web.farm.phone.noMissed")}</Label>
                              </View>
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
                        <View class="border-t border-line bg-side p-2">
                          <Press selected run={() => void dial()}>
                            {t("web.farm.phone.callOrchestrator")}
                          </Press>
                        </View>
                      </If>
                      <If when={app() === "orchestrator"}>
                        <View class="flex-1 items-center justify-center gap-3 p-4">
                          <OrchestratorFace size={60} />
                          <Label size={18}>{t("web.farm.phone.manager")}</Label>
                          <Label tone={error() || activeCall().problem ? "error" : "muted"} class="text-center">
                            {error() || activeCall().problem || t(active() ? "web.farm.phone.phase.live" : "web.farm.phone.phase.idle")}
                          </Label>
                          <Press selected={!active()} run={() => (active() ? void voice("host.voiceStop") : void dial())}>
                            {t(active() ? "web.farm.phone.hangUp" : "web.farm.phone.callOrchestrator")}
                          </Press>
                        </View>
                      </If>
                    </>
                  }
                >
                  {(item) => (
                    <View class="flex-1 items-center justify-center gap-3 p-4">
                      <Label tone="accent">{t("web.farm.phone.ringing")}</Label>
                      <OrchestratorFace size={60} />
                      <Label size={20}>{item().who}</Label>
                      <Label tone="muted">{item().words.label}</Label>
                      <Label class="text-center">{item().text}</Label>
                      <View class="flex-row gap-3 pt-1">
                        <Press id="decline" run={() => settle(item(), false)}>
                          {t("web.farm.phone.decline")}
                        </Press>
                        <Press id="answer" selected run={() => settle(item(), true)}>
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
                chatOnly={chatOnly}
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
          class="mt-14 w-8 items-center self-start rounded-r-xl border border-l-0 border-line-strong bg-elevated px-1.5 py-2.5 shadow-raise hover:bg-hover"
        >
          <Label tone="ink" size={14}>
            {[...t("web.farm.phone.chatTab")].join("\n")}
          </Label>
        </View>
      </If>
    </View>
  );
}

function FarmPhoneBody() {
  setLocale(readHostLocale());
  const initial = readFarmPhoneParams().calls;
  const updates = frame("calls", farmCallsSchema);
  const calls = () => updates() ?? initial;
  return (
    <Root>
      <If when={calls().open} else={<PhoneIdleCard />}>
        <Handset calls={calls} />
      </If>
    </Root>
  );
}

export function FarmPhone() {
  return (
    <ErrorBoundary fallback={(err, reset) => <PhoneErrorFallback error={err} reset={reset} />}>
      <FarmPhoneBody />
    </ErrorBoundary>
  );
}
