import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Match, Show, Switch, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Channel } from "@vibevalley/protocol";

import { aria, useClickAway } from "#/base/dom.tsx";
import { farm, farmChannelLabel } from "#/farm/store.ts";
import { createChannelForm, directsOf, topsOf, chatPath, unreadUnder } from "#/features/channel/index.ts";
import { useCore } from "#/infra/frame.ts";
import { ready, useRepos } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { PxButton, PxTextInput, SpriteIcon } from "#/ui/pixel/index.ts";
import { playSound } from "#/ui/pixel/sound.ts";

const recipeStyles = stylex.create({
  channelMenuDiv: {
    position: "absolute",
    top: "100%",
    left: "0",
    zIndex: "20",
    marginTop: "calc(var(--spacing) * 1.5)",
    width: "calc(var(--spacing) * 72)",
    backgroundColor: "var(--color-cream-50)",
    padding: "calc(var(--spacing) * 2)",
    boxShadow: "var(--shadow-px)",
  },
  channelItemButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 2)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    textAlign: "left",
  },
  channelItemButtonVariant1Case1: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-200)",
      },
    },
  },
  channelItemButtonVariant1Case2: {
    backgroundColor: {
      default: "var(--color-px-leaf-soft)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-leaf-300) 50%, transparent)",
    },
  },
});

const viewStyles = stylex.create({
  channelMenuDiv: {
    position: "relative",
    minWidth: "0",
  },
  channelMenu: {
    display: "flex",
    maxWidth: "100%",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    paddingInline: "var(--spacing)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-200)",
      },
    },
  },
  channelMenuSpan: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "13px",
  },
  channelMenuSpan2: {
    fontSize: "12px",
    color: "var(--color-berry)",
  },
  channelMenuDiv2: {
    display: "flex",
    maxHeight: "calc(var(--spacing) * 72)",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
    overflowY: "auto",
  },
  channelMenuP: {
    paddingInline: "calc(var(--spacing) * 2)",
    paddingTop: "calc(var(--spacing) * 1.5)",
    fontSize: "12px",
    color: "var(--color-bark-500)",
  },
  channelMenuDiv3: {
    marginTop: "calc(var(--spacing) * 1.5)",
    display: "flex",
    flexWrap: "wrap",
    columnGap: "calc(var(--spacing) * 3)",
    rowGap: "var(--spacing)",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-cream-200)",
    paddingTop: "calc(var(--spacing) * 1.5)",
    fontSize: "12px",
    color: "var(--color-leaf-700)",
  },
  newChannel: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "var(--spacing)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  channelItemSpan: {
    minWidth: "0",
    flex: "1",
  },
  channelItemSpan2: {
    display: "block",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "13px",
  },
  channelItemSpan3: {
    display: "block",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "12px",
    color: "var(--color-bark-500)",
  },
  channelItemSpan4: {
    backgroundColor: "var(--color-berry)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    fontSize: "12px",
    color: "var(--color-cream-50)",
  },
  formButtonsDiv: {
    marginTop: "calc(var(--spacing) * 2)",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "calc(var(--spacing) * 2)",
  },
  formBack: {
    cursor: "pointer",
    fontSize: "12px",
    color: "var(--color-leaf-700)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  newChannelDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
  },
  newChannelP: {
    fontSize: "13px",
  },
  newChannelP2: {
    fontSize: "12px",
    color: "var(--color-bark-500)",
  },
});

type Mode = "list" | "create" | "settings";

export function ChannelMenu(props: { current: Channel | undefined }) {
  const core = useCore();
  const router = useRouter();
  const chat = () => core()?.chat;
  const [open, setOpen] = createSignal(false);
  const [mode, setMode] = createSignal<Mode>("list");
  const box = useClickAway(open, () => setOpen(false));
  const channels = () => topsOf(chat());
  const directs = () => directsOf(chat());
  const elsewhere = () => [...channels(), ...directs()].filter((c) => c.id !== props.current?.id).reduce((n, c) => n + unreadUnder(chat(), c), 0);
  const close = () => setOpen(false);
  return (
    <div ref={box} {...stylex.attrs(viewStyles.channelMenuDiv)}>
      <button
        type="button"
        data-testid="channel-menu"
        data-key={props.current?.id}
        aria-label={t("web.farm.chat.channel", { channel: farmChannelLabel(props.current) })}
        aria-expanded={aria(open())}
        onClick={() => {
          if (!open()) playSound("open");
          setOpen(!open());
          setMode("list");
        }}
        {...stylex.attrs(viewStyles.channelMenu)}
      >
        <span {...stylex.attrs(viewStyles.channelMenuSpan)}>{farmChannelLabel(props.current)}</span>
        <Show when={elsewhere() > 0}>
          <span {...stylex.attrs(viewStyles.channelMenuSpan2)}>{elsewhere()}</span>
        </Show>
        <SpriteIcon name="button-next" size={10} class="rotate-90" />
      </button>
      <Show when={open()}>
        <div {...stylex.attrs(recipeStyles.channelMenuDiv)} role="dialog" aria-label={t("web.farm.chat.channels")} data-testid="channels">
          <Switch>
            <Match when={mode() === "list"}>
              <div {...stylex.attrs(viewStyles.channelMenuDiv2)}>
                <For each={channels()}>{(c) => <ChannelItem channel={c} current={props.current} onPick={close} />}</For>
                <Show when={directs().length > 0}>
                  <p {...stylex.attrs(viewStyles.channelMenuP)}>{t("web.farm.chat.directs")}</p>
                  <For each={directs()}>{(c) => <ChannelItem channel={c} current={props.current} onPick={close} />}</For>
                </Show>
              </div>
              <div {...stylex.attrs(viewStyles.channelMenuDiv3)}>
                <button type="button" data-testid="new-channel" onClick={() => setMode("create")} {...stylex.attrs(viewStyles.newChannel)}>
                  <SpriteIcon name="button-add" size={12} />
                  {t("web.farm.chat.newChannel")}
                </button>
                <button
                  type="button"
                  data-testid="channel-page"
                  onClick={() => router.navigate(chatPath(props.current))}
                  {...stylex.attrs(viewStyles.newChannel)}
                >
                  <SpriteIcon name="button-open" size={12} />
                  {t("web.farm.chat.pageAndSchedules")}
                </button>
                <Show when={props.current?.type === "channel"}>
                  <button type="button" data-testid="channel-settings" onClick={() => setMode("settings")} {...stylex.attrs(viewStyles.newChannel)}>
                    <SpriteIcon name="button-settings" size={12} />
                    {t("web.farm.chat.settingsLink")}
                  </button>
                </Show>
              </div>
            </Match>
            <Match when={mode() === "create"}>
              <NewChannel onDone={close} onBack={() => setMode("list")} />
            </Match>
            <Match when={mode() === "settings" ? props.current : undefined}>
              {(c) => <ChannelSettings channel={c()} onDone={close} onBack={() => setMode("list")} />}
            </Match>
          </Switch>
        </div>
      </Show>
    </div>
  );
}

function ChannelItem(props: { channel: Channel; current: Channel | undefined; onPick: () => void }) {
  const core = useCore();
  const c = () => props.channel;
  const unread = () => unreadUnder(core()?.chat, c());
  const line = () => [c().description, c().repo ? t("web.farm.chat.repoTag", { repo: c().repo! }) : undefined].filter(Boolean).join(" · ");
  const here = () => c().id === props.current?.id;
  return (
    <button
      type="button"
      data-key={c().id}
      aria-current={here() ? "true" : undefined}
      onClick={() => {
        props.onPick();
        farm.showChat(c().default ? undefined : c().id);
      }}
      {...stylex.attrs(recipeStyles.channelItemButton, here() ? recipeStyles.channelItemButtonVariant1Case2 : recipeStyles.channelItemButtonVariant1Case1)}
    >
      <span {...stylex.attrs(viewStyles.channelItemSpan)}>
        <span {...stylex.attrs(viewStyles.channelItemSpan2)}>{farmChannelLabel(c())}</span>
        <Show when={line()}>
          <span {...stylex.attrs(viewStyles.channelItemSpan3)}>{line()}</span>
        </Show>
      </span>
      <Show when={unread() > 0}>
        <span {...stylex.attrs(viewStyles.channelItemSpan4)}>{unread()}</span>
      </Show>
    </button>
  );
}

function FormButtons(props: { onBack: () => void; submit: string; onSubmit?: (() => void) | undefined }) {
  return (
    <div {...stylex.attrs(viewStyles.formButtonsDiv)}>
      <button type="button" data-testid="form-back" onClick={() => props.onBack()} {...stylex.attrs(viewStyles.formBack)}>
        {t("web.farm.chat.back2")}
      </button>
      <PxButton tone="primary" size="sm" data-testid="form-submit" disabled={!props.onSubmit} onClick={props.onSubmit && (() => props.onSubmit?.())}>
        {props.submit}
      </PxButton>
    </div>
  );
}

function NewChannel(props: { onDone: () => void; onBack: () => void }) {
  const repos = useRepos();
  const names = () => ready(repos, []).map((p) => p.name);
  const form = createChannelForm();
  const submit = async () => {
    const made = await form.save();
    if (made === undefined) return;
    playSound("open");
    farm.showChat(made);
    props.onDone();
  };
  return (
    <div {...stylex.attrs(viewStyles.newChannelDiv)}>
      <p {...stylex.attrs(viewStyles.newChannelP)}>{t("web.farm.chat.newChannel")}</p>
      <p {...stylex.attrs(viewStyles.newChannelP2)}>{t("web.farm.chat.newChannelLine")}</p>
      <PxTextInput
        testid="channel-name"
        value={form.name()}
        onChange={form.setName}
        placeholder={t("web.farm.chat.nameHint")}
        label={t("web.farm.chat.name")}
        autoFocus
      />
      <PxTextInput
        value={form.description()}
        onChange={form.setDescription}
        placeholder={t("web.farm.chat.descriptionHint")}
        label={t("web.farm.chat.description")}
      />
      <PxTextInput
        value={form.repo()}
        onChange={form.setRepo}
        placeholder={t("web.farm.chat.repoHint")}
        label={t("web.farm.chat.repo")}
        suggestions={names()}
      />
      <Show when={form.error()}>
        <p {...stylex.attrs(viewStyles.channelMenuSpan2)}>{form.error()}</p>
      </Show>
      <FormButtons onBack={() => props.onBack()} submit={t("web.farm.chat.open")} onSubmit={form.ready() ? () => void submit() : undefined} />
    </div>
  );
}

function ChannelSettings(props: { channel: Channel; onDone: () => void; onBack: () => void }) {
  const repos = useRepos();
  const names = () => ready(repos, []).map((p) => p.name);
  // It starts from the channel as it is when opened.
  const form = createChannelForm(untrack(() => props.channel));
  const submit = async () => {
    if ((await form.save()) !== undefined) props.onDone();
  };
  return (
    <div {...stylex.attrs(viewStyles.newChannelDiv)}>
      <p {...stylex.attrs(viewStyles.newChannelP)}>{t("web.farm.chat.settingsOf", { channel: farmChannelLabel(props.channel) })}</p>
      <PxTextInput value={form.description()} onChange={form.setDescription} placeholder={t("web.farm.chat.what")} label={t("web.farm.chat.description")} />
      <PxTextInput
        value={form.repo()}
        onChange={form.setRepo}
        placeholder={t("web.farm.chat.repoNone")}
        label={t("web.farm.chat.repo")}
        suggestions={names()}
      />
      <Show when={form.error()}>
        <p {...stylex.attrs(viewStyles.channelMenuSpan2)}>{form.error()}</p>
      </Show>
      <FormButtons onBack={() => props.onBack()} submit={t("web.farm.chat.save")} onSubmit={form.ready() ? () => void submit() : undefined} />
    </div>
  );
}
