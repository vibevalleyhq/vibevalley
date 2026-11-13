// Ported from VibeValley apps/web/src/features/connector/ConnectorsPage.tsx:
// the chat apps (WeChat, Feishu, QQ) as a list beside the open one's card.
// The connectors' pixel sprites come from the app (ui/pixel); without the
// art each is a tile in the app's own colour with its initial. The
// <form>s submit from their button and the input's Return.
import { signal, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import { type ConnectorID, ConnectorIDValues, type ConnectorLogin, type ConnectorState, type ConnectorStatus } from "@vibevalley/protocol";
import { defaultOf } from "@vibevalley/protocol/rules";

import { Keyed } from "../../base/dom";
import { momentText, wallClockText } from "../../base/format";
import { api } from "../../infra/api";
import { useCore } from "../../infra/frame";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { Field, Select, TextInput } from "../../ui/Field";
import { Card, ListCard, ListRow, Quiet, SecretInput, Split } from "../../ui/layout";
import { SpriteOr } from "../../ui/pixel/icons";
import { Qr } from "../../ui/Qr";
import { TextLink } from "../../ui/TextLink";
import { channelLabel, topsOf } from "../channel";

const connectorLabel: Record<ConnectorID, string> = {
  weixin: t("web.connector.connectors.label.weixin"),
  feishu: t("web.connector.connectors.label.feishu"),
  qq: "QQ",
};

const connectorHow: Record<ConnectorID, string> = {
  weixin: t("web.connector.connectors.how.weixin"),
  feishu: t("web.connector.connectors.how.feishu"),
  qq: t("web.connector.connectors.how.qq"),
};

const connectorNotes: Record<ConnectorID, string[]> = {
  weixin: ([0, 1, 2] as const).map((i) => t(`web.connector.connectors.notes.weixin.${i}`)),
  feishu: ([0, 1, 2] as const).map((i) => t(`web.connector.connectors.notes.feishu.${i}`)),
  qq: ([0, 1, 2] as const).map((i) => t(`web.connector.connectors.notes.qq.${i}`)),
};

const connectorsAlways = t("web.connector.connectors.always");

const stateLabel: Record<ConnectorState, string> = {
  off: t("web.connector.connectors.state.off"),
  waiting: t("web.connector.connectors.state.waiting"),
  scanned: t("web.connector.connectors.state.scanned"),
  verify: t("web.connector.connectors.state.verify"),
  pairing: t("web.connector.connectors.state.pairing"),
  connected: t("web.connector.connectors.state.connected"),
  paused: t("web.connector.connectors.state.paused"),
};

const dot = (s: ConnectorState | undefined) => (s === "connected" ? "bg-leaf" : s === "pairing" || s === "paused" ? "bg-wheat" : "bg-cream-300");

/** Each app's own colour, where its sprite (connector-<id>) has its logo. */
const appColor: Record<ConnectorID, string> = { weixin: "#07c160", feishu: "#3370ff", qq: "#12b7f5" };

function ConnectorMark(props: { id: ConnectorID; size: number }) {
  return (
    <SpriteOr name={`connector-${props.id}`} size={props.size}>
      <MarkStandIn {...props} />
    </SpriteOr>
  );
}

function MarkStandIn(props: { id: ConnectorID; size: number }) {
  return (
    <View
      class="shrink-0 items-center justify-center rounded-md"
      style={{ width: props.size, height: props.size, backgroundColor: `${appColor[props.id]}26`, borderWidth: 2, borderColor: `${appColor[props.id]}80` }}
    >
      <Text class="text-sm font-semibold" style={{ color: appColor[props.id] }}>
        {connectorLabel[props.id].slice(0, 1)}
      </Text>
    </View>
  );
}

export function ConnectorsPage(props: { id?: string | undefined }) {
  const core = useCore();
  const selected = () => ConnectorIDValues.find((c) => c === props.id) ?? "weixin";
  const list = () => core()?.connectors;
  const of = (c: ConnectorID) => list()?.find((s) => s.id === c);
  const lineOf = (c: ConnectorID) => {
    const state = of(c)?.state;
    return state && state !== "off" ? stateLabel[state] : connectorHow[c];
  };
  return (
    <Split
      list={
        <ListCard title={t("web.connector.connectors.section.label")} label={t("web.connector.connectors.list")} testid="connectors">
          <View class="px-2.5 pt-1 pb-1.5">
            <Text class="text-xs text-muted">{t("web.connector.connectors.intro")}</Text>
          </View>
          <Each of={ConnectorIDValues}>
            {(c) => (
              <ListRow
                to={`/settings/chat/${c()}`}
                item={c()}
                active={c() === selected()}
                title={connectorLabel[c()]}
                line={lineOf(c())}
                leading={<ConnectorMark id={c()} size={36} />}
                trailing={<View class={`size-2 shrink-0 rounded-full ${dot(of(c())?.state)}`} />}
              />
            )}
          </Each>
        </ListCard>
      }
    >
      <View class="max-w-3xl gap-3">
        <If
          when={list()}
          else={
            <Card title={connectorLabel[selected()]}>
              <Quiet>{t("web.base.form.asking")}</Quiet>
            </Card>
          }
        >
          <Keyed key={selected()}>
            {() => <ConnectorCard id={selected()} status={of(selected()) ?? { id: selected(), state: "off", pending: 0, error: "", qr: "", pairCode: "" }} />}
          </Keyed>
        </If>
        <Card title={t("web.connector.connectors.know")}>
          <View class="gap-1.5">
            <Each of={[...connectorNotes[selected()], connectorsAlways]}>
              {(n) => (
                <View class="flex-row gap-2.5">
                  <View class="mt-2 size-1 shrink-0 rounded-full bg-faint" />
                  <Text class="min-w-0 flex-1 text-sm text-ink">{n()}</Text>
                </View>
              )}
            </Each>
          </View>
        </Card>
      </View>
    </Split>
  );
}

function Row(props: { label: string; children: JSX.Element }) {
  return (
    <View class="flex-row gap-3">
      <Text class="w-28 shrink-0 text-sm text-muted">{props.label}</Text>
      <View class="min-w-0 flex-1">
        <If when={typeof props.children === "string"} else={props.children}>
          <Text class="text-sm text-ink">{props.children as string}</Text>
        </If>
      </View>
    </View>
  );
}

export function ConnectorCard(props: { id: ConnectorID; status: ConnectorStatus }) {
  const core = useCore();
  // What an action changes comes back in the core state, where the connectors say each status.
  const act = createAct();
  const busy = act.busy;
  const login = (input: ConnectorLogin = {}) => {
    const id = props.id;
    return act.run(() => api.connector.login({ id, ...input }));
  };
  const logout = () => {
    const id = props.id;
    return act.run(() => api.connector.logout({ id }));
  };
  const verify = (code: string) => {
    const id = props.id;
    return act.run(() => api.connector.verify({ id, code }));
  };
  const label = () => connectorLabel[props.id];
  const disconnect = () => (
    <View class="flex-row">
      <Button tone="danger" testID="connector-logout" disabled={busy()} onPress={() => void logout()}>
        {t("web.connector.connectors.disconnect")}
      </Button>
    </View>
  );
  const state = () => props.status.state;
  return (
    <Card testid={`connector-${props.id}`} title={label()} action={<Text class="text-sm text-muted">{stateLabel[state()]}</Text>}>
      <If when={state() === "off"}>
        <If when={props.id !== "qq"} else={<QqLogin busy={busy()} onLogin={(appId, secret) => void login({ appId, secret })} />}>
          <Text class="text-sm text-ink">{props.id === "weixin" ? t("web.connector.connectors.weixinIntro") : t("web.connector.connectors.feishuIntro")}</Text>
          <View class="flex-row">
            <Button tone="primary" testID="connector-login" disabled={busy()} onPress={() => void login()}>
              {t("web.connector.connectors.scan", { app: label() })}
            </Button>
          </View>
        </If>
      </If>
      <If when={state() === "waiting" || state() === "scanned" || state() === "verify"}>
        <LoginCode status={props.status} busy={busy()} app={label()} onRefresh={() => void login({ force: true })} onVerify={(code) => void verify(code)} />
      </If>
      <If when={state() === "pairing"}>
        <Text class="text-sm text-ink">{t("web.connector.connectors.pairing", { app: label() })}</Text>
        <View class="flex-row">
          <View class="rounded-lg bg-hover px-4 py-2">
            <Text testID="connector-pair-code" class="select-text font-mono text-3xl font-semibold text-ink" style={{ letterSpacing: 4 }}>
              {props.status.pairCode}
            </Text>
          </View>
        </View>
        <Text class="text-xs text-muted">{t("web.connector.connectors.pairingNote")}</Text>
        {disconnect()}
      </If>
      <If when={state() === "connected" || state() === "paused"}>
        <Row label={t("web.connector.connectors.user")}>{props.status.user ?? ""}</Row>
        <Row label={t("web.connector.connectors.channel")}>
          <ChannelPick id={props.id} current={props.status.channel ?? defaultOf(core()?.chat)?.name ?? ""} />
        </Row>
        <If when={props.status.since}>{(since) => <Row label={t("web.connector.connectors.since")}>{momentText(since())}</Row>}</If>
        <Row label={t("web.connector.connectors.lastInbound")}>
          {props.status.lastInbound !== undefined ? momentText(props.status.lastInbound) : t("web.base.form.none")}
        </Row>
        <Row label={t("web.connector.connectors.pending")}>
          {props.status.pending > 0
            ? t("web.connector.connectors.pendingCount", { n: Math.round(props.status.pending) })
            : t("web.connector.connectors.noPending")}
        </Row>
        <If when={state() === "paused" ? props.status.pausedUntil : undefined}>
          {(until) => <Text class="text-sm text-berry">{t("web.connector.connectors.paused", { clock: wallClockText(until()) })}</Text>}
        </If>
        {disconnect()}
      </If>
      <If when={props.status.error}>
        <Text testID="connector-error" class="text-sm text-berry">
          {props.status.error}
        </Text>
      </If>
    </Card>
  );
}

function ChannelPick(props: { id: ConnectorID; current: string }) {
  const core = useCore();
  const error = signal<string | undefined>(undefined);
  // A refusal shows beside the pick.
  const act = createAct(error.set);
  const options = () => {
    const all = topsOf(core()?.chat).map((c) => ({ value: c.name ?? "", label: channelLabel(c) }));
    // The one it is in, even before the farm's chat has come.
    if (!all.some((o) => o.value === props.current)) all.push({ value: props.current, label: props.current });
    return all;
  };
  const move = async (channel: string | undefined) => {
    if (!channel) return;
    const id = props.id;
    error.set(undefined);
    await act.run(() => api.connector.channel.set({ id, channel }));
  };
  return (
    <View class="flex-row flex-wrap items-center gap-2">
      <Select
        class="w-50"
        testid="connector-channel"
        label={t("web.connector.connectors.whichChannel")}
        value={props.current}
        options={options()}
        disabled={act.busy()}
        onChange={(v) => void move(v)}
      />
      <If when={error()}>
        <Text class="text-xs text-berry">{error()}</Text>
      </If>
    </View>
  );
}

function QqLogin(props: { busy: boolean; onLogin: (appId: string, secret: string) => void }) {
  const appId = signal("");
  const secret = signal("");
  const canLogin = () => !props.busy && appId().trim() !== "" && secret().trim() !== "";
  const submit = () => {
    if (canLogin()) props.onLogin(appId().trim(), secret().trim());
  };
  return (
    <View class="max-w-md gap-3">
      <View class="flex-row flex-wrap items-center gap-1">
        <Text class="text-sm text-ink">{t("web.connector.connectors.qqBefore")}</Text>
        <TextLink href="https://q.qq.com/">{t("web.connector.connectors.qqPlatform")}</TextLink>
        <Text class="text-sm text-ink">{t("web.connector.connectors.qqAfter")}</Text>
      </View>
      <Field label="AppID">
        <TextInput
          testID="qq-app-id"
          accessibilityLabel="AppID"
          class="font-mono"
          placeholder="102xxxxxx"
          value={appId()}
          onInput={appId.set}
          onSubmit={submit}
        />
      </Field>
      <Field label="AppSecret" hint={t("web.connector.connectors.secretHint")}>
        <SecretInput
          testID="qq-secret"
          accessibilityLabel="AppSecret"
          placeholder={t("web.connector.connectors.secret")}
          value={secret()}
          onInput={secret.set}
          onSubmit={submit}
        />
      </Field>
      <View class="flex-row">
        <Button tone="primary" testID="connector-login" disabled={!canLogin()} onPress={submit}>
          {t("web.connector.connectors.connectQq")}
        </Button>
      </View>
    </View>
  );
}

function LoginCode(props: { status: ConnectorStatus; busy: boolean; app: string; onRefresh: () => void; onVerify: (code: string) => void }) {
  const code = signal("");
  const say = () =>
    props.status.state === "waiting"
      ? t("web.connector.connectors.scanWith", { app: props.app })
      : props.status.state === "scanned"
        ? t("web.connector.connectors.scanned")
        : props.status.state === "verify"
          ? t("web.connector.connectors.digits")
          : "";
  const send = () => {
    if (!props.busy && code().trim()) props.onVerify(code().trim());
  };
  return (
    <View class="flex-row flex-wrap gap-5">
      <View class="size-56 items-center justify-center rounded-md border border-line p-2" style={{ backgroundColor: "#ffffff" }}>
        <If when={props.status.qr} else={<Text class="text-xs text-muted">{t("web.connector.connectors.gettingQr")}</Text>}>
          {(qr) => <Qr text={qr()} label={t("web.connector.connectors.qr", { app: props.app })} />}
        </If>
      </View>
      <View class="min-w-50 max-w-md flex-1 gap-3">
        <Text class="text-sm text-ink">{say()}</Text>
        <If when={props.status.state === "verify"}>
          <View class="flex-row gap-2">
            <TextInput
              testID="connector-code"
              class="flex-1"
              accessibilityLabel={t("web.connector.connectors.phoneDigits")}
              placeholder={t("web.connector.connectors.phoneDigits")}
              value={code()}
              onInput={code.set}
              onSubmit={send}
            />
            <Button tone="primary" testID="connector-verify" disabled={props.busy || !code().trim()} onPress={send}>
              {t("web.connector.connectors.ok")}
            </Button>
          </View>
        </If>
        <If when={props.status.qr}>
          {(qr) => (
            <View class="gap-0.5">
              <Text class="text-xs text-muted">{t("web.connector.connectors.cannotScan")}</Text>
              <TextLink href={qr()}>{qr()}</TextLink>
            </View>
          )}
        </If>
        <View class="flex-row">
          <Button testID="connector-refresh" disabled={props.busy} onPress={() => props.onRefresh()}>
            {t("web.connector.connectors.newCode")}
          </Button>
        </View>
      </View>
    </View>
  );
}
