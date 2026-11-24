import { computed, effect, keymap, Picker, signal, Text, untracked, View, type InputRef, type JSX } from "nsh";
import { Input, Progress } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { userId } from "@vibevalley/protocol";
import type { ArtifactViewContext, BlockRef, Channel } from "@vibevalley/protocol";
import { sessionProfile } from "@vibevalley/protocol/rules";

import { createAct } from "../../../design/act";
import { AttachmentTile } from "../../../design/domain/AttachmentTile";
import { OrchestratorFace } from "../../../design/domain/Face";
import { Icon } from "../../../design/Icon";
import type { IconName } from "../../../design/icons";
import { readFiles } from "../../../design/picked";
import { Bubble } from "../../../design/Tip";
import { toast } from "../../../design/toasts";
import { mix } from "../../../design/tone";
import { api, reasonOf } from "../../../infra/api";
import { importLocalAttachment } from "../../../infra/attachmentFile";
import { typedMarks } from "../../../infra/base/typedMarks";
import { useCollabSlice, useSessionsSlice } from "../../../infra/frame";
import { useRouter } from "../../../infra/router";
import { useIntents } from "../../../infra/state/intent";
import { activeArtifactViewContext, artifactChatFocus, clearActiveArtifactViewContext } from "../../artifact/store";
import { attachFiles, chatMarks, chatSay, createComposer, draftOf, drafts, setEditingId, uploadsIn, useReplying, type ComposerKey } from "../model/composing";
import { followed } from "../model/follow";
import { EmojiPopover } from "./EmojiPicker";
import { HelperFace } from "./presence";

/** The box for saying a sentence in a channel: Enter sends, Shift+Enter starts a line, @ names someone. */
export interface QuotedBlockDraft {
  readonly ref: BlockRef;
  readonly text: string;
}

const key = (name: string, shiftKey = false): ComposerKey & { prevented: boolean } => {
  const k = {
    key: name,
    shiftKey,
    prevented: false,
    preventDefault: () => {
      k.prevented = true;
    },
    stopPropagation: () => {},
  };
  return k;
};

function artifactContextLabel(ctx: ArtifactViewContext): string {
  const parts = [t("web.channel.composer.artifactContext", { title: ctx.title })];
  if (ctx.slideIndex !== undefined) parts.push(t("web.channel.composer.artifactSlide", { n: ctx.slideIndex + 1 }));
  else if (ctx.activeArtboard) parts.push(ctx.activeArtboard);
  else if (ctx.activeTab) parts.push(ctx.activeTab);
  else if (ctx.activeDataset) parts.push(ctx.activeDataset);
  if (ctx.selectedIds && ctx.selectedIds.length > 0) {
    parts.push(t("web.channel.composer.artifactSelected", { n: ctx.selectedIds.length }));
  }
  return parts.join(" · ");
}

function BoxButton(props: {
  icon: IconName;
  label: string;
  testid: string;
  onPress: () => void;
  disabled?: boolean;
  class?: string;
  tone?: string;
  iconSize?: 12 | 14 | 16;
}) {
  return (
    <View
      role="button"
      testID={props.testid}
      accessibilityLabel={props.label}
      tooltip={<Bubble text={props.label} />}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class={`h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-hover ${
        props.disabled === true ? "opacity-50" : "active:translate-y-px"
      } ${props.class ?? ""}`}
    >
      <Icon name={props.icon} size={props.iconSize ?? 16} tone={props.tone ?? "muted"} />
    </View>
  );
}

export function Composer(props: {
  channel: Channel | undefined;
  placeholder: string;
  replyTo?: number | undefined;
  quoted?: readonly QuotedBlockDraft[] | undefined;
  onClearQuote?: (() => void) | undefined;
  onRemoveQuote?: ((blockId: string) => void) | undefined;
}) {
  const collab = useCollabSlice();
  const sessions = useSessionsSlice();
  const problem = signal<string | undefined>(undefined);
  const emoji = signal(false);
  const focused = signal(false);
  // Where the caret is (and the selection's end), as the input last said; `placed` moves it.
  const selection = signal({ start: 0, end: 0 });
  const placed = signal<{ start: number; end?: number } | undefined>(undefined);
  const draft = () => draftOf(props.channel?.id);
  const draftFiles = computed(() => draft().files, { equals: (a, b) => a === b || (a.length === 0 && b.length === 0) });
  const uploading = () => uploadsIn(props.channel?.id);
  const replying = useReplying(() => props.channel?.id);
  // Built once for the channel (the page keys the box by it): it starts from the draft kept for it.
  const at = untracked(() => props.channel?.id);
  const router = useRouter();
  const place = (caret: number) => {
    selection.set({ start: caret, end: caret });
    placed.set({ start: caret });
  };
  const box = createComposer(collab, sessions, place, {
    ...(at ? { initial: untracked(() => draftOf(at).text) } : {}),
    says: useIntents(chatSay),
    target: () => {
      const files = draftFiles();
      const replyNumber = replying()?.number ?? props.replyTo;
      const viewContext = untracked(activeArtifactViewContext);
      return {
        id: props.channel?.id ?? "",
        ...(replyNumber !== undefined ? { replyTo: replyNumber } : {}),
        ...(files.length > 0 ? { attachments: files.map((f) => f.id) } : {}),
        ...((props.quoted?.length ?? 0) > 0 ? { blocks: (props.quoted ?? []).map((q) => q.ref) } : {}),
        ...(viewContext ? { viewContext } : {}),
      };
    },
    failed: (reason) => {
      problem.set(reason);
      toast(t("web.channel.composer.notSent", { why: reason }), "bad");
    },
    told: (say) => toast(say),
    opened: (path) => router.navigate(path),
    edited: (value) => {
      problem.set(undefined);
      if (at) drafts.text(at, value);
    },
    sent: () => {
      const id = props.channel?.id;
      if (id) drafts.clear(id);
      props.onClearQuote?.();
    },
  });
  // The system's open panel (VibeValley's hidden file input); the picked files come with their bytes.
  const pick = async () => attach(readFiles(await Picker.pickFiles({ multiple: true })));
  const attach = (files: readonly File[]) => {
    const id = props.channel?.id;
    if (id && files.length > 0) void attachFiles(id, files, uploadFailed);
  };
  /** The box as it is now, with its caret at. */
  const put = (next: string, caret: number) => {
    box.edit(next, caret);
    place(caret);
  };
  const insert = (text: string) => {
    const { start, end } = untracked(selection);
    const now = untracked(box.text);
    put(now.slice(0, start) + text + now.slice(end), start + text.length);
  };
  /** An @ at the caret, apart from the word before it: the names menu opens. */
  const startMention = () => {
    const before = untracked(box.text).slice(0, untracked(selection).start);
    insert(before === "" || /\s$/u.test(before) ? "@" : " @");
  };
  /** A command is the line's first word: a / at its start opens the commands menu, the words after it kept. */
  const startCommand = () => put(box.text().startsWith("/") ? box.text() : "/" + box.text(), 1);

  /** What a key does in the box; true when the box took it. */
  const onKey = (name: string, shiftKey = false): boolean => {
    const id = props.channel?.id;
    if (id && box.offered().length === 0) {
      if (name === "ArrowUp" && box.text() === "") {
        const mine = [...followed.get(id).messages].toReversed().find((m) => m.from === userId && m.kind === "chat" && m.deleted === undefined);
        if (mine) {
          setEditingId(mine.id);
          return true;
        }
      }
      if (name === "Escape" && replying()) {
        drafts.reply(id, undefined);
        return true;
      }
    }
    const k = key(name, shiftKey);
    box.onKey(k);
    return k.prevented;
  };
  // The keys the menu, the edit and the reply take, held only while they would be taken.
  const menuOpen = computed(() => focused() && box.offered().length > 0);
  effect(() => {
    if (!menuOpen()) return;
    return keymap.bind(
      { up: () => onKey("ArrowUp"), down: () => onKey("ArrowDown"), tab: () => onKey("Tab"), escape: () => onKey("Escape") },
      { when: "always" },
    );
  });
  const isEmpty = computed(() => box.text() === "");
  effect(() => {
    if (!focused() || menuOpen()) return;
    const offs: (() => void)[] = [];
    if (isEmpty()) offs.push(keymap.bind("up", () => onKey("ArrowUp"), { when: "always" }));
    if (replying()) offs.push(keymap.bind("escape", () => onKey("Escape"), { when: "always" }));
    return () => offs.forEach((off) => off());
  });
  let inputRef: InputRef | undefined;
  const initialChatFocusSeq = untracked(artifactChatFocus);
  effect(() => {
    const req = artifactChatFocus();
    if (req > initialChatFocusSeq) {
      queueMicrotask(() => inputRef?.focus());
    }
  });
  const stopping = createAct();
  const stop = () => {
    const agent = box.here();
    return stopping.run(() => api.orchestrator.stop({ agent }));
  };

  return (
    <View testID="composer" class="border-t border-line px-4 pt-2.5 pb-3.5">
      <If when={box.offered().length > 0}>
        <View
          role="listbox"
          accessibilityLabel={t("web.channel.composer.who")}
          testID="mentions"
          class="absolute right-4 bottom-full left-4 z-30 -mb-2 max-h-72 rounded-lg border border-line bg-elevated p-1 shadow-float"
        >
          <Each of={box.offered()} key={(n) => n.token}>
            {(n, i) => (
              <View
                role="option"
                testID={`mention-${n().token}`}
                accessibilityState={{ selected: i() === box.active() }}
                onMouseEnter={() => box.setActive(i())}
                focusable={false}
                onPress={() => box.choose(n())}
                class={`flex-row items-center gap-2 rounded-md px-2 py-1.5 ${i() === box.active() ? "bg-selected" : ""}`}
              >
                <If
                  when={n().session}
                  else={
                    <If
                      when={n().orchestrator}
                      else={
                        <View class="h-5 w-5 shrink-0 items-center justify-center">
                          <If when={n().args !== undefined}>
                            <Icon name="command" size={14} tone="muted" />
                          </If>
                        </View>
                      }
                    >
                      {(o) => <OrchestratorFace size={20} agent={o()} />}
                    </If>
                  }
                >
                  {(s) => <HelperFace agent={sessionProfile(s()) ?? ""} runtime={s().runtime} size={20} />}
                </If>
                <Text class="font-mono text-xs text-ink">
                  {n().token}
                  {n().args !== undefined && n().args !== "" ? ` ${n().args}` : ""}
                </Text>
                <If when={n().session !== undefined || n().args !== undefined}>
                  <Text class="text-sm text-ink">{n().name}</Text>
                </If>
                <Text class="min-w-0 flex-1 truncate text-xs text-muted">{n().note}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
      <If when={problem()}>
        {(p) => (
          <Text role="alert" testID="chat-problem" class="mb-2 text-xs text-berry">
            {p()}
          </Text>
        )}
      </If>
      <If when={(props.quoted?.length ?? 0) > 0}>
        <View class="mb-2 gap-1">
          <Each of={props.quoted ?? []} key={(q) => q.ref.blockId}>
            {(q) => (
              <View
                testID={`quoted-block-${q().ref.blockId}`}
                class="flex-row items-center gap-2 rounded-md border-l-2 border-wheat bg-side py-1 pr-1.5 pl-2.5"
              >
                <Icon name="artifacts" size={12} tone="muted" />
                <Text class="min-w-0 flex-1 truncate text-xs text-muted">{t("web.channel.composer.quotedBlock", { text: q().text })}</Text>
                <BoxButton
                  icon="close"
                  iconSize={12}
                  testid="quoted-block-remove"
                  label={t("web.channel.composer.cancelQuote")}
                  onPress={() => props.onRemoveQuote?.(q().ref.blockId)}
                  class="h-5 w-5"
                />
              </View>
            )}
          </Each>
        </View>
      </If>
      <If when={replying()}>
        {(m) => (
          <View testID="replying" class="mb-2 flex-row items-center gap-2 rounded-md border border-line bg-side py-1 pr-1.5 pl-2.5">
            <Icon name="reply" size={12} tone="muted" />
            <Text class="min-w-0 flex-1 truncate text-xs text-muted">
              {t("shared.join.labeled", {
                label: t("web.channel.composer.replying", { name: m().from === userId ? t("web.channel.messages.user") : m().name }),
                text: m().text,
              })}
            </Text>
            <BoxButton
              icon="close"
              iconSize={12}
              testid="cancel-reply"
              label={t("web.channel.composer.cancelReply")}
              onPress={() => props.channel && drafts.reply(props.channel.id, undefined)}
              class="h-5 w-5"
            />
          </View>
        )}
      </If>
      <If when={activeArtifactViewContext()}>
        {(ctx) => (
          <View testID="artifact-context-pill" class="mb-2 h-6 flex-row items-center gap-1.5 self-start rounded-full border border-line bg-side pr-1 pl-2.5">
            <Icon name="artifacts" size={12} tone="muted" />
            <Text class="max-w-72 truncate text-xs text-ink">{artifactContextLabel(ctx())}</Text>
            <BoxButton
              icon="close"
              iconSize={12}
              testid="artifact-context-clear"
              label={t("web.channel.composer.clearContext")}
              onPress={clearActiveArtifactViewContext}
              class="h-5 w-5 rounded-full"
            />
          </View>
        )}
      </If>
      <If when={draftFiles().length > 0 || uploading().length > 0}>
        <View class="mb-2 flex-row flex-wrap gap-1.5">
          <Each of={draftFiles()} key={(f) => f.id}>
            {(f) => <AttachmentTile testid="pending-file" file={f()} onRemove={() => props.channel && drafts.drop(props.channel.id, f().id)} />}
          </Each>
          <Each of={uploading()} key={(u) => u.key}>
            {(u) => (
              <Progress
                value={u().percent}
                accessibilityLabel={u().name}
                class="h-10 flex-row items-center rounded-md border border-line bg-page px-2.5"
                trackClass="absolute inset-0"
                indicatorClass="h-full"
                indicatorStyle={{ backgroundColor: mix("leaf", 0.2) }}
              >
                <Text class="max-w-48 truncate text-xs text-muted">{t("web.channel.media.uploadingFile", { name: u().name, percent: u().percent })}</Text>
              </Progress>
            )}
          </Each>
        </View>
      </If>
      <View class={`rounded-lg border bg-page ${focused() ? "border-focus" : "border-line"}`}>
        <Input
          ref={(el) => {
            inputRef = el;
          }}
          multiline
          submitBehavior="submit"
          pasteBehavior="insert"
          testID="composer-input"
          accessibilityLabel={props.placeholder}
          placeholder={props.placeholder}
          value={box.text()}
          selectedRange={placed()}
          onChange={(e) => {
            const was = untracked(box.text);
            const caret = Math.max(0, untracked(selection).start + (e.value.length - was.length));
            const mark = typedMarks(e.value, caret, chatMarks);
            if (mark) return put(e.value.slice(0, mark.from) + mark.text + e.value.slice(mark.to), mark.from + mark.text.length);
            box.edit(e.value, caret);
            selection.set({ start: caret, end: caret });
          }}
          onSelectionChange={(e) => {
            const cur = untracked(selection);
            if (cur.start === e.start && cur.end === e.end) return;
            selection.set({ start: e.start, end: e.end });
            box.caret(e.start);
          }}
          onSubmit={() => void onKey("Enter")}
          onFocus={() => {
            focused.set(true);
            box.focus();
          }}
          onBlur={() => {
            focused.set(false);
            box.blur();
          }}
          onPaste={(e) => attach(e.files ?? [])}
          class="max-h-50 min-h-12 w-full px-3 pt-2.5 pb-1.5 text-sm text-ink"
        />
        <View class="h-9 flex-row items-center gap-1 px-2 pb-1.5">
          <If when={props.channel?.type !== "direct"}>
            <BoxButton
              icon="mention"
              testid="mention-open"
              label={t("web.channel.composer.mention")}
              onPress={startMention}
              disabled={props.channel === undefined}
            />
          </If>
          <BoxButton
            icon="command"
            testid="command-open"
            label={t("web.channel.composer.command")}
            onPress={startCommand}
            disabled={props.channel === undefined}
          />
          <If when={box.stoppable()} else={<View class="flex-1" />}>
            <View testID="composer-running-hint" class="min-w-0 flex-1 flex-row items-center gap-1.5 px-1.5">
              <View class="h-1.5 w-1.5 shrink-0 rounded-full bg-leaf" />
              <Text class="min-w-0 flex-1 truncate text-xs text-muted">{t("web.channel.composer.runningHint")}</Text>
            </View>
          </If>
          <BoxButton icon="attach" testid="attach" label={t("web.channel.composer.attach")} onPress={() => void pick()} disabled={!props.channel} />
          <EmojiPopover
            open={emoji()}
            onOpenChange={(v) => emoji.set(v)}
            label={t("web.channel.emoji.open")}
            testid="emoji"
            onPick={(e) => {
              emoji.set(false);
              insert(e);
            }}
            trigger={
              <View class={`h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-hover ${props.channel ? "active:translate-y-px" : "opacity-50"}`}>
                <Icon name="react" size={16} tone="muted" />
              </View>
            }
          />
          <If when={box.stoppable()}>
            <BoxButton
              icon="stop"
              iconSize={14}
              testid="stop"
              label={t("web.channel.composer.stopHint")}
              onPress={() => void stop()}
              class="border border-line"
              tone="berry"
            />
          </If>
          <View
            role="button"
            testID="send"
            accessibilityLabel={t("web.channel.composer.send")}
            tooltip={<Bubble text={t("web.channel.composer.sendHint")} />}
            disabled={!box.canSend()}
            onPress={() => void box.send()}
            class={`h-7 w-7 shrink-0 items-center justify-center rounded-md border ${
              box.canSend() ? "border-accent bg-accent hover:bg-accent-hover active:translate-y-px" : "border-transparent bg-hover opacity-50"
            }`}
          >
            <Icon name="send" size={14} tone={box.canSend() ? "page" : "muted"} />
          </View>
        </View>
      </View>
    </View>
  );
}

/** A channel's pane taking files dropped on it into the channel's draft. */
export function FileDrop(props: { channel: Channel | undefined; children: JSX.Element }) {
  const over = signal(false);
  return (
    <View
      class="min-h-0 min-w-0 flex-1"
      onFileDragEnter={() => props.channel && over.set(true)}
      onFileDragLeave={() => over.set(false)}
      onFileDrop={(e) => {
        over.set(false);
        const id = props.channel?.id;
        if (id && e.uris.length > 0) void dropped(id, e.uris);
      }}
    >
      {props.children}
      <If when={over()}>
        <View
          testID="drop-hint"
          class="pointer-events-none absolute inset-2 z-20 items-center justify-center rounded-lg border-2 border-dashed border-accent"
          style={{ backgroundColor: mix("page", 0.85) }}
        >
          <Text class="text-base font-semibold text-accent">{t("web.channel.media.drop")}</Text>
        </View>
      </If>
    </View>
  );
}

/** Dropped local files imported straight into CAS when local, falling back to host read + upload when remote. */
async function dropped(channel: string, uris: readonly string[]) {
  for (const uri of uris) {
    try {
      const kept = await importLocalAttachment(uri);
      drafts.add(channel, kept);
    } catch (error) {
      uploadFailed(reasonOf(error));
    }
  }
}

const uploadFailed = (reason: string) => toast(t("web.channel.composer.uploadFailed", { why: reason }), "bad");
