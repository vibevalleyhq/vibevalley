// A channel has no members to pick: helpers are in the channel their job was arranged in.

import { For, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Conversation } from "@vibevalley/protocol";
import { createChannelForm } from "../../data/channelForm";
import { channelName } from "../../rules/chat";
import { autofocus } from "../../app/util";
import { ready, useProjects } from "../../data/query";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Field, TextArea, TextInput } from "../../ui/Field";

function ProjectInput(props: { value: string; onChange: (v: string) => void }) {
  const projects = useProjects();
  return (
    <>
      <TextInput value={props.value} onInput={(e) => props.onChange(e.currentTarget.value)} placeholder="比如 clock-in" list="chat-projects" />
      <datalist id="chat-projects">
        <For each={ready(projects, [])}>{(p) => <option value={p.name} />}</For>
      </datalist>
    </>
  );
}

function Form(props: {
  submit: string;
  onSubmit: () => Promise<void>;
  onCancel: () => void;
  busy: boolean;
  error?: string;
  ready?: boolean;
  children: JSX.Element;
}) {
  const ok = () => props.ready ?? true;
  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok() && !props.busy) void props.onSubmit();
      }}
    >
      {props.children}
      <Show when={props.error}>{(error) => <p class="text-sm text-berry">{error()}</p>}</Show>
      <div class="flex justify-end gap-3 pt-2">
        <Button onClick={() => props.onCancel()}>取消</Button>
        <Button type="submit" tone="primary" disabled={props.busy || !ok()}>
          {props.submit}
        </Button>
      </div>
    </form>
  );
}

/** onCreated gets the new channel's id. */
export function NewChannelDialog(props: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  return (
    <Dialog open={props.open} onClose={() => props.onClose()} title="创建频道">
      <NewChannelForm onClose={() => props.onClose()} onCreated={(id) => props.onCreated(id)} />
    </Dialog>
  );
}

function NewChannelForm(props: { onClose: () => void; onCreated: (id: string) => void }) {
  const form = createChannelForm();
  const submit = async () => {
    const id = await form.save();
    if (id === undefined) return;
    props.onCreated(id);
    props.onClose();
  };
  return (
    <Form submit="创建频道" onSubmit={submit} onCancel={() => props.onClose()} busy={form.busy()} error={form.error()} ready={form.ready()}>
      <Field label="名称" hint="字母、数字、汉字、- 和 _，不超过 24 个字">
        <TextInput ref={autofocus()} required value={form.name()} placeholder="例如 clock-in" onInput={(e) => form.setName(e.currentTarget.value)} />
      </Field>
      <Field label="描述（可不填）">
        <TextArea rows={3} value={form.description()} onInput={(e) => form.setDescription(e.currentTarget.value)} placeholder="这个频道是做什么的？" />
      </Field>
      <Field label="默认项目（可不填）" hint="在这个频道里派活、没说项目时，就在这个项目里干">
        <ProjectInput value={form.project()} onChange={form.setProject} />
      </Field>
    </Form>
  );
}

export function ChannelSettingsDialog(props: { channel: Conversation; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={props.open} onClose={() => props.onClose()} title={`# ${channelName(props.channel)} 的设置`}>
      <ChannelSettingsForm channel={props.channel} onClose={() => props.onClose()} />
    </Dialog>
  );
}

function ChannelSettingsForm(props: { channel: Conversation; onClose: () => void }) {
  // The dialog mounts the form when it opens: it starts from the channel as it is then.
  const form = createChannelForm(untrack(() => props.channel));
  const submit = async () => {
    if ((await form.save()) !== undefined) props.onClose();
  };
  return (
    <Form submit="保存" onSubmit={submit} onCancel={() => props.onClose()} busy={form.busy()} error={form.error()}>
      <Field label="描述（可不填）">
        <TextArea rows={3} value={form.description()} onInput={(e) => form.setDescription(e.currentTarget.value)} placeholder="这个频道是做什么的？" />
      </Field>
      <Field label="默认项目（可不填）" hint="空着就没有：派活时管家要问在哪个项目">
        <ProjectInput value={form.project()} onChange={form.setProject} />
      </Field>
    </Form>
  );
}
