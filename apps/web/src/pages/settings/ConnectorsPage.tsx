// 连接器: the chat apps the owner talks to the farm from. Polled while open: a scan on the
// phone moves a login on without a reload.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { type ConnectorID, ConnectorIDValues, type ConnectorLogin, type ConnectorState, type ConnectorStatus } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { useCore } from "../../data/frame";
import { channelsOf } from "../../rules/chat";
import { momentText, wallClockText } from "../../rules/time";
import { Button } from "../../ui/Button";
import { Field, Select, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Qr } from "../../ui/Qr";
import { useToast } from "../../ui/Toast";
import { Card, ListCard, ListRow, Quiet, SecretInput, Split, TextLink } from "../kit";

export const connectorLabel: Record<ConnectorID, string> = { weixin: "微信", feishu: "飞书", qq: "QQ" };

const how: Record<ConnectorID, string> = { weixin: "扫码登录，私聊机器人", feishu: "扫码自动建机器人", qq: "填 QQ 机器人的 AppID" };

const notes: Record<ConnectorID, string[]> = {
  weixin: [
    "只认扫码的那个微信：别人给这个机器人发的话进不了农场。",
    "帮工干完活，汇报马上发到微信上，不用等你先说话。微信偶尔不收时，汇报先攒着，隔一会儿再试（越隔越久，最多半小时），你下次说一句也会一起发过来（多了合成一条）。",
    "用的是腾讯官方给机器人用的接口（和 OpenClaw 的微信插件一样）。",
  ],
  feishu: [
    "扫码后，飞书会替你建一个只属于你的机器人应用，不用去开放平台手动配。",
    "建好后在飞书里找到这个机器人，私聊它发配对码：发了码的人就是主人，只有主人的话进农场。只收私聊，群里的不收。",
    "飞书的机器人可以随时给你发消息，汇报不用等你先说话。",
  ],
  qq: [
    "QQ 没有扫码建机器人：先在 QQ 开放平台（q.qq.com）建一个机器人，打开「单聊」消息，把 AppID 和 AppSecret 填在这里。",
    "用你自己的 QQ 加这个机器人，私聊它发配对码：发了码的人就是主人。只收私聊。",
    "QQ 只让机器人在你说话后的一小段时间里回复。过了时间的汇报先攒着，隔一会儿再试，你下次说一句就一起发过来。",
  ],
};

const always = "帮工能在这台电脑上跑命令，所以只认主人；回复时引用某条汇报，你的话会进那件活的工单串。农场只往外连，不开端口。";

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

const key = ["connectors"];

/** One connector's answer, kept over the list; a poll still out when it came is dropped, so it cannot undo it. */
function useConnectorAction() {
  const client = useQueryClient();
  const toast = useToast();
  return async (call: () => Promise<ConnectorStatus>, quiet = false) => {
    await client.cancelQueries({ queryKey: key });
    try {
      const got = await call();
      await client.cancelQueries({ queryKey: key });
      client.setQueryData<ConnectorStatus[]>(key, (all) => [...(all ?? []).filter((s) => s.id !== got.id), got]);
    } catch (e) {
      if (quiet) throw e;
      toast(reasonOf(e));
    }
  };
}

export function ConnectorsPage({ id }: { id?: string }) {
  const all = useQuery({ queryKey: key, queryFn: () => api.connector.list(), refetchInterval: 1500 });
  const selected = ConnectorIDValues.find((c) => c === id) ?? "weixin";
  const of = (c: ConnectorID) => all.data?.find((s) => s.id === c);
  return (
    <Split
      list={
        <ListCard title="连接器" label="连接器列表">
          <li className="px-2.5 pt-1 pb-1.5 text-xs text-muted">在聊天软件里和农场说话：派活、问进度、收汇报。</li>
          {ConnectorIDValues.map((c) => {
            const s = of(c);
            return (
              <ListRow
                key={c}
                to={`/settings/connectors/${c}`}
                active={c === selected}
                title={connectorLabel[c]}
                line={s && s.state !== "off" ? stateLabel[s.state] : how[c]}
                leading={<Icon name={`connector-${c}`} size={36} />}
                trailing={<span className={`size-2 shrink-0 rounded-full ${dot(s?.state)}`} aria-hidden />}
              />
            );
          })}
        </ListCard>
      }
    >
      <div className="flex max-w-3xl flex-col gap-3">
        {!all.data ? (
          <Card title={connectorLabel[selected]}>
            <Quiet>{all.error ? reasonOf(all.error) : "在问服务端……"}</Quiet>
          </Card>
        ) : (
          <ConnectorCard key={selected} id={selected} status={of(selected) ?? { id: selected, state: "off", pending: 0 }} />
        )}
        <Card title="要知道的">
          <ul className="flex flex-col gap-1.5">
            {[...notes[selected], always].map((n) => (
              <li key={n} className="flex gap-2.5 text-sm">
                <span className="mt-2 size-1 shrink-0 rounded-full bg-faint" aria-hidden />
                {n}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </Split>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-28 shrink-0 text-sm text-muted">{label}</span>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

function ConnectorCard({ id, status }: { id: ConnectorID; status: ConnectorStatus }) {
  const act = useConnectorAction();
  const [busy, setBusy] = useState(false);
  const run = async (call: () => Promise<ConnectorStatus>) => {
    setBusy(true);
    try {
      await act(call);
    } finally {
      setBusy(false);
    }
  };
  const login = (input: ConnectorLogin = {}) => run(() => api.connector.login({ id, body: input }));
  const label = connectorLabel[id];
  const disconnect = (
    <div>
      <Button tone="danger" disabled={busy} onClick={() => run(() => api.connector.logout({ id }))}>
        断开
      </Button>
    </div>
  );
  let body: ReactNode;
  switch (status.state) {
    case "off":
      body =
        id === "qq" ? (
          <QqLogin busy={busy} onLogin={(appId, secret) => login({ appId, secret })} />
        ) : (
          <>
            <p className="text-sm">
              {id === "weixin"
                ? "用手机微信扫一个码，就能在微信里和管家说话：派活、问进度，帮工的汇报和提问也会发到微信上。"
                : "用手机飞书扫一个码，飞书会替你建一个机器人；在飞书里和它说话，就是和管家说话。"}
            </p>
            <div>
              <Button tone="primary" disabled={busy} onClick={() => login()}>
                {label}扫码登录
              </Button>
            </div>
          </>
        );
      break;
    case "waiting":
    case "scanned":
    case "verify":
      body = (
        <LoginCode
          status={status}
          busy={busy}
          app={label}
          onRefresh={() => login({ force: true })}
          onVerify={(code) => run(() => api.connector.verify({ id, body: { code } }))}
        />
      );
      break;
    case "pairing":
      body = (
        <>
          <p className="text-sm">机器人连上了。最后一步：用你自己的{label}，私聊这个机器人，发：</p>
          <div>
            <span className="inline-block rounded-lg bg-hover px-4 py-2 font-mono text-3xl font-semibold tracking-[4px] select-all">
              {status.pairCode ?? ""}
            </span>
          </div>
          <p className="text-xs text-muted">发了这个码的人就是主人：以后只有这个人的话进农场。码只能用一次。</p>
          {disconnect}
        </>
      );
      break;
    case "connected":
    case "paused":
      body = (
        <>
          <Row label="主人">{status.owner ?? ""}</Row>
          <Row label="接在">
            <ChannelPick id={id} current={status.channel ?? "田头"} />
          </Row>
          {status.since !== undefined && <Row label="连上的时间">{momentText(status.since)}</Row>}
          <Row label="上次收到你的话">{status.lastInbound !== undefined ? momentText(status.lastInbound) : "还没有"}</Row>
          <Row label="等着发给你的">{status.pending > 0 ? `${Math.round(status.pending)} 条：你下次说话时一起发` : "没有"}</Row>
          {status.state === "paused" && status.pausedUntil !== undefined && (
            <p className="text-sm text-berry">登录过期了，{wallClockText(status.pausedUntil)} 后再试；也可以断开重新连。</p>
          )}
          {disconnect}
        </>
      );
  }
  return (
    <Card title={label} action={<span className="text-sm text-muted">{stateLabel[status.state]}</span>}>
      {body}
      {status.error && <p className="text-sm text-berry">{status.error}</p>}
    </Card>
  );
}

function ChannelPick({ id, current }: { id: ConnectorID; current: string }) {
  const channels = channelsOf(useCore()?.chat);
  const act = useConnectorAction();
  const [error, setError] = useState<string>();
  const options = channels.map((c) => ({ value: c.name ?? "田头", label: c.kind === "general" ? "田头" : `#${c.name}` }));
  // The one it is in, even before the farm's chat has come.
  if (!options.some((o) => o.value === current)) options.push({ value: current, label: current });
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Select
        className="w-50"
        label="接在哪个频道"
        value={current}
        options={options}
        onChange={async (v) => {
          if (!v) return;
          setError(undefined);
          try {
            await act(() => api.connector.channel({ id, body: { channel: v } }), true);
          } catch (e) {
            setError(reasonOf(e));
          }
        }}
      />
      {error && <span className="text-xs text-berry">{error}</span>}
    </span>
  );
}

function QqLogin({ busy, onLogin }: { busy: boolean; onLogin: (appId: string, secret: string) => void }) {
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const ready = !busy && appId.trim() !== "" && secret.trim() !== "";
  return (
    <form
      className="flex max-w-md flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onLogin(appId.trim(), secret.trim());
      }}
    >
      <p className="text-sm">
        在{" "}
        <a className="underline" href="https://q.qq.com/" target="_blank" rel="noreferrer">
          QQ 开放平台
        </a>{" "}
        建一个机器人，打开单聊消息，把它的 AppID 和 AppSecret 填在这里。
      </p>
      <Field label="AppID">
        <TextInput aria-label="AppID" className="font-mono" placeholder="102xxxxxx" value={appId} onChange={(e) => setAppId(e.target.value)} />
      </Field>
      <Field label="AppSecret" hint="只存在这台电脑的农场数据库里，不会再显示。">
        <SecretInput aria-label="AppSecret" placeholder="机器人密钥" value={secret} onChange={(e) => setSecret(e.target.value)} />
      </Field>
      <div>
        <Button type="submit" tone="primary" disabled={!ready}>
          连接 QQ 机器人
        </Button>
      </div>
    </form>
  );
}

function LoginCode({
  status,
  busy,
  app,
  onRefresh,
  onVerify,
}: {
  status: ConnectorStatus;
  busy: boolean;
  app: string;
  onRefresh: () => void;
  onVerify: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const say =
    status.state === "waiting"
      ? `用手机${app}扫这个码。`
      : status.state === "scanned"
        ? "扫好了，在手机上点确认。"
        : status.state === "verify"
          ? "输入手机上显示的数字："
          : "";
  return (
    <div className="flex flex-wrap gap-5">
      <div className="flex size-56 items-center justify-center rounded-md border border-line bg-white p-2">
        {status.qr ? <Qr text={status.qr} label={`${app}登录二维码`} /> : <span className="text-xs text-muted">在拿二维码……</span>}
      </div>
      <div className="flex max-w-md min-w-50 flex-col gap-3">
        <p className="text-sm">{say}</p>
        {status.state === "verify" && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy && code.trim()) onVerify(code.trim());
            }}
          >
            <TextInput aria-label="手机上的数字" placeholder="手机上的数字" value={code} onChange={(e) => setCode(e.target.value)} />
            <Button type="submit" tone="primary" disabled={busy || !code.trim()}>
              确定
            </Button>
          </form>
        )}
        {status.qr && (
          <p className="text-xs text-muted">
            扫不了？在手机上打开这个链接：<TextLink href={status.qr}>{status.qr}</TextLink>
          </p>
        )}
        <div>
          <Button disabled={busy} onClick={onRefresh}>
            换一个码
          </Button>
        </div>
      </div>
    </div>
  );
}
