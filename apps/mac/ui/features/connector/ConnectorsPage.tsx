import { Image, signal, Text, View, windowSize, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import { type ConnectorID, ConnectorIDValues, type ConnectorLogin, type ConnectorState, type ConnectorStatus } from "@vibevalley/protocol";
import { defaultOf } from "@vibevalley/protocol/rules";

import { connectorEmblemUrl, useAssetsDir } from "../../design/art";
import { Button } from "../../design/Button";
import { ConfirmButton } from "../../design/ConfirmButton";
import { Field, Select, TextInput } from "../../design/Field";
import { Banner, Card, ListCard, ListRow, Quiet, SecretInput, Split } from "../../design/layout";
import { Qr } from "../../design/Qr";
import { CountPill } from "../../design/Tag";
import { TextLink } from "../../design/TextLink";
import { Bubble } from "../../design/Tip";
import { createAct } from "../../infra/act";
import { api } from "../../infra/api";
import { Keyed } from "../../infra/base/dom";
import { momentText, wallClockText } from "../../infra/base/format";
import { channelLabel, topsOf } from "../../infra/channelMeta";
import { useCollabSlice } from "../../infra/frame";
import { Link as A } from "../../infra/router";

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

type StateKind = "ok" | "wait" | "bad" | "idle";
const stateKind = (s: ConnectorState | undefined): StateKind => {
  if (s === "connected") return "ok";
  if (s === "paused") return "bad";
  if (s === "waiting" || s === "scanned" || s === "verify" || s === "pairing") return "wait";
  return "idle";
};

const stateDot: Record<StateKind, string> = {
  ok: "bg-leaf",
  wait: "bg-wheat",
  bad: "bg-berry",
  idle: "bg-idle",
};

function StateBadge(props: { state: ConnectorState }) {
  const kind = () => stateKind(props.state);
  const boxClass = () => (kind() === "ok" ? "bg-ok-soft" : kind() === "bad" ? "bg-bad-soft" : kind() === "wait" ? "bg-warn-soft" : "bg-hover");
  const textClass = () => (kind() === "ok" ? "text-ok-ink" : kind() === "bad" ? "text-berry" : kind() === "wait" ? "text-warn-ink" : "text-muted");
  return (
    <View class={`h-6 shrink-0 flex-row items-center gap-1.5 rounded-full px-2.5 ${boxClass()}`}>
      <View class={`size-1.5 shrink-0 rounded-full ${stateDot[kind()]}`} />
      <Text class={`text-xs font-medium ${textClass()}`}>{stateLabel[props.state]}</Text>
    </View>
  );
}

function ConnectorMark(props: { id: ConnectorID; size: number }) {
  const assetsDir = useAssetsDir();
  const src = () => {
    const dir = assetsDir();
    return dir ? connectorEmblemUrl(dir, props.id) : undefined;
  };
  return (
    <If when={src()} else={<MarkStandIn {...props} />}>
      {(url) => <Image src={url()} class="shrink-0" style={{ width: props.size, height: props.size, objectFit: "contain" }} />}
    </If>
  );
}

function MarkStandIn(props: { id: ConnectorID; size: number }) {
  return (
    <View class="shrink-0 items-center justify-center rounded-md border border-line bg-paper" style={{ width: props.size, height: props.size }}>
      <Text class="text-sm font-semibold text-ink">{connectorLabel[props.id].slice(0, 1)}</Text>
    </View>
  );
}

function ConnectorDetail(props: { selected: ConnectorID; list: readonly ConnectorStatus[] | undefined; status: ConnectorStatus }) {
  return (
    <View class="max-w-3xl gap-3">
      <If
        when={props.list}
        else={
          <Card title={connectorLabel[props.selected]}>
            <Quiet>{t("web.base.form.asking")}</Quiet>
          </Card>
        }
      >
        <Keyed key={props.selected}>{() => <ConnectorCard id={props.selected} status={props.status} />}</Keyed>
      </If>
      <Card title={t("web.connector.connectors.know")}>
        <View class="gap-2">
          <Each of={[...connectorNotes[props.selected], connectorsAlways]}>
            {(n) => (
              <View class="flex-row items-start gap-2.5">
                <View class="mt-2 size-1 shrink-0 rounded-full bg-faint" />
                <Text class="min-w-0 flex-1 text-sm leading-relaxed text-ink">{n()}</Text>
              </View>
            )}
          </Each>
        </View>
      </Card>
    </View>
  );
}

export function ConnectorsPage(props: { id?: string | undefined; basePath?: string | undefined }) {
  const collab = useCollabSlice();
  const xl = () => windowSize().width >= 1280;
  const selected = () => ConnectorIDValues.find((c) => c === props.id) ?? "weixin";
  const list = () => collab()?.connectors;
  const of = (c: ConnectorID) => list()?.find((s) => s.id === c);
  const connectedCount = () => ConnectorIDValues.filter((c) => of(c)?.state === "connected").length;
  const lineOf = (c: ConnectorID) => {
    const state = of(c)?.state;
    return state && state !== "off" ? stateLabel[state] : connectorHow[c];
  };
  const activeStatus = () => of(selected()) ?? { id: selected(), state: "off", pending: 0, error: "", qr: "", pairCode: "" };
  return (
    <If
      when={xl()}
      else={
        <View class="max-w-3xl gap-4">
          <View accessibilityLabel={t("web.connector.connectors.list")} testID="connectors" class="gap-3 rounded-xl border border-line bg-side p-3">
            <View class="flex-row items-center justify-between gap-2">
              <View class="min-w-0 flex-1 gap-0.5">
                <View class="flex-row items-center gap-2">
                  <Text role="header" class="text-sm font-semibold text-ink">
                    {t("web.connector.connectors.section.label")}
                  </Text>
                  <CountPill count={`${connectedCount()}/${ConnectorIDValues.length}`} />
                </View>
                <Text class="text-xs leading-relaxed text-muted">{t("web.connector.connectors.intro")}</Text>
              </View>
            </View>
            <View class="flex-row flex-wrap gap-2">
              <Each of={ConnectorIDValues}>
                {(c) => {
                  const st = () => of(c());
                  const state = () => st()?.state ?? "off";
                  const pending = () => Math.round(st()?.pending ?? 0);
                  const active = () => c() === selected();
                  return (
                    <A
                      href={`${props.basePath ?? "/settings/chat"}/${c()}`}
                      testID={`list-row-${c()}`}
                      accessibilityLabel={connectorLabel[c()]}
                      accessibilityState={{ selected: active() }}
                      class={`min-w-36 flex-1 flex-row items-center gap-2 rounded-lg border px-2.5 py-2 focus-visible:outline-2 focus-visible:outline-focus ${
                        active() ? "border-line bg-selected" : "border-transparent bg-page hover:bg-hover"
                      }`}
                    >
                      <ConnectorMark id={c()} size={24} />
                      <View class="min-w-0 flex-1">
                        <Text class="truncate text-sm font-medium text-ink">{connectorLabel[c()]}</Text>
                        <Text class="truncate text-2xs text-muted">{stateLabel[state()]}</Text>
                      </View>
                      <View class="shrink-0 flex-row items-center gap-1">
                        <If when={pending() > 0}>
                          <View class="rounded-full bg-warn-soft px-1.5 py-px">
                            <Text class="font-mono text-2xs font-medium text-warn-ink tabular-nums">{String(pending())}</Text>
                          </View>
                        </If>
                        <View class={`size-2 shrink-0 rounded-full ${stateDot[stateKind(state())]}`} />
                      </View>
                    </A>
                  );
                }}
              </Each>
            </View>
          </View>
          <ConnectorDetail selected={selected()} list={list()} status={activeStatus()} />
        </View>
      }
    >
      <Split
        edge
        list={
          <ListCard
            bare
            title={t("web.connector.connectors.section.label")}
            label={t("web.connector.connectors.list")}
            testid="connectors"
            action={<CountPill count={`${connectedCount()}/${ConnectorIDValues.length}`} />}
          >
            <View class="px-2 pt-0.5 pb-2">
              <Text class="text-xs leading-relaxed text-muted">{t("web.connector.connectors.intro")}</Text>
            </View>
            <Each of={ConnectorIDValues}>
              {(c) => {
                const st = () => of(c());
                const state = () => st()?.state ?? "off";
                const pending = () => Math.round(st()?.pending ?? 0);
                return (
                  <ListRow
                    to={`${props.basePath ?? "/settings/chat"}/${c()}`}
                    item={c()}
                    active={c() === selected()}
                    title={connectorLabel[c()]}
                    line={lineOf(c())}
                    leading={<ConnectorMark id={c()} size={36} />}
                    trailing={
                      <View class="shrink-0 flex-row items-center gap-1.5">
                        <If when={pending() > 0}>
                          <View class="rounded-full bg-warn-soft px-1.5 py-px">
                            <Text class="font-mono text-2xs font-medium text-warn-ink tabular-nums">{String(pending())}</Text>
                          </View>
                        </If>
                        <View tooltip={<Bubble text={stateLabel[state()]} />} class="size-4 items-center justify-center">
                          <View class={`size-2 shrink-0 rounded-full ${stateDot[stateKind(state())]}`} />
                        </View>
                      </View>
                    }
                  />
                );
              }}
            </Each>
          </ListCard>
        }
      >
        <ConnectorDetail selected={selected()} list={list()} status={activeStatus()} />
      </Split>
    </If>
  );
}

function Row(props: { label: string; numeric?: boolean; children: JSX.Element }) {
  return (
    <View class="min-h-7 flex-row items-center gap-3">
      <Text class="w-28 shrink-0 text-xs font-medium text-muted">{props.label}</Text>
      <View class="min-w-0 flex-1">
        <If when={typeof props.children === "string"} else={props.children}>
          <Text class={`text-sm text-ink ${props.numeric === true ? "tabular-nums" : ""}`}>{props.children}</Text>
        </If>
      </View>
    </View>
  );
}

function ConnectorCard(props: { id: ConnectorID; status: ConnectorStatus }) {
  const collab = useCollabSlice();
  // What an action changes comes back in the collab slice, where connectors report each status.
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
    <View class="flex-row items-center border-t border-line pt-3">
      <ConfirmButton testid="connector-logout" tone="danger" label={t("web.connector.connectors.disconnect")} disabled={busy()} onConfirm={logout} />
    </View>
  );
  const state = () => props.status.state;
  return (
    <Card
      testid={`connector-${props.id}`}
      title={
        <View class="flex-row items-center gap-2.5">
          <ConnectorMark id={props.id} size={24} />
          <Text role="header" class="truncate text-base font-semibold text-ink">
            {label()}
          </Text>
        </View>
      }
      action={<StateBadge state={state()} />}
    >
      <If when={state() === "off"}>
        <If when={props.id !== "qq"} else={<QqLogin busy={busy()} onLogin={(appId, secret) => void login({ appId, secret })} />}>
          <Text class="text-sm leading-relaxed text-ink">
            {props.id === "weixin" ? t("web.connector.connectors.weixinIntro") : t("web.connector.connectors.feishuIntro")}
          </Text>
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
        <Text class="text-sm leading-relaxed text-ink">{t("web.connector.connectors.pairing", { app: label() })}</Text>
        <View class="flex-row">
          <View class="rounded-lg border border-line bg-side px-5 py-2.5">
            <Text testID="connector-pair-code" class="select-text font-mono text-3xl font-semibold tracking-[4px] text-ink tabular-nums">
              {props.status.pairCode}
            </Text>
          </View>
        </View>
        <Text class="text-xs leading-relaxed text-muted">{t("web.connector.connectors.pairingNote")}</Text>
        {disconnect()}
      </If>
      <If when={state() === "connected" || state() === "paused"}>
        <View class="gap-2">
          <Row label={t("web.connector.connectors.user")}>{props.status.user ?? ""}</Row>
          <Row label={t("web.connector.connectors.channel")}>
            <ChannelPick id={props.id} current={props.status.channel ?? defaultOf(collab()?.chat)?.name ?? ""} />
          </Row>
          <If when={props.status.since}>
            {(since) => (
              <Row label={t("web.connector.connectors.since")} numeric>
                {momentText(since())}
              </Row>
            )}
          </If>
          <Row label={t("web.connector.connectors.lastInbound")} numeric>
            {props.status.lastInbound !== undefined ? momentText(props.status.lastInbound) : t("web.base.form.none")}
          </Row>
          <Row label={t("web.connector.connectors.pending")} numeric>
            {props.status.pending > 0
              ? t("web.connector.connectors.pendingCount", { n: Math.round(props.status.pending) })
              : t("web.connector.connectors.noPending")}
          </Row>
        </View>
        <If when={state() === "paused" ? props.status.pausedUntil : undefined}>
          {(until) => <Banner textClass="tabular-nums">{t("web.connector.connectors.paused", { clock: wallClockText(until()) })}</Banner>}
        </If>
        {disconnect()}
      </If>
      <If when={props.status.error}>
        <Banner testID="connector-error">{props.status.error}</Banner>
      </If>
    </Card>
  );
}

function ChannelPick(props: { id: ConnectorID; current: string }) {
  const collab = useCollabSlice();
  const error = signal<string | undefined>(undefined);
  // A refusal shows beside the pick.
  const act = createAct((e) => error.set(e));
  const options = () => {
    const all = topsOf(collab()?.chat).map((c) => ({ value: c.name ?? "", label: channelLabel(c) }));
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
        state={act.busy() ? "pending" : error() ? "failed" : undefined}
        onChange={(v) => void move(v)}
      />
      <If when={error()}>
        <Text class="text-xs font-medium text-berry">{error()}</Text>
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
          onInput={(v) => appId.set(v)}
          onSubmit={submit}
        />
      </Field>
      <Field label="AppSecret" hint={t("web.connector.connectors.secretHint")}>
        <SecretInput
          testID="qq-secret"
          accessibilityLabel="AppSecret"
          placeholder={t("web.connector.connectors.secret")}
          value={secret()}
          onInput={(v) => secret.set(v)}
          onSubmit={submit}
        />
      </Field>
      <View class="flex-row pt-0.5">
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
    <View class="flex-row flex-wrap items-start gap-5">
      {/* QR codes require a high-contrast light quiet zone in both light and dark themes for phone cameras. */}
      <View class={`size-56 items-center justify-center rounded-lg border border-line p-2 ${props.status.qr ? "bg-white shadow-raise" : "bg-side"}`}>
        <If when={props.status.qr} else={<Text class="text-xs text-muted">{t("web.connector.connectors.gettingQr")}</Text>}>
          {(qr) => <Qr text={qr()} label={t("web.connector.connectors.qr", { app: props.app })} />}
        </If>
      </View>
      <View class="min-w-50 max-w-md flex-1 gap-3">
        <Text class="text-sm leading-relaxed text-ink">{say()}</Text>
        <If when={props.status.state === "verify"}>
          <View class="flex-row items-center gap-2">
            <TextInput
              testID="connector-code"
              class="flex-1 font-mono"
              accessibilityLabel={t("web.connector.connectors.phoneDigits")}
              placeholder={t("web.connector.connectors.phoneDigits")}
              value={code()}
              onInput={(v) => code.set(v)}
              onSubmit={send}
            />
            <Button tone="primary" testID="connector-verify" disabled={props.busy || !code().trim()} onPress={send}>
              {t("web.connector.connectors.ok")}
            </Button>
          </View>
        </If>
        <If when={props.status.qr}>
          {(qr) => (
            <View class="gap-1">
              <Text class="text-xs text-muted">{t("web.connector.connectors.cannotScan")}</Text>
              <TextLink href={qr()}>{qr()}</TextLink>
            </View>
          )}
        </If>
        <View class="flex-row">
          <Button icon="refresh" testID="connector-refresh" disabled={props.busy} onPress={() => props.onRefresh()}>
            {t("web.connector.connectors.newCode")}
          </Button>
        </View>
      </View>
    </View>
  );
}
