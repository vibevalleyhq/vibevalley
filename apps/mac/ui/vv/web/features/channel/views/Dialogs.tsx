// Ported from VibeValley apps/web/src/features/channel/views/Dialogs.tsx:
// the same channel form (createChannelForm), new channel and channel
// settings dialogs. A repo or a category is typed with the known ones
// offered as chips under the field (a datalist there); Return in the name
// field submits as the form's submit did.
import { signal, Text, untracked, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import { type Channel, type Notify } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { useOrchestrators } from "../../../infra/agents";
import { api } from "../../../infra/api";
import { useCore } from "../../../infra/frame";
import { ready, useRepos } from "../../../infra/query";
import { createAct } from "../../../ui/act";
import { Button } from "../../../ui/Button";
import { Checkbox } from "../../../ui/Checkbox";
import { Dialog } from "../../../ui/Dialog";
import { Field, TextArea, TextInput } from "../../../ui/Field";
import { Segmented } from "../../../ui/Segmented";
import { channelName } from "../model/places";

/** A text field with the values it knows offered under it: what a datalist offers there. */
function Offered(props: { value: string; onChange: (v: string) => void; offered: readonly string[]; placeholder?: string; testid: string }) {
  const shown = () => props.offered.filter((o) => o !== props.value && o.toLowerCase().includes(props.value.trim().toLowerCase())).slice(0, 6);
  return (
    <View class="gap-1.5">
      <TextInput testID={props.testid} value={props.value} onInput={props.onChange} placeholder={props.placeholder} />
      <If when={shown().length > 0}>
        <View class="flex-row flex-wrap gap-1">
          <Each of={shown()}>
            {(o) => (
              <View
                role="button"
                testID={`${props.testid}-offer-${o()}`}
                onPress={() => props.onChange(o())}
                class="rounded-sm border border-line px-1.5 py-0.5 hover:bg-hover"
              >
                <Text class="text-xs text-muted">{o()}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}

function RepoInput(props: { value: string; onChange: (v: string) => void }) {
  const repos = useRepos();
  return (
    <Offered
      testid="channel-repo"
      value={props.value}
      onChange={props.onChange}
      placeholder={t("web.channel.dialog.repoExample")}
      offered={ready(repos, []).map((p) => p.name)}
    />
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
  const submit = () => {
    if (ok() && !props.busy) void props.onSubmit();
  };
  return (
    <View class="gap-4">
      {props.children}
      <If when={props.error}>
        {(error) => (
          <Text role="alert" class="text-sm text-berry">
            {error()}
          </Text>
        )}
      </If>
      <View class="flex-row justify-end gap-3 pt-2">
        <Button testID="cancel" onPress={() => props.onCancel()}>
          {t("web.channel.dialog.cancel")}
        </Button>
        <Button tone="primary" testID="submit" disabled={props.busy || !ok()} onPress={submit}>
          {props.submit}
        </Button>
      </View>
    </View>
  );
}

// Making a channel or changing one, as both chat windows carry it out: the workbench's dialogs (here) and the farm's menu (farm/chat/ChannelMenu.tsx).
/** The form for a new channel, or for the one given as it is when opened (the form edits its own copy). */
function createChannelForm(channel?: Channel) {
  const was = untracked(() => ({
    name: channel?.name ?? "",
    description: channel?.description ?? "",
    repo: channel?.repo ?? "",
    category: channel?.category ?? "",
    notify: channel?.notify ?? "all",
    members: (channel?.members ?? []).toSorted(),
  }));
  const name = signal(was.name);
  const description = signal(was.description);
  const repo = signal(was.repo);
  const category = signal(was.category);
  const notify = signal<Notify>(was.notify);
  const members = signal<readonly string[]>(was.members);
  const error = signal<string | undefined>(undefined);
  // A refusal is said in the form, beside what it refuses, rather than in a toast.
  const act = createAct((reason) => error.set(reason));
  const busy = act.busy;

  /** The channel's id once it went through; undefined, with the reason in error, when refused. */
  const save = (): Promise<string | undefined> => {
    error.set(undefined);
    // Read as the user saves: the form may change while the call waits.
    const now = {
      name: name().trim(),
      description: description(),
      repo: repo(),
      category: category().trim(),
      notify: notify(),
      members: members().toSorted(),
    };
    return act.run(async () => {
      if (!channel)
        return api.channel.create(omitUndefined({ name: now.name, description: now.description.trim() || undefined, repo: now.repo.trim() || undefined }));
      // A direct channel has only its notifications to change.
      if (channel.type === "channel")
        await api.channel.update({
          id: channel.id,
          description: now.description,
          repo: now.repo,
          category: now.category,
          ...(now.name !== was.name ? { name: now.name } : {}),
          ...(now.members.join("\n") !== was.members.join("\n") ? { members: now.members } : {}),
        });
      if (now.notify !== was.notify) await api.channel.notify.set({ id: channel.id, notify: now.notify });
      return channel.id;
    });
  };

  return {
    name,
    setName: (v: string) => {
      name.set(v);
      error.set(undefined);
    },
    description,
    setDescription: description.set,
    repo,
    setRepo: repo.set,
    category,
    setCategory: category.set,
    notify,
    setNotify: notify.set,
    /** The orchestrators in the channel, by profile id. */
    members,
    /** Puts one in the channel, or takes it out. */
    setMember: (id: string, on: boolean) => members.set(on ? [...new Set([...members(), id])] : members().filter((x) => x !== id)),
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
      <If when={props.open}>
        <NewChannelForm onClose={() => props.onClose()} onCreated={(id) => props.onCreated(id)} />
      </If>
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
          autoFocus
          testID="channel-name"
          value={form.name()}
          placeholder={t("web.channel.dialog.nameExample")}
          onInput={form.setName}
          onSubmit={() => form.ready() && void submit()}
        />
      </Field>
      <Field label={t("web.channel.dialog.description")}>
        <TextArea
          testID="channel-description"
          rows={3}
          value={form.description()}
          onInput={form.setDescription}
          placeholder={t("web.channel.dialog.descriptionHint")}
        />
      </Field>
      <Field label={t("web.channel.dialog.repo")} hint={t("web.channel.dialog.repoHint")}>
        <RepoInput value={form.repo()} onChange={form.setRepo} />
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
      <If when={props.open}>
        <ChannelSettingsForm channel={props.channel} onClose={() => props.onClose()} onGone={() => props.onGone()} />
      </If>
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
  const form = createChannelForm(untracked(() => props.channel));
  const core = useCore();
  const orchestrators = useOrchestrators();
  const top = () => props.channel.type === "channel";
  // The groups the farm's channels are in, for the field to offer.
  const categories = () => [...new Set((core()?.chat?.channels ?? []).flatMap((c) => (c.category ? [c.category] : [])))];
  const submit = async () => {
    if ((await form.save()) !== undefined) props.onClose();
  };
  return (
    <View class="gap-5">
      <Form submit={t("web.channel.dialog.save")} onSubmit={submit} onCancel={() => props.onClose()} busy={form.busy()} error={form.error()}>
        <If when={top()}>
          <Field label={t("web.channel.manage.name")} hint={t("web.channel.dialog.nameHint")}>
            <TextInput testID="channel-name" value={form.name()} onInput={form.setName} />
          </Field>
          <Field label={t("web.channel.dialog.description")}>
            <TextArea
              testID="channel-description"
              rows={3}
              value={form.description()}
              onInput={form.setDescription}
              placeholder={t("web.channel.dialog.descriptionHint")}
            />
          </Field>
          <Field label={t("web.channel.dialog.repo")} hint={t("web.channel.dialog.repoNone")}>
            <RepoInput value={form.repo()} onChange={form.setRepo} />
          </Field>
          <Field label={t("web.channel.manage.members")} hint={t("web.channel.manage.membersHint")}>
            <View class="gap-1.5">
              <Each of={orchestrators()} key={(a) => a.id}>
                {(a) => (
                  <Checkbox
                    testid={`channel-member-${a().id}`}
                    label={a().name}
                    checked={form.members().includes(a().id)}
                    onChange={(on) => form.setMember(a().id, on)}
                  />
                )}
              </Each>
            </View>
          </Field>
          <Field label={t("web.channel.manage.category")} hint={t("web.channel.manage.categoryHint")}>
            <Offered testid="channel-category" value={form.category()} onChange={form.setCategory} offered={categories()} />
          </Field>
        </If>
        <Field label={t("web.channel.manage.notify")} hint={t("web.channel.manage.notifyHint")}>
          <Segmented label={t("web.channel.manage.notify")} testid="channel-notify" value={form.notify()} options={notifyOptions()} onChange={form.setNotify} />
        </Field>
      </Form>
      <If when={top() && !props.channel.default}>
        <ChannelDanger channel={props.channel} onDone={() => props.onClose()} onGone={() => props.onGone()} />
      </If>
    </View>
  );
}

/** Archiving, and deleting once the user has read what it does: the server's dry run, or why it refuses. */
function ChannelDanger(props: { channel: Channel; onDone: () => void; onGone: () => void }) {
  const does = signal<readonly string[] | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  // The refusal is said under the buttons, where the user pressed.
  const steps = createAct((reason) => error.set(reason));
  const busy = steps.busy;
  const act = (step: "archive" | "preview" | "delete") => {
    const { id, archived } = untracked(() => props.channel);
    error.set(undefined);
    return steps.run(async () => {
      if (step === "archive") {
        await api.channel.archive.set({ id, on: archived === undefined });
        untracked(() => props.onDone)();
      } else if (step === "preview") does.set((await api.channel.previewDelete({ id })).does);
      else {
        await api.channel.delete({ id });
        untracked(() => props.onGone)();
      }
    });
  };
  return (
    <View class="gap-2 border-t border-line pt-4">
      <View class="flex-row flex-wrap items-center gap-2">
        <Button testID="channel-archive" disabled={busy()} onPress={() => void act("archive")} accessibilityLabel={t("web.channel.manage.archiveHint")}>
          {props.channel.archived !== undefined ? t("web.channel.manage.unarchive") : t("web.channel.manage.archive")}
        </Button>
        <If
          when={does()}
          else={
            <Button tone="danger" testID="channel-remove" disabled={busy()} onPress={() => void act("preview")}>
              {t("web.channel.manage.remove")}
            </Button>
          }
        >
          <Button tone="danger" testID="channel-remove-sure" disabled={busy()} onPress={() => void act("delete")}>
            {t("web.channel.manage.removeSure")}
          </Button>
        </If>
      </View>
      <If when={does()}>
        {(lines) => (
          <View>
            <Text class="text-sm text-muted">{t("web.channel.manage.removeWill")}</Text>
            <View class="pl-2">
              <Each of={lines()}>{(line) => <Text class="text-sm text-ink">{`• ${line()}`}</Text>}</Each>
            </View>
          </View>
        )}
      </If>
      <If when={error()}>{(e) => <Text class="text-sm text-berry">{e()}</Text>}</If>
    </View>
  );
}
