// 连接器: the chat apps the owner talks to the farm from. Polled while open: a scan on the
// phone moves a login on without a reload.

import { settingsWording } from "./words";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { type ConnectorID, ConnectorIDValues, type ConnectorLogin, type ConnectorState, type ConnectorStatus, generalName } from "@vibevalley/protocol";
import { api, reasonOf } from "../../base/api";
import { channelLabel, channelsOf } from "../../rules/chat";
import { momentText, wallClockText } from "../../base/format";
import { toast } from "../../ui/toasts";
import { Keyed } from "../../base/util";
import { useCore } from "../../base/frame";
import { Button } from "../../ui/Button";
import { Field, Select, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Qr } from "../../ui/Qr";
import { Card, ListCard, ListRow, Quiet, SecretInput, Split, TextLink } from "../../ui/layout";

export const connectorLabel: Record<ConnectorID, string> = {
  weixin: settingsWording().connectors.label.weixin,
  feishu: settingsWording().connectors.label.feishu,
  qq: "QQ",
};

const connectorHow: Record<ConnectorID, string> = {
  weixin: settingsWording().connectors.how.weixin,
  feishu: settingsWording().connectors.how.feishu,
  qq: settingsWording().connectors.how.qq,
};

const connectorNotes: Record<ConnectorID, string[]> = {
  weixin: settingsWording().connectors.notes.weixin,
  feishu: settingsWording().connectors.notes.feishu,
  qq: settingsWording().connectors.notes.qq,
};

const connectorsAlways = settingsWording().connectors.always;

export const stateLabel: Record<ConnectorState, string> = {
  off: settingsWording().connectors.state.off,
  waiting: settingsWording().connectors.state.waiting,
  scanned: settingsWording().connectors.state.scanned,
  verify: settingsWording().connectors.state.verify,
  pairing: settingsWording().connectors.state.pairing,
  connected: settingsWording().connectors.state.connected,
  paused: settingsWording().connectors.state.paused,
};

const dot = (s: ConnectorState | undefined) => (s === "connected" ? "bg-leaf" : s === "pairing" || s === "paused" ? "bg-wheat" : "bg-cream-300");

/** A connector's action; what it changes comes back in the core state, where the connectors say each status. */
async function act(call: () => Promise<ConnectorStatus>, quiet = false) {
  try {
    await call();
  } catch (e) {
    if (quiet) throw e;
    toast(reasonOf(e));
  }
}

export function ConnectorsPage(props: { id?: string }) {
  const core = useCore();
  const selected = () => ConnectorIDValues.find((c) => c === props.id) ?? "weixin";
  const list = () => core()?.connectors;
  const of = (c: ConnectorID) => list()?.find((s) => s.id === c);
  return (
    <Split
      list={
        <ListCard title={settingsWording().sections.connectors.label} label={settingsWording().connectors.list}>
          <li class="px-2.5 pt-1 pb-1.5 text-xs text-muted">{settingsWording().connectors.intro}</li>
          <For each={ConnectorIDValues}>
            {(c) => (
              <ListRow
                to={`/settings/connectors/${c}`}
                active={c === selected()}
                title={connectorLabel[c]}
                line={of(c) && of(c)!.state !== "off" ? stateLabel[of(c)!.state] : connectorHow[c]}
                leading={<Icon name={`connector-${c}`} size={36} />}
                trailing={<span class={["size-2 shrink-0 rounded-full", dot(of(c)?.state)]} aria-hidden="true" />}
              />
            )}
          </For>
        </ListCard>
      }
    >
      <div class="flex max-w-3xl flex-col gap-3">
        <Show
          when={list()}
          fallback={
            <Card title={connectorLabel[selected()]}>
              <Quiet>{settingsWording().asking}</Quiet>
            </Card>
          }
        >
          <Keyed key={selected()}>{() => <ConnectorCard id={selected()} status={of(selected()) ?? { id: selected(), state: "off", pending: 0 }} />}</Keyed>
        </Show>
        <Card title={settingsWording().connectors.know}>
          <ul class="flex flex-col gap-1.5">
            <For each={[...connectorNotes[selected()], connectorsAlways]}>
              {(n) => (
                <li class="flex gap-2.5 text-sm">
                  <span class="mt-2 size-1 shrink-0 rounded-full bg-faint" aria-hidden="true" />
                  {n}
                </li>
              )}
            </For>
          </ul>
        </Card>
      </div>
    </Split>
  );
}

function Row(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex gap-3">
      <span class="w-28 shrink-0 text-sm text-muted">{props.label}</span>
      <div class="min-w-0 flex-1 text-sm">{props.children}</div>
    </div>
  );
}

function ConnectorCard(props: { id: ConnectorID; status: ConnectorStatus }) {
  const [busy, setBusy] = createSignal(false);
  const run = async (call: () => Promise<ConnectorStatus>) => {
    setBusy(true);
    try {
      await act(call);
    } finally {
      setBusy(false);
    }
  };
  const login = (input: ConnectorLogin = {}) => {
    const id = props.id;
    return run(() => api.connector.login({ id, body: input }));
  };
  const logout = () => {
    const id = props.id;
    return run(() => api.connector.logout({ id }));
  };
  const verify = (code: string) => {
    const id = props.id;
    return run(() => api.connector.verify({ id, body: { code } }));
  };
  const label = () => connectorLabel[props.id];
  const disconnect = () => (
    <div>
      <Button tone="danger" disabled={busy()} onClick={() => void logout()}>
        {settingsWording().connectors.disconnect}
      </Button>
    </div>
  );
  const state = () => props.status.state;
  return (
    <Card title={label()} action={<span class="text-sm text-muted">{stateLabel[state()]}</span>}>
      <Switch>
        <Match when={state() === "off"}>
          <Show when={props.id !== "qq"} fallback={<QqLogin busy={busy()} onLogin={(appId, secret) => void login({ appId, secret })} />}>
            <p class="text-sm">{props.id === "weixin" ? settingsWording().connectors.weixinIntro : settingsWording().connectors.feishuIntro}</p>
            <div>
              <Button tone="primary" disabled={busy()} onClick={() => void login()}>
                {settingsWording().connectors.scan(label())}
              </Button>
            </div>
          </Show>
        </Match>
        <Match when={state() === "waiting" || state() === "scanned" || state() === "verify"}>
          <LoginCode status={props.status} busy={busy()} app={label()} onRefresh={() => void login({ force: true })} onVerify={(code) => void verify(code)} />
        </Match>
        <Match when={state() === "pairing"}>
          <p class="text-sm">{settingsWording().connectors.pairing(label())}</p>
          <div>
            <span class="inline-block rounded-lg bg-hover px-4 py-2 font-mono text-3xl font-semibold tracking-[4px] select-all">
              {props.status.pairCode ?? ""}
            </span>
          </div>
          <p class="text-xs text-muted">{settingsWording().connectors.pairingNote}</p>
          {disconnect()}
        </Match>
        <Match when={state() === "connected" || state() === "paused"}>
          <Row label={settingsWording().connectors.owner}>{props.status.owner ?? ""}</Row>
          <Row label={settingsWording().connectors.channel}>
            <ChannelPick id={props.id} current={props.status.channel ?? generalName} />
          </Row>
          <Show when={props.status.since}>{(since) => <Row label={settingsWording().connectors.since}>{momentText(since())}</Row>}</Show>
          <Row label={settingsWording().connectors.lastInbound}>
            {props.status.lastInbound !== undefined ? momentText(props.status.lastInbound) : settingsWording().none}
          </Row>
          <Row label={settingsWording().connectors.pending}>
            {props.status.pending > 0 ? settingsWording().connectors.pendingCount(Math.round(props.status.pending)) : settingsWording().connectors.noPending}
          </Row>
          <Show when={state() === "paused" ? props.status.pausedUntil : undefined}>
            {(until) => <p class="text-sm text-berry">{settingsWording().connectors.paused(wallClockText(until()))}</p>}
          </Show>
          {disconnect()}
        </Match>
      </Switch>
      <Show when={props.status.error}>
        <p class="text-sm text-berry">{props.status.error}</p>
      </Show>
    </Card>
  );
}

function ChannelPick(props: { id: ConnectorID; current: string }) {
  const core = useCore();
  const [error, setError] = createSignal<string>();
  const options = () => {
    const all = channelsOf(core()?.chat).map((c) => ({ value: c.name ?? generalName, label: channelLabel(c) }));
    // The one it is in, even before the farm's chat has come.
    if (!all.some((o) => o.value === props.current)) all.push({ value: props.current, label: props.current });
    return all;
  };
  const move = async (channel: string | undefined) => {
    if (!channel) return;
    const id = props.id;
    setError(undefined);
    try {
      await act(() => api.connector.channel({ id, body: { channel } }), true);
    } catch (e) {
      setError(reasonOf(e));
    }
  };
  return (
    <span class="flex flex-wrap items-center gap-2">
      <Select class="w-50" label={settingsWording().connectors.whichChannel} value={props.current} options={options()} onChange={(v) => void move(v)} />
      <Show when={error()}>
        <span class="text-xs text-berry">{error()}</span>
      </Show>
    </span>
  );
}

function QqLogin(props: { busy: boolean; onLogin: (appId: string, secret: string) => void }) {
  const [appId, setAppId] = createSignal("");
  const [secret, setSecret] = createSignal("");
  const canLogin = () => !props.busy && appId().trim() !== "" && secret().trim() !== "";
  return (
    <form
      class="flex max-w-md flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canLogin()) props.onLogin(appId().trim(), secret().trim());
      }}
    >
      <p class="text-sm">
        {settingsWording().connectors.qqBefore}{" "}
        <a class="underline" href="https://q.qq.com/" target="_blank" rel="noreferrer">
          {settingsWording().connectors.qqPlatform}
        </a>{" "}
        {settingsWording().connectors.qqAfter}
      </p>
      <Field label="AppID">
        <TextInput aria-label="AppID" class="font-mono" placeholder="102xxxxxx" value={appId()} onInput={(e) => setAppId(e.currentTarget.value)} />
      </Field>
      <Field label="AppSecret" hint={settingsWording().connectors.secretHint}>
        <SecretInput
          aria-label="AppSecret"
          placeholder={settingsWording().connectors.secret}
          value={secret()}
          onInput={(e) => setSecret(e.currentTarget.value)}
        />
      </Field>
      <div>
        <Button type="submit" tone="primary" disabled={!canLogin()}>
          {settingsWording().connectors.connectQq}
        </Button>
      </div>
    </form>
  );
}

function LoginCode(props: { status: ConnectorStatus; busy: boolean; app: string; onRefresh: () => void; onVerify: (code: string) => void }) {
  const [code, setCode] = createSignal("");
  const say = () =>
    props.status.state === "waiting"
      ? settingsWording().connectors.scanWith(props.app)
      : props.status.state === "scanned"
        ? settingsWording().connectors.scanned
        : props.status.state === "verify"
          ? settingsWording().connectors.digits
          : "";
  return (
    <div class="flex flex-wrap gap-5">
      <div class="flex size-56 items-center justify-center rounded-md border border-line bg-white p-2">
        <Show when={props.status.qr} fallback={<span class="text-xs text-muted">{settingsWording().connectors.gettingQr}</span>}>
          {(qr) => <Qr text={qr()} label={settingsWording().connectors.qr(props.app)} />}
        </Show>
      </div>
      <div class="flex max-w-md min-w-50 flex-col gap-3">
        <p class="text-sm">{say()}</p>
        <Show when={props.status.state === "verify"}>
          <form
            class="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!props.busy && code().trim()) props.onVerify(code().trim());
            }}
          >
            <TextInput
              aria-label={settingsWording().connectors.phoneDigits}
              placeholder={settingsWording().connectors.phoneDigits}
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value)}
            />
            <Button type="submit" tone="primary" disabled={props.busy || !code().trim()}>
              {settingsWording().connectors.ok}
            </Button>
          </form>
        </Show>
        <Show when={props.status.qr}>
          {(qr) => (
            <p class="text-xs text-muted">
              {settingsWording().connectors.cannotScan}
              <TextLink href={qr()}>{qr()}</TextLink>
            </p>
          )}
        </Show>
        <div>
          <Button disabled={props.busy} onClick={() => props.onRefresh()}>
            {settingsWording().connectors.newCode}
          </Button>
        </div>
      </div>
    </div>
  );
}
