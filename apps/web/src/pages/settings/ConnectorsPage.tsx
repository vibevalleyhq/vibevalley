// 连接器: the chat apps the owner talks to the farm from. Polled while open: a scan on the
// phone moves a login on without a reload.

import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { type ConnectorID, ConnectorIDValues, type ConnectorLogin, type ConnectorState, type ConnectorStatus } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { channelLabel, channelsOf } from "../../rules/chat";
import { momentText, wallClockText } from "../../rules/time";
import { toast } from "../../ui/toasts";
import { Keyed } from "../../app/util";
import { useCore } from "../../data/frame";
import { Button } from "../../ui/Button";
import { Field, Select, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Qr } from "../../ui/Qr";
import { Card, ListCard, ListRow, Quiet, SecretInput, Split, TextLink } from "../kit";

export const connectorLabel: Record<ConnectorID, string> = { weixin: "微信", feishu: "飞书", qq: "QQ" };

const connectorHow: Record<ConnectorID, string> = { weixin: "扫码登录，私聊机器人", feishu: "扫码自动建机器人", qq: "填 QQ 机器人的 AppID" };

const connectorNotes: Record<ConnectorID, string[]> = {
  weixin: [
    "只认扫码的那个微信：别人给这个机器人发的话进不来。",
    "帮工干完活，汇报马上发到微信上，不用等你先说话。微信偶尔不收时，汇报先攒着，隔一会儿再试（越隔越久，最多半小时），你下次说一句也会一起发过来（多了合成一条）。",
    "用的是腾讯官方给机器人用的接口（和 OpenClaw 的微信插件一样）。",
  ],
  feishu: [
    "扫码后，飞书会替你建一个只属于你的机器人应用，不用去开放平台手动配。",
    "建好后在飞书里找到这个机器人，私聊它发配对码：发了码的人就是主人，只有主人的话进得来。只收私聊，群里的不收。",
    "飞书的机器人可以随时给你发消息，汇报不用等你先说话。",
  ],
  qq: [
    "QQ 没有扫码建机器人：先在 QQ 开放平台（q.qq.com）建一个机器人，打开「单聊」消息，把 AppID 和 AppSecret 填在这里。",
    "用你自己的 QQ 加这个机器人，私聊它发配对码：发了码的人就是主人。只收私聊。",
    "QQ 只让机器人在你说话后的一小段时间里回复。过了时间的汇报先攒着，隔一会儿再试，你下次说一句就一起发过来。",
  ],
};

const connectorsAlways = "帮工能在这台电脑上跑命令，所以只认主人；回复时引用某条汇报，你的话会进那件活的工单串。VibeValley 只往外连，不开端口。";

export const stateLabel: Record<ConnectorState, string> = {
  off: "没连接",
  waiting: "等你扫码",
  scanned: "已扫码，等手机确认",
  verify: "要输入手机上的数字",
  pairing: "等你发配对码",
  connected: "已连接",
  paused: "暂停中",
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
        <ListCard title="连接器" label="连接器列表">
          <li class="px-2.5 pt-1 pb-1.5 text-xs text-muted">在聊天软件里和管家说话：派活、问进度、收汇报。</li>
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
              <Quiet>在问服务端……</Quiet>
            </Card>
          }
        >
          <Keyed key={selected()}>{() => <ConnectorCard id={selected()} status={of(selected()) ?? { id: selected(), state: "off", pending: 0 }} />}</Keyed>
        </Show>
        <Card title="要知道的">
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
        断开
      </Button>
    </div>
  );
  const state = () => props.status.state;
  return (
    <Card title={label()} action={<span class="text-sm text-muted">{stateLabel[state()]}</span>}>
      <Switch>
        <Match when={state() === "off"}>
          <Show when={props.id !== "qq"} fallback={<QqLogin busy={busy()} onLogin={(appId, secret) => void login({ appId, secret })} />}>
            <p class="text-sm">
              {props.id === "weixin"
                ? "用手机微信扫一个码，就能在微信里和管家说话：派活、问进度，帮工的汇报和提问也会发到微信上。"
                : "用手机飞书扫一个码，飞书会替你建一个机器人；在飞书里和它说话，就是和管家说话。"}
            </p>
            <div>
              <Button tone="primary" disabled={busy()} onClick={() => void login()}>
                {label()}扫码登录
              </Button>
            </div>
          </Show>
        </Match>
        <Match when={state() === "waiting" || state() === "scanned" || state() === "verify"}>
          <LoginCode status={props.status} busy={busy()} app={label()} onRefresh={() => void login({ force: true })} onVerify={(code) => void verify(code)} />
        </Match>
        <Match when={state() === "pairing"}>
          <p class="text-sm">机器人连上了。最后一步：用你自己的{label()}，私聊这个机器人，发：</p>
          <div>
            <span class="inline-block rounded-lg bg-hover px-4 py-2 font-mono text-3xl font-semibold tracking-[4px] select-all">
              {props.status.pairCode ?? ""}
            </span>
          </div>
          <p class="text-xs text-muted">发了这个码的人就是主人：以后只有这个人的话进得来。码只能用一次。</p>
          {disconnect()}
        </Match>
        <Match when={state() === "connected" || state() === "paused"}>
          <Row label="主人">{props.status.owner ?? ""}</Row>
          <Row label="接在">
            <ChannelPick id={props.id} current={props.status.channel ?? "田头"} />
          </Row>
          <Show when={props.status.since}>{(since) => <Row label="连上的时间">{momentText(since())}</Row>}</Show>
          <Row label="上次收到你的话">{props.status.lastInbound !== undefined ? momentText(props.status.lastInbound) : "还没有"}</Row>
          <Row label="等着发给你的">{props.status.pending > 0 ? `${Math.round(props.status.pending)} 条：你下次说话时一起发` : "没有"}</Row>
          <Show when={state() === "paused" ? props.status.pausedUntil : undefined}>
            {(until) => <p class="text-sm text-berry">登录过期了，{wallClockText(until())} 后再试；也可以断开重新连。</p>}
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
    const all = channelsOf(core()?.chat).map((c) => ({ value: c.name ?? "田头", label: channelLabel(c) }));
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
      <Select class="w-50" label="接在哪个频道" value={props.current} options={options()} onChange={(v) => void move(v)} />
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
        在{" "}
        <a class="underline" href="https://q.qq.com/" target="_blank" rel="noreferrer">
          QQ 开放平台
        </a>{" "}
        建一个机器人，打开单聊消息，把它的 AppID 和 AppSecret 填在这里。
      </p>
      <Field label="AppID">
        <TextInput aria-label="AppID" class="font-mono" placeholder="102xxxxxx" value={appId()} onInput={(e) => setAppId(e.currentTarget.value)} />
      </Field>
      <Field label="AppSecret" hint="只存在这台电脑的数据库里，不会再显示。">
        <SecretInput aria-label="AppSecret" placeholder="机器人密钥" value={secret()} onInput={(e) => setSecret(e.currentTarget.value)} />
      </Field>
      <div>
        <Button type="submit" tone="primary" disabled={!canLogin()}>
          连接 QQ 机器人
        </Button>
      </div>
    </form>
  );
}

function LoginCode(props: { status: ConnectorStatus; busy: boolean; app: string; onRefresh: () => void; onVerify: (code: string) => void }) {
  const [code, setCode] = createSignal("");
  const say = () =>
    props.status.state === "waiting"
      ? `用手机${props.app}扫这个码。`
      : props.status.state === "scanned"
        ? "扫好了，在手机上点确认。"
        : props.status.state === "verify"
          ? "输入手机上显示的数字："
          : "";
  return (
    <div class="flex flex-wrap gap-5">
      <div class="flex size-56 items-center justify-center rounded-md border border-line bg-white p-2">
        <Show when={props.status.qr} fallback={<span class="text-xs text-muted">在拿二维码……</span>}>
          {(qr) => <Qr text={qr()} label={`${props.app}登录二维码`} />}
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
            <TextInput aria-label="手机上的数字" placeholder="手机上的数字" value={code()} onInput={(e) => setCode(e.currentTarget.value)} />
            <Button type="submit" tone="primary" disabled={props.busy || !code().trim()}>
              确定
            </Button>
          </form>
        </Show>
        <Show when={props.status.qr}>
          {(qr) => (
            <p class="text-xs text-muted">
              扫不了？在手机上打开这个链接：<TextLink href={qr()}>{qr()}</TextLink>
            </p>
          )}
        </Show>
        <div>
          <Button disabled={props.busy} onClick={() => props.onRefresh()}>
            换一个码
          </Button>
        </div>
      </div>
    </div>
  );
}
