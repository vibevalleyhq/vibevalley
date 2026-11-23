import { signal, Text, untracked, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import { type Channel, type Notify } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { createAct } from "../../../design/act";
import { Button } from "../../../design/Button";
import { Checkbox } from "../../../design/Checkbox";
import { Dialog } from "../../../design/Dialog";
import { OrchestratorFace } from "../../../design/domain/Face";
import { Field, TextArea, TextInput } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { Banner } from "../../../design/layout";
import { motionClass } from "../../../design/motion";
import { Segmented } from "../../../design/Segmented";
import { Bubble } from "../../../design/Tip";
import { mix } from "../../../design/tone";
import { useOrchestrators } from "../../../infra/agents";
import { api } from "../../../infra/api";
import { useCollabSlice } from "../../../infra/frame";
import { ready, useRepos } from "../../../infra/query";
import { channelName } from "../model/places";

/** A text field with the values it knows offered under it: what a datalist offers there. */
function Offered(props: { value: string; onChange: (v: string) => void; offered: readonly string[]; placeholder?: string; testid: string }) {
  const shown = () => props.offered.filter((o) => o !== props.value && o.toLowerCase().includes(props.value.trim().toLowerCase())).slice(0, 6);
  return (
    <View class="gap-1.5">
      <TextInput testID={props.testid} value={props.value} onInput={props.onChange} placeholder={props.placeholder} />
      <If when={shown().length > 0}>
        <View class="flex-row flex-wrap gap-1.5">
          <Each of={shown()} key={(o) => o}>
            {(o) => (
              <View
                role="button"
                testID={`${props.testid}-offer-${o()}`}
                onPress={() => props.onChange(o())}
                class={`group rounded-md border border-line bg-side px-2 py-0.5 ${motionClass("transition-transform duration-120 ease-out")} hover:border-faint hover:bg-hover active:translate-y-px`}
              >
                <Text class="text-xs text-muted group-hover:text-ink">{o()}</Text>
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
    <View class="gap-3.5">
      {props.children}
      <If when={props.error}>{(error) => <Banner role="alert">{error()}</Banner>}</If>
      <View class="flex-row items-center justify-end gap-2 border-t border-line pt-3">
        <Button tone="quiet" testID="cancel" onPress={() => props.onCancel()}>
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
    setDescription: (v: string) => description.set(v),
    repo,
    setRepo: (v: string) => repo.set(v),
    category,
    setCategory: (v: string) => category.set(v),
    notify,
    setNotify: (v: "all" | "mentions" | "none") => notify.set(v),
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
  const collab = useCollabSlice();
  const orchestrators = useOrchestrators();
  const top = () => props.channel.type === "channel";
  // The groups the farm's channels are in, for the field to offer.
  const categories = () => [...new Set((collab()?.chat?.channels ?? []).flatMap((c) => (c.category ? [c.category] : [])))];
  const submit = async () => {
    if ((await form.save()) !== undefined) props.onClose();
  };
  return (
    <View class="gap-4">
      <Form submit={t("web.channel.dialog.save")} onSubmit={submit} onCancel={() => props.onClose()} busy={form.busy()} error={form.error()}>
        <If when={top()}>
          <Field label={t("web.channel.manage.name")} hint={t("web.channel.dialog.nameHint")}>
            <TextInput testID="channel-name" value={form.name()} onInput={form.setName} onSubmit={() => form.ready() && void submit()} />
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
            <View class="gap-1">
              <Each of={orchestrators()} key={(a) => a.id}>
                {(a) => {
                  const checked = () => form.members().includes(a().id);
                  return (
                    <View class="flex-row items-center gap-2 rounded-md px-1.5 py-1 hover:bg-hover">
                      <Checkbox testid={`channel-member-${a().id}`} label={a().name} checked={checked()} onChange={(on) => form.setMember(a().id, on)} />
                      <View role="button" onPress={() => form.setMember(a().id, !checked())} class="min-w-0 flex-1 flex-row items-center gap-2">
                        <OrchestratorFace size={18} agent={a().id} />
                        <Text class="min-w-0 flex-1 truncate text-sm text-ink">{a().name}</Text>
                      </View>
                    </View>
                  );
                }}
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
    <View class="gap-2.5 border-t border-line pt-4">
      <View class="flex-row flex-wrap items-center gap-2">
        <View tooltip={<Bubble text={t("web.channel.manage.archiveHint")} />}>
          <Button
            icon="archive"
            testID="channel-archive"
            disabled={busy()}
            onPress={() => void act("archive")}
            accessibilityLabel={t("web.channel.manage.archiveHint")}
          >
            {props.channel.archived !== undefined ? t("web.channel.manage.unarchive") : t("web.channel.manage.archive")}
          </Button>
        </View>
        <If when={!does()}>
          <Button tone="danger" icon="delete" testID="channel-remove" disabled={busy()} onPress={() => void act("preview")}>
            {t("web.channel.manage.remove")}
          </Button>
        </If>
      </View>
      <If when={does()}>
        {(lines) => (
          <View class="gap-2 rounded-lg border bg-bad-soft px-3 py-2.5" style={{ borderColor: mix("berry", 0.25) }}>
            <View class="flex-row items-center gap-1.5">
              <Icon name="warn" size={14} />
              <Text class="text-xs font-semibold text-berry">{t("web.channel.manage.removeWill")}</Text>
            </View>
            <View class="gap-1 pl-1">
              <Each of={lines()} key="index">
                {(line) => (
                  <View class="flex-row items-start gap-1.5">
                    <Text class="text-xs text-berry">·</Text>
                    <Text class="min-w-0 flex-1 text-xs leading-relaxed text-ink">{line()}</Text>
                  </View>
                )}
              </Each>
            </View>
            <View class="flex-row items-center justify-end gap-2 pt-1">
              <Button tone="quiet" disabled={busy()} onPress={() => does.set(undefined)}>
                {t("web.channel.dialog.cancel")}
              </Button>
              <Button tone="danger" icon="delete" testID="channel-remove-sure" disabled={busy()} onPress={() => void act("delete")}>
                {t("web.channel.manage.removeSure")}
              </Button>
            </View>
          </View>
        )}
      </If>
      <If when={error()}>
        {(e) => (
          <View class="flex-row items-start gap-1.5">
            <View class="mt-0.5 shrink-0">
              <Icon name="cross" size={14} />
            </View>
            <Text class="min-w-0 flex-1 text-xs text-berry">{e()}</Text>
          </View>
        )}
      </If>
    </View>
  );
}
