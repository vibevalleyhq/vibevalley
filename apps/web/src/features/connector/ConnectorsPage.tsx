import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type ConnectorID, ConnectorIDValues, type ConnectorLogin, type ConnectorState, type ConnectorStatus } from "@vibevalley/protocol";
import { defaultOf } from "@vibevalley/protocol/rules";

import { Keyed } from "#/base/dom.tsx";
import { momentText, wallClockText } from "#/base/format.ts";
import { channelLabel, topsOf } from "#/features/channel/index.ts";
import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Field, Select, TextInput } from "#/ui/Field.tsx";
import { Card, ListCard, ListRow, Quiet, SecretInput, Split, TextLink } from "#/ui/layout.tsx";
import { SpriteIcon } from "#/ui/pixel/index.ts";
import { Qr } from "#/ui/Qr.tsx";

const variantStyles = stylex.create({
  qqLoginTextInput: {
    fontFamily: "var(--font-mono)",
  },
});

const viewStyles = stylex.create({
  connectorsPageLi: {
    paddingInline: "calc(var(--spacing) * 2.5)",
    paddingTop: "var(--spacing)",
    paddingBottom: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  connectorsPageDiv: {
    display: "flex",
    maxWidth: "var(--container-3xl)",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  connectorsPageUl: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
  },
  connectorsPageLi2: {
    display: "flex",
    gap: "calc(var(--spacing) * 2.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  connectorsPageSpan: {
    marginTop: "calc(var(--spacing) * 2)",
    width: "var(--spacing)",
    height: "var(--spacing)",
    flexShrink: "0",
    borderRadius: "2147483647px",
    backgroundColor: "var(--wb-faint)",
  },
  rowDiv: {
    display: "flex",
    gap: "calc(var(--spacing) * 3)",
  },
  rowSpan: {
    width: "calc(var(--spacing) * 28)",
    flexShrink: "0",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  rowDiv2: {
    minWidth: "0",
    flex: "1",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  connectorCardSpan: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  connectorCardP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  connectorCardP2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  connectorCardP3: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-berry)",
  },
  channelPickSpan: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  channelPickSpan2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-berry)",
  },
  qqLoginForm: {
    display: "flex",
    maxWidth: "var(--container-md)",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  qqLoginA: {
    textDecorationLine: "underline",
  },
  loginCodeDiv: {
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 5)",
  },
  loginCodeDiv2: {
    display: "flex",
    width: "calc(var(--spacing) * 56)",
    height: "calc(var(--spacing) * 56)",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--color-white)",
    padding: "calc(var(--spacing) * 2)",
  },
  loginCodeDiv3: {
    display: "flex",
    maxWidth: "var(--container-md)",
    minWidth: "calc(var(--spacing) * 50)",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  loginCodeForm: {
    display: "flex",
    gap: "calc(var(--spacing) * 2)",
  },
});

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
          <li {...stylex.attrs(viewStyles.connectorsPageLi)}>{t("web.connector.connectors.intro")}</li>
          <For each={ConnectorIDValues}>
            {(c) => (
              <ListRow
                to={`/settings/chat/${c}`}
                item={c}
                active={c === selected()}
                title={connectorLabel[c]}
                line={lineOf(c)}
                leading={<SpriteIcon name={`connector-${c}`} size={36} />}
                trailing={<span class={["size-2 shrink-0 rounded-full", dot(of(c)?.state)]} aria-hidden="true" />}
              />
            )}
          </For>
        </ListCard>
      }
    >
      <div {...stylex.attrs(viewStyles.connectorsPageDiv)}>
        <Show
          when={list()}
          fallback={
            <Card title={connectorLabel[selected()]}>
              <Quiet>{t("web.base.form.asking")}</Quiet>
            </Card>
          }
        >
          <Keyed key={selected()}>
            {() => <ConnectorCard id={selected()} status={of(selected()) ?? { id: selected(), state: "off", pending: 0, error: "", qr: "", pairCode: "" }} />}
          </Keyed>
        </Show>
        <Card title={t("web.connector.connectors.know")}>
          <ul {...stylex.attrs(viewStyles.connectorsPageUl)}>
            <For each={[...connectorNotes[selected()], connectorsAlways]}>
              {(n) => (
                <li {...stylex.attrs(viewStyles.connectorsPageLi2)}>
                  <span {...stylex.attrs(viewStyles.connectorsPageSpan)} aria-hidden="true" />
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
    <div {...stylex.attrs(viewStyles.rowDiv)}>
      <span {...stylex.attrs(viewStyles.rowSpan)}>{props.label}</span>
      <div {...stylex.attrs(viewStyles.rowDiv2)}>{props.children}</div>
    </div>
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
    <div>
      <Button tone="danger" disabled={busy()} onClick={() => void logout()}>
        {t("web.connector.connectors.disconnect")}
      </Button>
    </div>
  );
  const state = () => props.status.state;
  return (
    <Card title={label()} action={<span {...stylex.attrs(viewStyles.connectorCardSpan)}>{stateLabel[state()]}</span>}>
      <Switch>
        <Match when={state() === "off"}>
          <Show when={props.id !== "qq"} fallback={<QqLogin busy={busy()} onLogin={(appId, secret) => void login({ appId, secret })} />}>
            <p {...stylex.attrs(viewStyles.connectorCardP)}>
              {props.id === "weixin" ? t("web.connector.connectors.weixinIntro") : t("web.connector.connectors.feishuIntro")}
            </p>
            <div>
              <Button tone="primary" data-testid="connector-login" disabled={busy()} onClick={() => void login()}>
                {t("web.connector.connectors.scan", { app: label() })}
              </Button>
            </div>
          </Show>
        </Match>
        <Match when={state() === "waiting" || state() === "scanned" || state() === "verify"}>
          <LoginCode status={props.status} busy={busy()} app={label()} onRefresh={() => void login({ force: true })} onVerify={(code) => void verify(code)} />
        </Match>
        <Match when={state() === "pairing"}>
          <p {...stylex.attrs(viewStyles.connectorCardP)}>{t("web.connector.connectors.pairing", { app: label() })}</p>
          <div>
            <span class="inline-block rounded-lg bg-hover px-4 py-2 font-mono text-3xl font-semibold tracking-[4px] select-all">{props.status.pairCode}</span>
          </div>
          <p {...stylex.attrs(viewStyles.connectorCardP2)}>{t("web.connector.connectors.pairingNote")}</p>
          {disconnect()}
        </Match>
        <Match when={state() === "connected" || state() === "paused"}>
          <Row label={t("web.connector.connectors.owner")}>{props.status.owner ?? ""}</Row>
          <Row label={t("web.connector.connectors.channel")}>
            <ChannelPick id={props.id} current={props.status.channel ?? defaultOf(core()?.chat)?.name ?? ""} />
          </Row>
          <Show when={props.status.since}>{(since) => <Row label={t("web.connector.connectors.since")}>{momentText(since())}</Row>}</Show>
          <Row label={t("web.connector.connectors.lastInbound")}>
            {props.status.lastInbound !== undefined ? momentText(props.status.lastInbound) : t("web.base.form.none")}
          </Row>
          <Row label={t("web.connector.connectors.pending")}>
            {props.status.pending > 0
              ? t("web.connector.connectors.pendingCount", { n: Math.round(props.status.pending) })
              : t("web.connector.connectors.noPending")}
          </Row>
          <Show when={state() === "paused" ? props.status.pausedUntil : undefined}>
            {(until) => <p {...stylex.attrs(viewStyles.connectorCardP3)}>{t("web.connector.connectors.paused", { clock: wallClockText(until()) })}</p>}
          </Show>
          {disconnect()}
        </Match>
      </Switch>
      <Show when={props.status.error}>
        <p {...stylex.attrs(viewStyles.connectorCardP3)}>{props.status.error}</p>
      </Show>
    </Card>
  );
}

const selectStyles = stylex.create({ channel: { width: "calc(var(--spacing) * 50)" } });

function ChannelPick(props: { id: ConnectorID; current: string }) {
  const core = useCore();
  const [error, setError] = createSignal<string>();
  // A refusal shows beside the pick.
  const act = createAct(setError);
  const options = () => {
    const all = topsOf(core()?.chat).map((c) => ({ value: c.name ?? "", label: channelLabel(c) }));
    // The one it is in, even before the farm's chat has come.
    if (!all.some((o) => o.value === props.current)) all.push({ value: props.current, label: props.current });
    return all;
  };
  const move = async (channel: string | undefined) => {
    if (!channel) return;
    const id = props.id;
    setError(undefined);
    await act.run(() => api.connector.channel.set({ id, channel }));
  };
  return (
    <span {...stylex.attrs(viewStyles.channelPickSpan)}>
      <Select
        styles={selectStyles.channel}
        label={t("web.connector.connectors.whichChannel")}
        value={props.current}
        options={options()}
        disabled={act.busy()}
        onChange={(v) => void move(v)}
      />
      <Show when={error()}>
        <span {...stylex.attrs(viewStyles.channelPickSpan2)}>{error()}</span>
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
      {...stylex.attrs(viewStyles.qqLoginForm)}
      onSubmit={(e) => {
        e.preventDefault();
        if (canLogin()) props.onLogin(appId().trim(), secret().trim());
      }}
    >
      <p {...stylex.attrs(viewStyles.connectorCardP)}>
        {t("web.connector.connectors.qqBefore")}{" "}
        <a {...stylex.attrs(viewStyles.qqLoginA)} href="https://q.qq.com/" target="_blank" rel="noreferrer">
          {t("web.connector.connectors.qqPlatform")}
        </a>{" "}
        {t("web.connector.connectors.qqAfter")}
      </p>
      <Field label="AppID">
        <TextInput
          data-testid="qq-app-id"
          aria-label="AppID"
          styles={variantStyles.qqLoginTextInput}
          placeholder="102xxxxxx"
          value={appId()}
          onInput={(e) => setAppId(e.currentTarget.value)}
        />
      </Field>
      <Field label="AppSecret" hint={t("web.connector.connectors.secretHint")}>
        <SecretInput
          data-testid="qq-secret"
          aria-label="AppSecret"
          placeholder={t("web.connector.connectors.secret")}
          value={secret()}
          onInput={(e) => setSecret(e.currentTarget.value)}
        />
      </Field>
      <div>
        <Button type="submit" tone="primary" data-testid="connector-login" disabled={!canLogin()}>
          {t("web.connector.connectors.connectQq")}
        </Button>
      </div>
    </form>
  );
}

function LoginCode(props: { status: ConnectorStatus; busy: boolean; app: string; onRefresh: () => void; onVerify: (code: string) => void }) {
  const [code, setCode] = createSignal("");
  const say = () =>
    props.status.state === "waiting"
      ? t("web.connector.connectors.scanWith", { app: props.app })
      : props.status.state === "scanned"
        ? t("web.connector.connectors.scanned")
        : props.status.state === "verify"
          ? t("web.connector.connectors.digits")
          : "";
  return (
    <div {...stylex.attrs(viewStyles.loginCodeDiv)}>
      <div {...stylex.attrs(viewStyles.loginCodeDiv2)}>
        <Show when={props.status.qr} fallback={<span {...stylex.attrs(viewStyles.connectorCardP2)}>{t("web.connector.connectors.gettingQr")}</span>}>
          {(qr) => <Qr text={qr()} label={t("web.connector.connectors.qr", { app: props.app })} />}
        </Show>
      </div>
      <div {...stylex.attrs(viewStyles.loginCodeDiv3)}>
        <p {...stylex.attrs(viewStyles.connectorCardP)}>{say()}</p>
        <Show when={props.status.state === "verify"}>
          <form
            {...stylex.attrs(viewStyles.loginCodeForm)}
            onSubmit={(e) => {
              e.preventDefault();
              if (!props.busy && code().trim()) props.onVerify(code().trim());
            }}
          >
            <TextInput
              aria-label={t("web.connector.connectors.phoneDigits")}
              placeholder={t("web.connector.connectors.phoneDigits")}
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value)}
            />
            <Button type="submit" tone="primary" disabled={props.busy || !code().trim()}>
              {t("web.connector.connectors.ok")}
            </Button>
          </form>
        </Show>
        <Show when={props.status.qr}>
          {(qr) => (
            <p {...stylex.attrs(viewStyles.connectorCardP2)}>
              {t("web.connector.connectors.cannotScan")}
              <TextLink href={qr()}>{qr()}</TextLink>
            </p>
          )}
        </Show>
        <div>
          <Button disabled={props.busy} onClick={() => props.onRefresh()}>
            {t("web.connector.connectors.newCode")}
          </Button>
        </div>
      </div>
    </div>
  );
}
