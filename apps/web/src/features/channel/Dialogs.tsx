import type { JSX } from "@solidjs/web";
import { createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Channel, defaultOrchestrator, type Notify } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { autofocus } from "#/base/dom.tsx";
import { useOrchestrators } from "#/infra/agents.ts";
import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { ready, useProjects } from "#/infra/query.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Dialog } from "#/ui/Dialog.tsx";
import { Field, Select, TextArea, TextInput } from "#/ui/Field.tsx";
import { Segmented } from "#/ui/Segmented.tsx";

import { channelName } from "./places";

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

// Making a channel or changing one, as both chat windows carry it out: the workbench's dialogs (here) and the farm's menu (farm/chat/ChannelMenu.tsx).
/** The form for a new channel, or for the one given as it is when opened (the form edits its own copy). */
export function createChannelForm(channel?: Channel) {
  const was = untrack(() => ({
    name: channel?.name ?? "",
    description: channel?.description ?? "",
    project: channel?.project ?? "",
    category: channel?.category ?? "",
    notify: channel?.notify ?? "all",
    orchestrator: channel?.orchestrator ?? defaultOrchestrator,
  }));
  const [name, setName] = createSignal(was.name);
  const [description, setDescription] = createSignal(was.description);
  const [project, setProject] = createSignal(was.project);
  const [category, setCategory] = createSignal(was.category);
  const [notify, setNotify] = createSignal<Notify>(was.notify);
  const [orchestrator, setOrchestrator] = createSignal(was.orchestrator);
  const [error, setError] = createSignal<string>();
  // A refusal is said in the form, beside what it refuses, rather than in a toast.
  const act = createAct(setError);
  const busy = act.busy;

  /** The channel's id once it went through; undefined, with the reason in error, when refused. */
  const save = (): Promise<string | undefined> => {
    setError(undefined);
    // Read as the owner saves: the form may change while the call waits.
    const now = {
      name: name().trim(),
      description: description(),
      project: project(),
      category: category().trim(),
      notify: notify(),
      orchestrator: orchestrator(),
    };
    return act.run(async () => {
      if (!channel)
        return api.channel.create(
          omitUndefined({ name: now.name, description: now.description.trim() || undefined, project: now.project.trim() || undefined }),
        );
      // A direct channel has only its notifications to change.
      if (channel.type === "channel")
        await api.channel.update({
          id: channel.id,
          description: now.description,
          project: now.project,
          category: now.category,
          ...(now.name !== was.name ? { name: now.name } : {}),
          ...(now.orchestrator !== was.orchestrator ? { orchestrator: now.orchestrator } : {}),
        });
      if (now.notify !== was.notify) await api.channel.notify.set({ id: channel.id, notify: now.notify });
      return channel.id;
    });
  };

  return {
    name,
    setName: (v: string) => {
      setName(v);
      setError(undefined);
    },
    description,
    setDescription,
    project,
    setProject,
    category,
    setCategory,
    notify,
    setNotify,
    /** The orchestrator that looks after the channel, by its profile id. */
    orchestrator,
    setOrchestrator,
    busy,
    error,
    /** Pressing save now would be sent: not busy, and a new channel has a name. */
    ready: () => !busy() && (channel !== undefined || name().trim() !== ""),
    save,
  };
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
  // The refusal is said under the buttons, where the owner pressed.
  const steps = createAct(setError);
  const busy = steps.busy;
  const act = (step: "archive" | "preview" | "delete") => {
    const { id, archived } = untrack(() => props.channel);
    setError(undefined);
    return steps.run(async () => {
      if (step === "archive") {
        await api.channel.archive.set({ id, on: archived === undefined });
        untrack(() => props.onDone)();
      } else if (step === "preview") setDoes((await api.channel.previewDelete({ id })).does);
      else {
        await api.channel.delete({ id });
        untrack(() => props.onGone)();
      }
    });
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
