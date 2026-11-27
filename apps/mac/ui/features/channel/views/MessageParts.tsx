import { Clipboard, Image, keymap, signal, Text, untracked, Video, View } from "nsh";
import { Input } from "nsh/base";

import { list, t } from "@vibevalley/i18n";
import { type Attachment, type Channel, type ChatMessage, type Embed, NOTE_TYPES, type NoteType, userId } from "@vibevalley/protocol";
import { channelOf } from "@vibevalley/protocol/rules";

import { Button } from "../../../design/Button";
import { Dialog } from "../../../design/Dialog";
import { fileKind, kindIcon, sizeText } from "../../../design/domain/AttachmentTile";
import { Field, Select, TextArea, TextInput } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import type { IconName } from "../../../design/icons";
import { Lightbox } from "../../../design/Lightbox";
import { Markdown } from "../../../design/Markdown";
import { MoreMenu } from "../../../design/MoreMenu";
import { Bubble } from "../../../design/Tip";
import { toast } from "../../../design/toasts";
import { mix } from "../../../design/tone";
import { createAct } from "../../../infra/act";
import { api, newSendKey, reasonOf } from "../../../infra/api";
import { fileUrl, openAttachment, playAudio, useAttachmentFile } from "../../../infra/attachmentFile";
import { hostApi } from "../../../infra/bridge";
import { useMessage } from "../../../infra/channelFollow";
import { useCollabSlice } from "../../../infra/frame";
import { useQueryClient } from "../../../infra/query";
import { formatGenUiAction, type VvGenUiActionEvent } from "../../../infra/rich";
import { useRouter } from "../../../infra/router";
import { localizeRuntimeError } from "../../../infra/runtimeError";
import { createEffect } from "../../../infra/solid";
import { useIntents } from "../../../infra/state/intent";
import { pendingNewIssue } from "../../../infra/state/issueDraft";
import { transport } from "../../../infra/transport";
import { noteHref, noteTypeLabel } from "../../note";
import { drafts } from "../model/composing";
import { pinSet, reactionSet, sameMessage, sameReaction, setMark, markUnread, unreadMark } from "../model/marks";
import { workbenchClock, type LinkedMessage, channelLabel, linkedMessages, messagePath } from "../model/places";
import { buildPromotedIssueDraft, buildPromotedNoteContent, buildPromotedNoteDraft } from "../model/promote";
import { quickReactions, reactionOn, EmojiPopover } from "./EmojiPicker";

const nameOf = (m: ChatMessage) => (m.from === userId ? t("web.channel.messages.user") : m.name);

const bad = (reason: string) => toast(reason, "bad");

/** The user's reaction set on a message, shown at once (marks.ts); a refusal is said and the reaction goes back. */
function useReact() {
  const reactions = useIntents(reactionSet);
  return (m: ChatMessage, emoji: string, on: boolean) => setMark(reactions, { channel: m.channel, id: m.id, emoji, on }, sameReaction, bad);
}

export function ReplyQuote(props: { channel: string; number: number }) {
  const answered = useMessage(() => ({ channel: props.channel, number: props.number }));
  const collab = useCollabSlice();
  const router = useRouter();
  return (
    <View
      role="button"
      testID={`quote-${props.number}`}
      onPress={() => router.navigate(messagePath(channelOf(collab()?.chat, props.channel), props.number))}
      class="mb-0.5 w-full min-w-0 flex-row items-center gap-1.5"
    >
      <View class="opacity-60">
        <Icon name="reply" size={10} tone="muted" />
      </View>
      <If when={answered()} else={<Text class="text-xs text-muted">{`#${props.number}`}</Text>}>
        {(m) => (
          <If when={m().deleted === undefined} else={<Text class="text-xs text-muted italic">{t("web.channel.messages.replyGone")}</Text>}>
            <Text class="shrink-0 text-xs font-medium text-ink">{nameOf(m())}</Text>
            <Text class="min-w-0 flex-1 truncate text-xs text-muted">
              {m().text ? localizeRuntimeError(m().text).text : list(m().attachments.map((a) => a.name))}
            </Text>
          </If>
        )}
      </If>
    </View>
  );
}

/** Past this height a message's words start folded: a helper's long report should not push the conversation away. */
const foldPx = 360;

/** Dispatches a GenUI action emitted inside a channel message: state edits show feedback; explicit actions post a reply. */
export function handleChannelGenUiAction(m: Pick<ChatMessage, "channel" | "number">, event: VvGenUiActionEvent): void {
  const action = event.action.trim();
  const summary = formatGenUiAction(event);
  if (!summary) return;
  if (action === "state_change") {
    toast(summary);
    return;
  }
  void api.channel.message.send({ id: m.channel, text: summary, replyTo: m.number, sendKey: newSendKey() }).catch((e: unknown) => bad(reasonOf(e)));
}

export function MessageBody(props: { m: ChatMessage }) {
  const fold = signal<"short" | "folded" | "expanded">("short");
  createEffect(
    () => props.m.id,
    () => fold.set("short"),
    { defer: true },
  );
  const isFolded = () => fold() === "folded";
  const isExpanded = () => fold() === "expanded";
  return (
    <If when={props.m.deleted === undefined} else={<Text class="text-sm text-muted italic">{t("web.channel.messages.deleted")}</Text>}>
      <If when={props.m.text}>
        <View
          testID={isFolded() ? "message-body-folded" : "message-body"}
          class={isFolded() ? "overflow-hidden" : ""}
          style={isFolded() ? { maxHeight: foldPx } : undefined}
        >
          <View
            onLayout={(e) => {
              const isLong = e.bounds.size.height > foldPx + 40;
              const prev = untracked(fold);
              fold.set(!isLong ? "short" : prev === "short" ? "folded" : prev);
            }}
          >
            <Markdown
              text={props.m.actor.kind === "user" ? props.m.text : localizeRuntimeError(props.m.text).text}
              mentions
              onGenUiAction={(ev) => handleChannelGenUiAction(props.m, ev)}
            />
          </View>
        </View>
        <If when={fold() !== "short"}>
          <View
            role="button"
            testID="message-more"
            accessibilityState={{ expanded: isExpanded() }}
            onPress={() => fold.set(isExpanded() ? "folded" : "expanded")}
            class="mt-0.5 self-start rounded-sm px-1 hover:bg-hover"
          >
            <Text class="text-xs text-muted">{isExpanded() ? t("web.base.rich.longLess") : t("web.base.rich.longMore")}</Text>
          </View>
        </If>
      </If>
      <If when={props.m.edited !== undefined}>
        <Text class="text-xs text-faint">{t("web.channel.messages.edited")}</Text>
      </If>
    </If>
  );
}

const kindWords = (file: Attachment) =>
  fileKind(file.type) === "pdf" ? t("web.channel.media.pdf") : t("web.channel.messages.file", { size: sizeText(file.size) });

export function Attachments(props: { files: readonly Attachment[] }) {
  // The message's pictures open over the page, one at a time, in their order here, once their files are known.
  const known = signal<ReadonlyMap<string, string>>(new Map());
  const pictures = () =>
    props.files.flatMap((f) => {
      const path = fileKind(f.type) === "image" ? known().get(f.id) : undefined;
      return path === undefined ? [] : [{ id: f.id, src: fileUrl(path), name: f.name, path }];
    });
  const open = signal<number | undefined>(undefined);
  return (
    <View class="mt-1 flex-row flex-wrap items-start gap-2">
      <Lightbox pictures={pictures()} at={open()} onAt={(at) => open.set(at)} />
      <Each of={props.files} key={(f) => f.id}>
        {(f) => (
          <AttachmentPart
            file={f()}
            onKnown={(path) => known.set(new Map(known()).set(f().id, path))}
            onZoom={() => open.set(pictures().findIndex((p) => p.id === f().id))}
          />
        )}
      </Each>
    </View>
  );
}

/** The sound playing (host.playAudio plays one at a time), by attachment id. */
const playing = signal<string | undefined>(undefined);

/** A picture as itself (pressed, the Lightbox), a video in a player, a sound with play and stop, anything else (and
 * each until its file is known) as a tile that opens in the system's app (VibeValley's browser tab). */
function AttachmentPart(props: { file: Attachment; onKnown: (path: string) => void; onZoom: () => void }) {
  const file = useAttachmentFile(() => props.file.id);
  createEffect(
    () => file()?.path,
    (path) => void (path !== undefined && props.onKnown(path)),
  );
  const open = () => void openAttachment(props.file.id).catch((e: unknown) => toast(reasonOf(e), "bad"));
  const kind = () => (file() ? fileKind(props.file.type) : "file");
  const play = (path: string) => {
    if (playing() === props.file.id) {
      playing.set(undefined);
      void transport().call("host.stopAudio", {});
      return;
    }
    playing.set(props.file.id);
    void playAudio(path).catch((e: unknown) => {
      playing.set(undefined);
      toast(reasonOf(e), "bad");
    });
  };
  const tile = (
    <View
      role="button"
      testID={`attachment-${props.file.name}`}
      accessibilityLabel={props.file.name}
      onPress={open}
      class="flex-row items-center gap-2 rounded-md border border-line bg-page px-3 py-2 hover:bg-hover"
    >
      <Icon name={kindIcon[fileKind(props.file.type)]} size={16} tone="muted" />
      <View class="min-w-0">
        <Text class="max-w-64 truncate text-sm text-ink">{props.file.name}</Text>
        <Text class="text-xs text-muted">{kindWords(props.file)}</Text>
      </View>
    </View>
  );
  return (
    <If when={file()} else={tile}>
      {(f) => (
        <If
          when={kind() === "image"}
          else={
            <If
              when={kind() === "video"}
              else={
                <If when={kind() === "audio"} else={tile}>
                  <View
                    testID={`attachment-${props.file.name}`}
                    class="max-w-96 flex-row items-center gap-2 rounded-md border border-line bg-page py-1.5 pr-3 pl-1.5"
                  >
                    <IconButton
                      icon={playing() === props.file.id ? "stop" : "play"}
                      label={playing() === props.file.id ? t("web.base.stop") : t("web.base.play")}
                      onClick={() => play(f().path)}
                      testid="attachment-play"
                    />
                    <Icon name="audio" size={16} tone="muted" />
                    <Text class="min-w-0 shrink truncate text-sm text-ink">{props.file.name}</Text>
                    <Text class="text-xs text-muted">{sizeText(props.file.size)}</Text>
                  </View>
                </If>
              }
            >
              <Video
                testID={`attachment-${props.file.name}`}
                accessibilityLabel={props.file.name}
                src={fileUrl(f().path)}
                controls
                paused
                class="rounded-md border border-line bg-ink"
                style={{ width: 384, height: 216 }}
              />
            </If>
          }
        >
          <View
            role="button"
            testID={`attachment-${props.file.name}`}
            accessibilityLabel={props.file.name}
            onPress={() => props.onZoom()}
            class="rounded-md hover:opacity-90"
          >
            <Image src={fileUrl(f().path)} class="max-h-64 max-w-80 rounded-md border border-line object-contain" />
          </View>
        </If>
      )}
    </If>
  );
}

/** The links' previews the server read: what the page says of itself. */
export function Embeds(props: { embeds: readonly Embed[] }) {
  return (
    <View class="mt-1 gap-1.5" accessibilityLabel={t("web.channel.media.preview")}>
      <Each of={props.embeds} key={(e) => e.url}>
        {(e) => (
          <View
            role="link"
            testID="embed"
            onPress={() => void hostApi.openUrl(e().url)}
            class="max-w-lg flex-row gap-3 rounded-md border-l-4 border-accent bg-side px-3 py-2 hover:bg-hover"
          >
            <View class="min-w-0 flex-1 gap-0.5">
              <If when={e().site}>
                <Text class="truncate text-xs text-muted">{e().site}</Text>
              </If>
              <If when={e().title}>
                <Text class="line-clamp-2 text-sm font-semibold text-ok-ink">{e().title}</Text>
              </If>
              <If when={e().description}>
                <Text class="line-clamp-3 text-xs text-ink">{e().description}</Text>
              </If>
            </View>
          </View>
        )}
      </Each>
    </View>
  );
}

export function Reactions(props: { m: ChatMessage; names: (id: string) => string; hovered?: boolean }) {
  const react = useReact();
  return (
    <View class="mt-1 mb-1 flex-row flex-wrap gap-1">
      <Each of={props.m.reactions} key={(r) => r.emoji}>
        {(r) => {
          const mine = () => r().by.includes(userId);
          return (
            <View
              role="button"
              testID={`reaction-${r().emoji}`}
              accessibilityState={{ selected: mine() }}
              accessibilityLabel={`${r().emoji} ${r().by.length}`}
              tooltip={<Bubble text={t("web.channel.messages.reactedBy", { emoji: r().emoji, names: list(r().by.map(props.names)) })} />}
              onPress={() => react(props.m, r().emoji, !mine())}
              class={`flex-row items-center gap-1 rounded-full border px-2 py-0.5 ${mine() ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover"}`}
            >
              <Text class="text-xs">{r().emoji}</Text>
              <Text class="text-xs text-ink">{String(r().by.length)}</Text>
            </View>
          );
        }}
      </Each>
      <AddReaction m={props.m} hovered={props.hovered === true} />
    </View>
  );
}

/** A reaction picked from every emoji, for a message that has some already. */
function AddReaction(props: { m: ChatMessage; hovered: boolean }) {
  const react = useReact();
  const open = signal(false);
  createEffect(
    () => props.m.id,
    () => open.set(false),
    { defer: true },
  );
  return (
    // Only on the message under the pointer, as the toolbar: every message has a 👀 to sit beside.
    <View style={{ opacity: open() || props.hovered ? 1 : 0 }}>
      <EmojiPopover
        open={open()}
        onOpenChange={(v) => open.set(v)}
        label={t("web.channel.emoji.more")}
        testid="add-reaction"
        onPick={(emoji) => {
          open.set(false);
          const m = untracked(() => props.m);
          react(m, emoji, reactionOn(m, emoji));
        }}
        trigger={
          <View class="flex-row items-center rounded-full border border-line bg-page px-2 py-0.5 hover:bg-hover">
            <Icon name="add" size={12} tone="muted" />
          </View>
        }
      />
    </View>
  );
}

type ToolbarMenu = "closed" | "quickEmoji" | "fullEmoji" | "more" | "confirmDelete" | "saveNote";

function SaveAsNoteDialog(props: { m: ChatMessage; channel: Channel | undefined; onClose: () => void }) {
  const router = useRouter();
  const queries = useQueryClient();
  const initial = untracked(() => buildPromotedNoteDraft(props.m, props.channel));
  const title = signal(initial.title);
  const noteType = signal<NoteType>("doc");
  const content = signal(initial.content);
  const act = createAct();

  const typeOptions: readonly { value: NoteType; label: string }[] = NOTE_TYPES.map((type) => ({
    value: type,
    label: noteTypeLabel(type),
  }));

  const canSave = () => !act.busy() && title().trim() !== "";
  const save = () => {
    const cleanTitle = title().trim();
    if (!cleanTitle || act.busy()) return;
    const pickedType = noteType();
    const rawContent = content();
    const body = buildPromotedNoteContent({ title: cleanTitle, noteType: pickedType, content: rawContent });
    const channelId = props.m.channel;
    void act.run(async () => {
      const made = await api.note.create({
        title: cleanTitle,
        noteType: pickedType,
        content: body,
        channel: channelId,
        note: initial.note,
      });
      await queries.invalidate({ prefix: ["notes"] });
      props.onClose();
      toast(t("web.channel.promote.noteSaved", { title: made.title }));
      router.navigate(noteHref(made.id));
    });
  };

  return (
    <Dialog open onClose={props.onClose} title={t("web.channel.promote.saveTitle")} size="md" height="auto" testid="save-note-dialog">
      <View class="gap-3.5 px-5 py-4">
        <Field label={t("web.channel.promote.noteTitle")}>
          <TextInput testID="save-note-title" value={title()} onInput={(v) => title.set(v)} autoFocus />
        </Field>
        <Field label={t("web.channel.promote.noteType")}>
          <Select
            label={t("web.channel.promote.noteType")}
            testid="save-note-type"
            value={noteType()}
            onChange={(v) => noteType.set(v)}
            options={typeOptions}
          />
        </Field>
        <Field label={t("web.channel.promote.noteContent")}>
          <TextArea testID="save-note-content" rows={6} value={content()} onInput={(v) => content.set(v)} />
        </Field>
        <View class="flex-row items-center justify-end gap-2 border-t border-line pt-3">
          <Button tone="quiet" testID="save-note-cancel" onPress={props.onClose}>
            {t("web.channel.dialog.cancel")}
          </Button>
          <Button tone="primary" testID="save-note-submit" disabled={!canSave()} onPress={save}>
            {t("web.channel.promote.noteSave")}
          </Button>
        </View>
      </View>
    </Dialog>
  );
}

function Tool(props: { icon: IconName; size?: 14 | 16; label: string; testid: string; onPress: () => void; pressed?: boolean; dim?: boolean; sure?: boolean }) {
  return (
    <View
      role="button"
      testID={props.testid}
      accessibilityLabel={props.label}
      accessibilityState={props.pressed === undefined ? undefined : { selected: props.pressed }}
      tooltip={<Bubble text={props.label} />}
      onPress={() => props.onPress()}
      class="h-7 w-7 items-center justify-center rounded-sm hover:bg-hover"
      style={props.sure === true ? { backgroundColor: mix("berry", 0.15) } : undefined}
    >
      <View style={{ opacity: props.dim === true ? 0.6 : 1 }}>
        <Icon name={props.icon} size={props.size ?? 16} tone="ink" />
      </View>
    </View>
  );
}

/** The row's tools; `shown` while the row is hovered, and while something they opened is. */
export function MessageTools(props: { m: ChatMessage; inChannel: boolean; onEdit: () => void; shown: boolean }) {
  const router = useRouter();
  const collab = useCollabSlice();
  const menu = signal<ToolbarMenu>("closed");
  createEffect(
    () => props.m.id,
    () => menu.set("closed"),
    { defer: true },
  );
  const picking = () => menu() === "quickEmoji" || menu() === "fullEmoji";
  const everyEmoji = () => menu() === "fullEmoji";
  const sure = () => menu() === "confirmDelete";
  const more = () => menu() === "more";
  const react = useReact();
  const pins = useIntents(pinSet);
  const unreads = useIntents(unreadMark);
  const act = createAct();
  const unread = () => {
    const { channel, number } = props.m;
    markUnread(unreads, { channel, number }, bad);
  };
  const copyLink = () => {
    const link = messagePath(channelOf(collab()?.chat, props.m.channel), props.m.number);
    void act.run(async () => {
      await Clipboard.writeText(link);
      toast(t("web.channel.more.copied"));
    });
  };
  const promoteIssue = () => {
    const channel = channelOf(collab()?.chat, props.m.channel);
    pendingNewIssue.set(buildPromotedIssueDraft(props.m, channel));
    menu.set("closed");
    router.navigate("/issues/new");
  };
  const editable = () => props.m.from === userId && props.m.kind === "chat";
  const open = () => props.shown || menu() !== "closed";
  return (
    <If when={open()}>
      <If when={menu() === "saveNote"}>
        <SaveAsNoteDialog m={props.m} channel={channelOf(collab()?.chat, props.m.channel)} onClose={() => menu.set("closed")} />
      </If>
      <View
        role="toolbar"
        testID="message-tools"
        accessibilityLabel={t("web.channel.tools.label")}
        class="absolute -top-3 right-2 z-10 flex-row items-center gap-0.5 rounded-md border border-line bg-elevated p-0.5 shadow-float"
      >
        <If when={picking()}>
          <View accessibilityLabel={t("web.channel.tools.pick")} class="flex-row items-center gap-0.5 border-r border-line pr-0.5">
            <Each of={quickReactions} key={(emoji) => emoji}>
              {(emoji) => (
                <View
                  role="button"
                  testID={`quick-reaction-${emoji()}`}
                  accessibilityLabel={emoji()}
                  class="h-7 w-7 items-center justify-center rounded-sm hover:bg-hover"
                  onPress={() => {
                    menu.set("closed");
                    const m = props.m;
                    react(m, emoji(), reactionOn(m, emoji()));
                  }}
                >
                  <Text class="text-sm">{emoji()}</Text>
                </View>
              )}
            </Each>
            <EmojiPopover
              open={everyEmoji()}
              onOpenChange={(o) => menu.set(o ? "fullEmoji" : "quickEmoji")}
              label={t("web.channel.emoji.more")}
              testid="more-emoji"
              onPick={(emoji) => {
                menu.set("closed");
                const m = untracked(() => props.m);
                react(m, emoji, reactionOn(m, emoji));
              }}
              trigger={
                <View class="h-7 w-7 items-center justify-center rounded-sm hover:bg-hover">
                  <Icon name="add" size={14} />
                </View>
              }
            />
          </View>
        </If>
        <Tool icon="react" testid="message-tool-react" label={t("web.channel.tools.react")} onPress={() => menu.set(picking() ? "closed" : "quickEmoji")} />
        <Tool icon="reply" size={14} testid="message-tool-reply" label={t("web.channel.tools.reply")} onPress={() => drafts.reply(props.m.channel, props.m)} />
        <If when={props.inChannel}>
          <Tool
            icon="thread"
            testid="message-tool-thread"
            label={t("web.channel.tools.thread")}
            onPress={() => {
              const id = props.m.id;
              void act.run(async () => {
                const thread = await api.channel.thread.create({ id });
                router.navigate(`/chat/${thread}`);
              });
            }}
          />
        </If>
        <Tool
          icon="pin"
          testid="message-tool-pin"
          label={props.m.pinned !== undefined ? t("web.channel.tools.unpin") : t("web.channel.tools.pin")}
          pressed={props.m.pinned !== undefined}
          dim={props.m.pinned === undefined}
          onPress={() => {
            const m = props.m;
            setMark(pins, { channel: m.channel, id: m.id, on: m.pinned === undefined, at: Date.now() }, sameMessage, bad);
          }}
        />
        <If when={editable()}>
          <Tool icon="edit" size={14} testid="message-tool-edit" label={t("web.channel.tools.edit")} onPress={() => props.onEdit()} />
        </If>
        <MoreMenu
          label={t("web.channel.more.label")}
          testid="message-tool-more"
          side="top"
          open={more()}
          onOpenChange={(next) => menu.set(next ? "more" : more() ? "closed" : menu())}
          items={[
            { key: "promote-issue", label: t("web.channel.more.promoteIssue"), icon: "issues", onSelect: promoteIssue },
            { key: "save-note", label: t("web.channel.more.saveNote"), icon: "notes", onSelect: () => menu.set("saveNote") },
            { key: "copy-link", label: t("web.channel.more.copyLink"), icon: "copy", onSelect: copyLink },
            { key: "mark-unread", label: t("web.channel.more.markUnread"), icon: "show", onSelect: unread },
          ]}
        />
        <Tool
          icon="delete"
          size={14}
          testid="message-tool-delete"
          sure={sure()}
          label={sure() ? t("web.channel.tools.sure") : t("web.channel.tools.remove")}
          onPress={() => {
            if (!sure()) return menu.set("confirmDelete");
            menu.set("closed");
            const id = props.m.id;
            void act.run(() => api.channel.message.delete({ id }));
          }}
        />
      </View>
    </If>
  );
}

export function EditBox(props: { m: ChatMessage; onDone: () => void }) {
  // The words as they were when editing began: a change heard meanwhile does not move the box under the user's hands.
  const { id, text: was, attachments: files } = untracked(() => props.m);
  const done = () => untracked(() => props.onDone)();
  const text = signal(was);
  const kept = signal<readonly string[]>(files.map((f) => f.id));
  const act = createAct();
  // Escape leaves the edit, not an enclosing dialog: the newest binding runs.
  keymap.bind("escape", () => done(), { when: "always" });
  const save = () => {
    const words = text().trim();
    const fewer = kept().length < files.length;
    if ((!words && kept().length === 0) || (words === was && !fewer)) return done();
    const keep = [...kept()];
    void act.run(async () => {
      await api.channel.message.update({ id, text: words, ...(fewer ? { attachments: keep } : {}) });
      done();
    });
  };
  return (
    <View class="mt-0.5">
      <Input
        multiline
        submitBehavior="submit"
        testID="message-edit"
        accessibilityLabel={t("web.channel.tools.edit")}
        autoFocus
        value={text()}
        onChange={(e) => text.set(e.value)}
        onSubmit={() => save()}
        class="w-full rounded-md border border-focus bg-page px-2 py-1.5 text-base text-ink"
      />
      <If when={files.length > 0}>
        <View class="mt-1 flex-row flex-wrap gap-1.5">
          <Each of={files} key={(f) => f.id}>
            {(f) => {
              const keeps = () => kept().includes(f().id);
              return (
                <View
                  role="button"
                  testID={`edit-file-${f().name}`}
                  accessibilityState={{ selected: keeps() }}
                  accessibilityLabel={keeps() ? t("web.channel.media.takeOff", { name: f().name }) : t("web.channel.media.keep", { name: f().name })}
                  onPress={() => kept.set(keeps() ? kept().filter((x) => x !== f().id) : [...kept(), f().id])}
                  class={`flex-row items-center gap-1.5 rounded-md border border-line px-2 py-1 ${keeps() ? "bg-page" : "border-dashed"}`}
                >
                  <Icon name="attach" size={12} tone={keeps() ? "ink" : "faint"} />
                  <Text class={`max-w-48 truncate text-xs ${keeps() ? "text-ink" : "text-faint line-through"}`}>{f().name}</Text>
                  <Icon name={keeps() ? "close" : "add"} size={10} tone="muted" />
                </View>
              );
            }}
          </Each>
        </View>
      </If>
      <Text class="mt-1 text-xs text-muted">{t("web.channel.tools.editHint")}</Text>
    </View>
  );
}

/** The farm's messages a message links to, each as it is now; a press goes there. */
export function LinkedMessages(props: { text: string }) {
  const collab = useCollabSlice();
  // No page origin in a hosted view: links of the workbench's own form (`/chat/...?m=`) are the ones read.
  const links = () => linkedMessages(props.text, collab()?.chat, "vibevalley.local");
  return (
    <If when={links().length > 0}>
      <View class="mt-1 gap-1.5">
        <Each of={links()} key={(l) => `${l.channel}:${l.number}`}>
          {(l) => <LinkedCard at={l()} />}
        </Each>
      </View>
    </If>
  );
}

function LinkedCard(props: { at: LinkedMessage }) {
  const collab = useCollabSlice();
  const router = useRouter();
  const m = useMessage(() => props.at);
  const where = () => channelOf(collab()?.chat, props.at.channel);
  return (
    <View
      role="button"
      testID={`linked-message-${props.at.channel}:${props.at.number}`}
      accessibilityLabel={t("web.channel.messages.linked", { where: channelLabel(where()), number: props.at.number })}
      onPress={() => router.navigate(messagePath(where(), props.at.number))}
      class="max-w-lg gap-0.5 rounded-md border-l-4 border-wheat bg-side px-3 py-2 hover:bg-hover"
    >
      <View class="flex-row items-baseline gap-2">
        <Text class="text-xs font-semibold text-ink">
          {(() => {
            const said = m();
            return said ? nameOf(said) : `#${props.at.number}`;
          })()}
        </Text>
        <Text class="text-xs text-muted">{channelLabel(where())}</Text>
        <If when={m()}>{(said) => <Text class="text-xs text-muted">{workbenchClock(said().at)}</Text>}</If>
      </View>
      <If when={m()}>
        {(said) => (
          <If when={said().deleted === undefined} else={<Text class="text-sm text-muted italic">{t("web.channel.messages.replyGone")}</Text>}>
            <Text class="line-clamp-3 text-sm text-ink">
              {said().text ? localizeRuntimeError(said().text).text : list(said().attachments.map((a) => a.name))}
            </Text>
          </If>
        )}
      </If>
    </View>
  );
}
