import { t } from "@vibevalley/i18n";
// A channel has no members to pick: helpers are in the channel their job was arranged in.

import { createSignal, For, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Channel, Notify } from "@vibevalley/protocol";
import { api, reasonOf } from "@/base/api";
import { useCore } from "@/base/frame";
import { Segmented } from "@/ui/Segmented";
import { createChannelForm } from "./channelForm";
import { channelName } from "./places";
import { autofocus } from "@/base/util";
import { ready, useProjects } from "@/base/query";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { Field, Select, TextArea, TextInput } from "@/ui/Field";
import { useOrchestrators } from "@/base/agents";

function ProjectInput(props: { value: string; onChange: (v: string) => void }) {
  const projects = useProjects();
  return (
    <>
      <TextInput
        data-testid="channel-project"
        value={props.value}
        onInput={(e) => props.onChange(e.currentTarget.value)}
        placeholder={t("web.channel.dialog.projectExample")}
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
  error?: string | undefined;
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
      <Show when={props.error}>
        {(error) => (
          <p role="alert" class="text-sm text-berry">
            {error()}
          </p>
        )}
      </Show>
      <div class="flex justify-end gap-3 pt-2">
        <Button data-testid="cancel" onClick={() => props.onCancel()}>
          {t("web.channel.dialog.cancel")}
        </Button>
        <Button type="submit" tone="primary" data-testid="submit" disabled={props.busy || !ok()}>
          {props.submit}
        </Button>
      </div>
    </form>
  );
}

/** onCreated gets the new channel's id. */
export function NewChannelDialog(props: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  return (
    <Dialog open={props.open} onClose={() => props.onClose()} title={t("web.channel.newChannel")} testid="new-channel-dialog">
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
    <Form submit={t("web.channel.newChannel")} onSubmit={submit} onCancel={() => props.onClose()} busy={form.busy()} error={form.error()} ready={form.ready()}>
      <Field label={t("web.channel.dialog.name")} hint={t("web.channel.dialog.nameHint")}>
        <TextInput
          ref={autofocus()}
          data-testid="channel-name"
          required
          value={form.name()}
          placeholder={t("web.channel.dialog.nameExample")}
          onInput={(e) => form.setName(e.currentTarget.value)}
        />
      </Field>
      <Field label={t("web.channel.dialog.description")}>
        <TextArea
          data-testid="channel-description"
          rows={3}
          value={form.description()}
          onInput={(e) => form.setDescription(e.currentTarget.value)}
          placeholder={t("web.channel.dialog.descriptionHint")}
        />
      </Field>
      <Field label={t("web.channel.dialog.project")} hint={t("web.channel.dialog.projectHint")}>
        <ProjectInput value={form.project()} onChange={form.setProject} />
      </Field>
    </Form>
  );
}

export function ChannelSettingsDialog(props: { channel: Channel; open: boolean; onClose: () => void; onGone: () => void }) {
  return (
    <Dialog
      open={props.open}
      onClose={() => props.onClose()}
      title={t("web.channel.dialog.settingsOf", { name: channelName(props.channel) })}
      testid="channel-settings-dialog"
    >
      <ChannelSettingsForm channel={props.channel} onClose={() => props.onClose()} onGone={() => props.onGone()} />
    </Dialog>
  );
}

export const notifyOptions = (): { value: Notify; label: string }[] => [
  { value: "all", label: t("web.channel.manage.notifyAll") },
  { value: "mentions", label: t("web.channel.manage.notifyMentions") },
  { value: "none", label: t("web.channel.manage.notifyNone") },
];

function ChannelSettingsForm(props: { channel: Channel; onClose: () => void; onGone: () => void }) {
  // The dialog mounts the form when it opens: it starts from the channel as it is then.
  const form = createChannelForm(untrack(() => props.channel));
  const core = useCore();
  const orchestrators = useOrchestrators();
  const top = () => props.channel.type === "channel";
  // The groups the farm's channels are in, for the field to offer.
  const categories = () => [...new Set((core()?.chat?.channels ?? []).flatMap((c) => (c.category ? [c.category] : [])))];
  const submit = async () => {
    if ((await form.save()) !== undefined) props.onClose();
  };
  return (
    <div class="flex flex-col gap-5">
      <Form submit={t("web.channel.dialog.save")} onSubmit={submit} onCancel={() => props.onClose()} busy={form.busy()} error={form.error()}>
        <Show when={top()}>
          <Field label={t("web.channel.manage.name")} hint={t("web.channel.dialog.nameHint")}>
            <TextInput data-testid="channel-name" required value={form.name()} onInput={(e) => form.setName(e.currentTarget.value)} />
          </Field>
          <Field label={t("web.channel.dialog.description")}>
            <TextArea
              data-testid="channel-description"
              rows={3}
              value={form.description()}
              onInput={(e) => form.setDescription(e.currentTarget.value)}
              placeholder={t("web.channel.dialog.descriptionHint")}
            />
          </Field>
          <Field label={t("web.channel.dialog.project")} hint={t("web.channel.dialog.projectNone")}>
            <ProjectInput value={form.project()} onChange={form.setProject} />
          </Field>
          <Show when={orchestrators().length > 1}>
            <Field label={t("web.channel.manage.orchestrator")} hint={t("web.channel.manage.orchestratorHint")}>
              <Select
                label={t("web.channel.manage.orchestrator")}
                testid="channel-orchestrator"
                value={form.orchestrator()}
                onChange={(v) => form.setOrchestrator(v)}
                options={orchestrators().map((a) => ({ value: a.id, label: a.name }))}
              />
            </Field>
          </Show>
          <Field label={t("web.channel.manage.category")} hint={t("web.channel.manage.categoryHint")}>
            <TextInput data-testid="channel-category" value={form.category()} onInput={(e) => form.setCategory(e.currentTarget.value)} list="chat-categories" />
            <datalist id="chat-categories">
              <For each={categories()}>{(c) => <option value={c} />}</For>
            </datalist>
          </Field>
        </Show>
        <Field label={t("web.channel.manage.notify")} hint={t("web.channel.manage.notifyHint")}>
          <Segmented label={t("web.channel.manage.notify")} testid="channel-notify" value={form.notify()} options={notifyOptions()} onChange={form.setNotify} />
        </Field>
      </Form>
      <Show when={top() && !props.channel.default}>
        <ChannelDanger channel={props.channel} onDone={() => props.onClose()} onGone={() => props.onGone()} />
      </Show>
    </div>
  );
}

/** Archiving, and deleting once the owner has read what it does: the server's dry run, or why it refuses. */
function ChannelDanger(props: { channel: Channel; onDone: () => void; onGone: () => void }) {
  const [does, setDoes] = createSignal<readonly string[]>();
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const act = async (step: "archive" | "preview" | "delete") => {
    const { id } = untrack(() => props.channel);
    setBusy(true);
    setError(undefined);
    try {
      if (step === "archive") {
        await api.channel.archive.toggle({ id });
        untrack(() => props.onDone)();
      } else if (step === "preview") setDoes((await api.channel.previewDelete({ id })).does);
      else {
        await api.channel.delete({ id });
        untrack(() => props.onGone)();
      }
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="flex flex-col gap-2 border-t border-line pt-4">
      <div class="flex flex-wrap items-center gap-2">
        <Button data-testid="channel-archive" disabled={busy()} onClick={() => void act("archive")} title={t("web.channel.manage.archiveHint")}>
          {props.channel.archived !== undefined ? t("web.channel.manage.unarchive") : t("web.channel.manage.archive")}
        </Button>
        <Show
          when={does()}
          fallback={
            <Button tone="danger" data-testid="channel-remove" disabled={busy()} onClick={() => void act("preview")}>
              {t("web.channel.manage.remove")}
            </Button>
          }
        >
          <Button tone="danger" data-testid="channel-remove-sure" disabled={busy()} onClick={() => void act("delete")}>
            {t("web.channel.manage.removeSure")}
          </Button>
        </Show>
      </div>
      <Show when={does()}>
        {(lines) => (
          <div class="text-sm">
            <p class="text-muted">{t("web.channel.manage.removeWill")}</p>
            <ul class="list-disc pl-5">
              <For each={lines()}>{(line) => <li>{line}</li>}</For>
            </ul>
          </div>
        )}
      </Show>
      <Show when={error()}>{(e) => <p class="text-sm text-berry">{e()}</p>}</Show>
    </div>
  );
}
