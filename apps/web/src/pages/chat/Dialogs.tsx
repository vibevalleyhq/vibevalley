// A channel has no members to pick: helpers are in the channel their job was arranged in.

import { createSignal, For, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Conversation } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
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
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [project, setProject] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const submit = async () => {
    setBusy(true);
    try {
      const id = await api.channel.create({ body: { name: name(), description: description().trim() || undefined, project: project().trim() || undefined } });
      props.onCreated(id);
      props.onClose();
    } catch (e) {
      setError(reasonOf(e));
      setBusy(false);
    }
  };
  return (
    <Form submit="创建频道" onSubmit={submit} onCancel={() => props.onClose()} busy={busy()} error={error()} ready={name().trim() !== ""}>
      <Field label="名称" hint="字母、数字、汉字、- 和 _，不超过 24 个字">
        <TextInput
          ref={autofocus()}
          required
          value={name()}
          placeholder="例如 clock-in"
          onInput={(e) => {
            setName(e.currentTarget.value);
            setError(undefined);
          }}
        />
      </Field>
      <Field label="描述（可不填）">
        <TextArea rows={3} value={description()} onInput={(e) => setDescription(e.currentTarget.value)} placeholder="这个频道是做什么的？" />
      </Field>
      <Field label="默认项目（可不填）" hint="在这个频道里派活、没说项目时，就在这个项目里干">
        <ProjectInput value={project()} onChange={setProject} />
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
  // The form starts from the channel as it is when opened (the dialog mounts it then), and edits its own copy.
  const [description, setDescription] = createSignal(untrack(() => props.channel.description ?? ""));
  const [project, setProject] = createSignal(untrack(() => props.channel.project ?? ""));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const submit = async () => {
    setBusy(true);
    try {
      await api.channel.update({ id: props.channel.id, body: { description: description(), project: project() } });
      props.onClose();
    } catch (e) {
      setError(reasonOf(e));
      setBusy(false);
    }
  };
  return (
    <Form submit="保存" onSubmit={submit} onCancel={() => props.onClose()} busy={busy()} error={error()}>
      <Field label="描述（可不填）">
        <TextArea rows={3} value={description()} onInput={(e) => setDescription(e.currentTarget.value)} placeholder="这个频道是做什么的？" />
      </Field>
      <Field label="默认项目（可不填）" hint="空着就没有：派活时管家要问在哪个项目">
        <ProjectInput value={project()} onChange={setProject} />
      </Field>
    </Form>
  );
}
