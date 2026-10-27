// The channel switcher in the farm chat window's head: the channels with what they are for and their unread lines, a
// new channel, the current one's settings, and the way to its full page (its recurrences are there).

import { farmWording } from "../words";
import { createSignal, For, Match, Show, Switch, untrack } from "solid-js";
import type { Conversation } from "@vibevalley/protocol";
import { createChannelForm, channelLabel, channelsOf, chatPath, unreadUnder } from "../../features/channel";
import { playSound } from "../../ui/pixel/sound";
import { farm } from "../store";
import { aria, useClickAway } from "../../base/util";
import { useRouter } from "../../base/router";
import { useCore } from "../../base/frame";
import { ready, useProjects } from "../../base/query";
import { PxButton, PxTextInput, SpriteIcon } from "../../ui/pixel";

type Mode = "list" | "create" | "settings";

export function ChannelMenu(props: { current: Conversation | undefined }) {
  const core = useCore();
  const router = useRouter();
  const chat = () => core()?.chat;
  const [open, setOpen] = createSignal(false);
  const [mode, setMode] = createSignal<Mode>("list");
  const box = useClickAway(open, () => setOpen(false));
  const channels = () => channelsOf(chat());
  const elsewhere = () =>
    channels()
      .filter((c) => c.id !== props.current?.id)
      .reduce((n, c) => n + unreadUnder(chat(), c), 0);
  const close = () => setOpen(false);
  return (
    <div ref={box} class="relative min-w-0">
      <button
        type="button"
        aria-label={farmWording().chat.channel(channelLabel(props.current))}
        aria-expanded={aria(open())}
        onClick={() => {
          if (!open()) playSound("open");
          setOpen(!open());
          setMode("list");
        }}
        class="flex max-w-full cursor-pointer items-center gap-1.5 px-1 hover:bg-cream-200"
      >
        <span class="truncate text-[13px]">{channelLabel(props.current)}</span>
        <Show when={elsewhere() > 0}>
          <span class="text-[12px] text-berry">{elsewhere()}</span>
        </Show>
        <SpriteIcon name="button-next" size={10} class="rotate-90" />
      </button>
      <Show when={open()}>
        <div class="absolute top-full left-0 z-20 mt-1.5 w-72 bg-cream-50 p-2 shadow-px" role="dialog" aria-label={farmWording().chat.channels}>
          <Switch>
            <Match when={mode() === "list"}>
              <div class="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
                <For each={channels()}>
                  {(c) => {
                    const unread = () => unreadUnder(chat(), c);
                    const line = () => [c.description, c.project ? farmWording().chat.projectTag(c.project) : undefined].filter(Boolean).join(" · ");
                    return (
                      <button
                        type="button"
                        aria-current={c.id === props.current?.id ? "true" : undefined}
                        onClick={() => {
                          close();
                          farm.showChat(c.kind === "general" ? null : c.id);
                        }}
                        class={[
                          "flex cursor-pointer items-start gap-2 px-2 py-1.5 text-left",
                          c.id === props.current?.id ? "bg-leaf-300/50" : "hover:bg-cream-200",
                        ]}
                      >
                        <span class="min-w-0 flex-1">
                          <span class="block truncate text-[13px]">{channelLabel(c)}</span>
                          <Show when={line()}>
                            <span class="block truncate text-[12px] text-bark-500">{line()}</span>
                          </Show>
                        </span>
                        <Show when={unread() > 0}>
                          <span class="bg-berry px-1.5 text-[12px] text-cream-50">{unread()}</span>
                        </Show>
                      </button>
                    );
                  }}
                </For>
              </div>
              <div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 border-t border-cream-200 pt-1.5 text-[12px] text-leaf-700">
                <button type="button" onClick={() => setMode("create")} class="flex cursor-pointer items-center gap-1 hover:underline">
                  <SpriteIcon name="button-add" size={12} />
                  {farmWording().chat.newChannel}
                </button>
                <button type="button" onClick={() => router.navigate(chatPath(props.current))} class="flex cursor-pointer items-center gap-1 hover:underline">
                  <SpriteIcon name="button-open" size={12} />
                  {farmWording().chat.pageAndSchedules}
                </button>
                <Show when={props.current?.kind === "channel"}>
                  <button type="button" onClick={() => setMode("settings")} class="flex cursor-pointer items-center gap-1 hover:underline">
                    <SpriteIcon name="button-settings" size={12} />
                    {farmWording().chat.settingsLink}
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

function FormButtons(props: { onBack: () => void; submit: string; onSubmit?: () => void }) {
  return (
    <div class="mt-2 flex items-center justify-end gap-2">
      <button type="button" onClick={() => props.onBack()} class="cursor-pointer text-[12px] text-leaf-700 hover:underline">
        {farmWording().chat.back2}
      </button>
      <PxButton tone="primary" size="sm" disabled={!props.onSubmit} onClick={props.onSubmit && (() => props.onSubmit?.())}>
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
      <p class="text-[13px]">{farmWording().chat.newChannel}</p>
      <p class="text-[12px] text-bark-500">{farmWording().chat.newChannelLine}</p>
      <PxTextInput value={form.name()} onChange={form.setName} placeholder={farmWording().chat.nameHint} label={farmWording().chat.name} autoFocus />
      <PxTextInput
        value={form.description()}
        onChange={form.setDescription}
        placeholder={farmWording().chat.descriptionHint}
        label={farmWording().chat.description}
      />
      <PxTextInput
        value={form.project()}
        onChange={form.setProject}
        placeholder={farmWording().chat.projectHint}
        label={farmWording().chat.project}
        suggestions={names()}
      />
      <Show when={form.error()}>
        <p class="text-[12px] text-berry">{form.error()}</p>
      </Show>
      <FormButtons onBack={() => props.onBack()} submit={farmWording().chat.open} onSubmit={form.ready() ? () => void submit() : undefined} />
    </div>
  );
}

function ChannelSettings(props: { channel: Conversation; onDone: () => void; onBack: () => void }) {
  const projects = useProjects();
  const names = () => ready(projects, []).map((p) => p.name);
  // It starts from the channel as it is when opened.
  const form = createChannelForm(untrack(() => props.channel));
  const submit = async () => {
    if ((await form.save()) !== undefined) props.onDone();
  };
  return (
    <div class="flex flex-col gap-1.5">
      <p class="text-[13px]">{farmWording().chat.settingsOf(channelLabel(props.channel))}</p>
      <PxTextInput value={form.description()} onChange={form.setDescription} placeholder={farmWording().chat.what} label={farmWording().chat.description} />
      <PxTextInput
        value={form.project()}
        onChange={form.setProject}
        placeholder={farmWording().chat.projectNone}
        label={farmWording().chat.project}
        suggestions={names()}
      />
      <Show when={form.error()}>
        <p class="text-[12px] text-berry">{form.error()}</p>
      </Show>
      <FormButtons onBack={() => props.onBack()} submit={farmWording().chat.save} onSubmit={form.ready() ? () => void submit() : undefined} />
    </div>
  );
}
