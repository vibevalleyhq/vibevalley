import { t } from "@vibevalley/i18n";
// The channel switcher in the farm chat window's head: the channels with what they are for and their unread lines, the
// owner's direct channels, a new channel, the current one's settings, and the way to its full page (its recurrences are there).

import { farmChannelLabel } from "./text";

import { createSignal, For, Match, Show, Switch, untrack } from "solid-js";
import type { Channel } from "@vibevalley/protocol";
import { createChannelForm, directsOf, topsOf, chatPath, unreadUnder } from "../../features/channel";
import { playSound } from "../../ui/pixel/sound";
import { farm } from "../store";
import { aria, useClickAway } from "../../base/util";
import { useRouter } from "../../base/router";
import { useCore } from "../../base/frame";
import { ready, useProjects } from "../../base/query";
import { PxButton, PxTextInput, SpriteIcon } from "../../ui/pixel";

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
    <div ref={box} class="relative min-w-0">
      <button
        type="button"
        data-testid="channel-menu"
        aria-label={t("web.farm.chat.channel", { channel: farmChannelLabel(props.current) })}
        aria-expanded={aria(open())}
        onClick={() => {
          if (!open()) playSound("open");
          setOpen(!open());
          setMode("list");
        }}
        class="flex max-w-full cursor-pointer items-center gap-1.5 px-1 hover:bg-cream-200"
      >
        <span class="truncate text-[13px]">{farmChannelLabel(props.current)}</span>
        <Show when={elsewhere() > 0}>
          <span class="text-[12px] text-berry">{elsewhere()}</span>
        </Show>
        <SpriteIcon name="button-next" size={10} class="rotate-90" />
      </button>
      <Show when={open()}>
        <div
          class="absolute top-full left-0 z-20 mt-1.5 w-72 bg-cream-50 p-2 shadow-px"
          role="dialog"
          aria-label={t("web.farm.chat.channels")}
          data-testid="channels"
        >
          <Switch>
            <Match when={mode() === "list"}>
              <div class="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
                <For each={channels()}>{(c) => <ChannelItem channel={c} current={props.current} onPick={close} />}</For>
                <Show when={directs().length > 0}>
                  <p class="px-2 pt-1.5 text-[12px] text-bark-500">{t("web.farm.chat.directs")}</p>
                  <For each={directs()}>{(c) => <ChannelItem channel={c} current={props.current} onPick={close} />}</For>
                </Show>
              </div>
              <div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 border-t border-cream-200 pt-1.5 text-[12px] text-leaf-700">
                <button
                  type="button"
                  data-testid="new-channel"
                  onClick={() => setMode("create")}
                  class="flex cursor-pointer items-center gap-1 hover:underline"
                >
                  <SpriteIcon name="button-add" size={12} />
                  {t("web.farm.chat.newChannel")}
                </button>
                <button
                  type="button"
                  data-testid="channel-page"
                  onClick={() => router.navigate(chatPath(props.current))}
                  class="flex cursor-pointer items-center gap-1 hover:underline"
                >
                  <SpriteIcon name="button-open" size={12} />
                  {t("web.farm.chat.pageAndSchedules")}
                </button>
                <Show when={props.current?.type === "channel"}>
                  <button
                    type="button"
                    data-testid="channel-settings"
                    onClick={() => setMode("settings")}
                    class="flex cursor-pointer items-center gap-1 hover:underline"
                  >
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
  const line = () => [c().description, c().project ? t("web.farm.chat.projectTag", { project: c().project! }) : undefined].filter(Boolean).join(" · ");
  const here = () => c().id === props.current?.id;
  return (
    <button
      type="button"
      data-key={c().id}
      aria-current={here() ? "true" : undefined}
      onClick={() => {
        props.onPick();
        farm.showChat(c().default ? null : c().id);
      }}
      class={["flex cursor-pointer items-start gap-2 px-2 py-1.5 text-left", here() ? "bg-leaf-300/50" : "hover:bg-cream-200"]}
    >
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[13px]">{farmChannelLabel(c())}</span>
        <Show when={line()}>
          <span class="block truncate text-[12px] text-bark-500">{line()}</span>
        </Show>
      </span>
      <Show when={unread() > 0}>
        <span class="bg-berry px-1.5 text-[12px] text-cream-50">{unread()}</span>
      </Show>
    </button>
  );
}

function FormButtons(props: { onBack: () => void; submit: string; onSubmit?: () => void }) {
  return (
    <div class="mt-2 flex items-center justify-end gap-2">
      <button type="button" data-testid="form-back" onClick={() => props.onBack()} class="cursor-pointer text-[12px] text-leaf-700 hover:underline">
        {t("web.farm.chat.back2")}
      </button>
      <PxButton tone="primary" size="sm" data-testid="form-submit" disabled={!props.onSubmit} onClick={props.onSubmit && (() => props.onSubmit?.())}>
        {props.submit}
      </PxButton>
    </div>
  );
}

function NewChannel(props: { onDone: () => void; onBack: () => void }) {
  const projects = useProjects();
  const names = () => ready(projects, []).map((p) => p.name);
  const form = createChannelForm();
  const submit = async () => {
    const made = await form.save();
    if (made === undefined) return;
    playSound("open");
    farm.showChat(made);
    props.onDone();
  };
  return (
    <div class="flex flex-col gap-1.5">
      <p class="text-[13px]">{t("web.farm.chat.newChannel")}</p>
      <p class="text-[12px] text-bark-500">{t("web.farm.chat.newChannelLine")}</p>
      <PxTextInput value={form.name()} onChange={form.setName} placeholder={t("web.farm.chat.nameHint")} label={t("web.farm.chat.name")} autoFocus />
      <PxTextInput
        value={form.description()}
        onChange={form.setDescription}
        placeholder={t("web.farm.chat.descriptionHint")}
        label={t("web.farm.chat.description")}
      />
      <PxTextInput
        value={form.project()}
        onChange={form.setProject}
        placeholder={t("web.farm.chat.projectHint")}
        label={t("web.farm.chat.project")}
        suggestions={names()}
      />
      <Show when={form.error()}>
        <p class="text-[12px] text-berry">{form.error()}</p>
      </Show>
      <FormButtons onBack={() => props.onBack()} submit={t("web.farm.chat.open")} onSubmit={form.ready() ? () => void submit() : undefined} />
    </div>
  );
}

function ChannelSettings(props: { channel: Channel; onDone: () => void; onBack: () => void }) {
  const projects = useProjects();
  const names = () => ready(projects, []).map((p) => p.name);
  // It starts from the channel as it is when opened.
  const form = createChannelForm(untrack(() => props.channel));
  const submit = async () => {
    if ((await form.save()) !== undefined) props.onDone();
  };
  return (
    <div class="flex flex-col gap-1.5">
      <p class="text-[13px]">{t("web.farm.chat.settingsOf", { channel: farmChannelLabel(props.channel) })}</p>
      <PxTextInput value={form.description()} onChange={form.setDescription} placeholder={t("web.farm.chat.what")} label={t("web.farm.chat.description")} />
      <PxTextInput
        value={form.project()}
        onChange={form.setProject}
        placeholder={t("web.farm.chat.projectNone")}
        label={t("web.farm.chat.project")}
        suggestions={names()}
      />
      <Show when={form.error()}>
        <p class="text-[12px] text-berry">{form.error()}</p>
      </Show>
      <FormButtons onBack={() => props.onBack()} submit={t("web.farm.chat.save")} onSubmit={form.ready() ? () => void submit() : undefined} />
    </div>
  );
}
