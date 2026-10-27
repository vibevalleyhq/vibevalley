// A channel has no members to pick: helpers are in the channel their job was arranged in.

import { chatWording } from "./words";
import { For, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Conversation } from "@vibevalley/protocol";
import { createChannelForm } from "./channelForm";
import { channelName } from "./rules";
import { autofocus } from "../../base/util";
import { ready, useProjects } from "../../base/query";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Field, TextArea, TextInput } from "../../ui/Field";

function ProjectInput(props: { value: string; onChange: (v: string) => void }) {
  const projects = useProjects();
  return (
    <>
      <TextInput
        value={props.value}
        onInput={(e) => props.onChange(e.currentTarget.value)}
        placeholder={chatWording().dialog.projectExample}
        list="chat-projects"
      />
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
        <Button onClick={() => props.onCancel()}>{chatWording().dialog.cancel}</Button>
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
    <Dialog open={props.open} onClose={() => props.onClose()} title={chatWording().newChannel}>
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
    <Form submit={chatWording().newChannel} onSubmit={submit} onCancel={() => props.onClose()} busy={form.busy()} error={form.error()} ready={form.ready()}>
      <Field label={chatWording().dialog.name} hint={chatWording().dialog.nameHint}>
        <TextInput
          ref={autofocus()}
          required
          value={form.name()}
          placeholder={chatWording().dialog.nameExample}
          onInput={(e) => form.setName(e.currentTarget.value)}
        />
      </Field>
      <Field label={chatWording().dialog.description}>
        <TextArea
          rows={3}
          value={form.description()}
          onInput={(e) => form.setDescription(e.currentTarget.value)}
          placeholder={chatWording().dialog.descriptionHint}
        />
      </Field>
      <Field label={chatWording().dialog.project} hint={chatWording().dialog.projectHint}>
        <ProjectInput value={form.project()} onChange={form.setProject} />
      </Field>
    </Form>
  );
}

export function ChannelSettingsDialog(props: { channel: Conversation; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={props.open} onClose={() => props.onClose()} title={chatWording().dialog.settingsOf(channelName(props.channel))}>
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
    <Form submit={chatWording().dialog.save} onSubmit={submit} onCancel={() => props.onClose()} busy={form.busy()} error={form.error()}>
      <Field label={chatWording().dialog.description}>
        <TextArea
          rows={3}
          value={form.description()}
          onInput={(e) => form.setDescription(e.currentTarget.value)}
          placeholder={chatWording().dialog.descriptionHint}
        />
      </Field>
      <Field label={chatWording().dialog.project} hint={chatWording().dialog.projectNone}>
        <ProjectInput value={form.project()} onChange={form.setProject} />
      </Field>
    </Form>
  );
}
