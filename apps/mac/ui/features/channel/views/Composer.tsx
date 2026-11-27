import { cleanup, computed, effect, keymap, Picker, signal, Text, untracked, View, type InputRef, type JSX } from "nsh";
import { Input, Progress } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { type Channel, type HostAsrState as AsrSnapshot, type NoteViewContext, userId } from "@vibevalley/protocol";
import { sessionProfile } from "@vibevalley/protocol/rules";
import { HostAsrState } from "@vibevalley/protocol/schema";

import { CompareUploadDialog, type CompareUploadResult } from "../../../design/Compare";
import { AttachmentTile } from "../../../design/domain/AttachmentTile";
import { OrchestratorFace } from "../../../design/domain/Face";
import { Icon } from "../../../design/Icon";
import type { IconName } from "../../../design/icons";
import { readFiles } from "../../../design/picked";
import { Bubble } from "../../../design/Tip";
import { toast } from "../../../design/toasts";
import { mix } from "../../../design/tone";
import { createAct } from "../../../infra/act";
import { api, reasonOf } from "../../../infra/api";
import { importLocalAttachment } from "../../../infra/attachmentFile";
import { useInterval } from "../../../infra/base/timer";
import { typedMarks } from "../../../infra/base/typedMarks";
import { followed } from "../../../infra/channelFollow";
import { useCollabSlice, useSessionsSlice } from "../../../infra/frame";
import { useRouter } from "../../../infra/router";
import { useIntents } from "../../../infra/state/intent";
import { transport } from "../../../infra/transport";
import { activeNoteViewContext, clearActiveNoteViewContext, noteChatFocus } from "../../note";
import { MicWaveform } from "../../voice";
import { attachFiles, chatMarks, chatSay, createComposer, draftOf, drafts, setEditingId, uploadsIn, useReplying, type ComposerKey } from "../model/composing";
import { EmojiPopover } from "./EmojiPicker";
import { HelperFace } from "./presence";

/** The box for saying a sentence in a channel: Enter sends, Shift+Enter starts a line, @ names someone. */
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

function noteContextLabel(ctx: NoteViewContext): string {
  const parts = [t("web.channel.composer.noteContext", { title: ctx.title })];
  if (ctx.slideIndex !== undefined) parts.push(t("web.channel.composer.noteSlide", { n: ctx.slideIndex + 1 }));
  else if (ctx.activeArtboard) parts.push(ctx.activeArtboard);
  else if (ctx.activeTab) parts.push(ctx.activeTab);
  else if (ctx.activeDataset) parts.push(ctx.activeDataset);
  else if (ctx.activePath) parts.push(ctx.activePath);
  if (ctx.selectedIds && ctx.selectedIds.length > 0) {
    parts.push(t("web.channel.composer.noteSelected", { n: ctx.selectedIds.length }));
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

const idleAsr: AsrSnapshot = { phase: "idle", micLevel: 0, text: "", partial: "", problem: null };

function joinDictated(committed: string, partial: string): string {
  const c = committed.trim();
  const p = partial.trim();
  if (!c) return p;
  if (!p) return c;
  const needSpace = /[A-Za-z0-9]$/u.test(c) && /^[A-Za-z0-9]/u.test(p);
  return needSpace ? `${c} ${p}` : `${c}${p}`;
}

function spliceDictated(before: string, dictated: string, after: string): { next: string; caret: number } {
  if (!dictated) {
    return { next: `${before}${after}`, caret: before.length };
  }
  const needLead = before.length > 0 && !/\s$/u.test(before) && /^[A-Za-z0-9]/u.test(dictated);
  const lead = needLead ? " " : "";
  const prefix = `${before}${lead}${dictated}`;
  return { next: `${prefix}${after}`, caret: prefix.length };
}

export function Composer(props: { channel: Channel | undefined; placeholder: string; replyTo?: number | undefined }) {
  const collab = useCollabSlice();
  const sessions = useSessionsSlice();
  const problem = signal<string | undefined>(undefined);
  const emoji = signal(false);
  const compareOpen = signal(false);
  const focused = signal(false);
  const asr = signal<AsrSnapshot>(idleAsr);
  const dictateAnchor = signal<{ before: string; after: string } | undefined>(undefined);
  const rawRevert = signal<{ raw: string; caret: number } | undefined>(undefined);
  const dictateId = crypto.randomUUID();
  let dictatePolling = false;
  let dictateClosed = false;
  let applyingDictation = false;
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
  const visibleNoteContext = computed(() => {
    const ctx = activeNoteViewContext();
    if (!ctx) return undefined;
    const [path = "", query = ""] = router.path().split("?");
    if (path === "/chat" || path.startsWith("/chat/")) {
      const openNote = new URLSearchParams(query).get("note") ?? undefined;
      return openNote === ctx.noteId ? ctx : undefined;
    }
    return ctx;
  });
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
      const viewContext = untracked(visibleNoteContext);
      return {
        id: props.channel?.id ?? "",
        ...(replyNumber !== undefined ? { replyTo: replyNumber } : {}),
        ...(files.length > 0 ? { attachments: files.map((f) => f.id) } : {}),
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
      if (!applyingDictation) rawRevert.set(undefined);
      if (at) drafts.text(at, value);
    },
    sent: () => {
      rawRevert.set(undefined);
      if (asr().phase !== "idle") void stopDictation(true);
      const id = props.channel?.id;
      if (id) drafts.clear(id);
    },
  });

  const applyDictationText = (next: string, caret: number) => {
    applyingDictation = true;
    try {
      put(next, caret);
    } finally {
      applyingDictation = false;
    }
  };

  const applyDictationState = (next: AsrSnapshot) => {
    asr.set(next);
    if (next.problem) {
      problem.set(next.problem);
    }
    const anchor = dictateAnchor();
    const live = joinDictated(next.text, next.partial);
    if (anchor && live) {
      const merged = spliceDictated(anchor.before, live, anchor.after);
      applyDictationText(merged.next, merged.caret);
    }
    if (next.phase === "idle") {
      if (anchor && next.rawText !== undefined && next.rawText.trim() !== "" && next.rawText.trim() !== next.text.trim()) {
        const rawMerged = spliceDictated(anchor.before, next.rawText, anchor.after);
        rawRevert.set({ raw: rawMerged.next, caret: rawMerged.caret });
      } else {
        rawRevert.set(undefined);
      }
      dictateAnchor.set(undefined);
    }
  };

  const revertDictatedRaw = (revert: { raw: string; caret: number }) => {
    applyDictationText(revert.raw, revert.caret);
    rawRevert.set(undefined);
  };

  const callAsr = async (op: "host.asrStart" | "host.asrStop" | "host.asrState") => {
    const reply = await transport().call(op, { id: dictateId });
    if (dictateClosed && op === "host.asrStart") {
      void transport().call("host.asrStop", { id: dictateId });
      return;
    }
    if (reply.bizCode !== 0) {
      throw new Error(reply.message);
    }
    if (!dictateClosed) {
      applyDictationState(HostAsrState.parse(reply.data));
    }
  };

  const stopDictation = async (discardAnchor = false) => {
    if (discardAnchor) {
      dictateAnchor.set(undefined);
      rawRevert.set(undefined);
    }
    try {
      await callAsr("host.asrStop");
    } catch (error) {
      problem.set(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleDictation = async () => {
    if (!props.channel) return;
    if (asr().phase !== "idle") {
      await stopDictation(false);
      return;
    }
    problem.set(undefined);
    rawRevert.set(undefined);
    const { start, end } = untracked(selection);
    const current = untracked(box.text);
    const safeStart = Math.max(0, Math.min(start, current.length));
    const safeEnd = Math.max(safeStart, Math.min(end, current.length));
    dictateAnchor.set({ before: current.slice(0, safeStart), after: current.slice(safeEnd) });
    try {
      await callAsr("host.asrStart");
    } catch (error) {
      dictateAnchor.set(undefined);
      const message = error instanceof Error ? error.message : String(error);
      problem.set(message);
      toast(message, "bad");
    }
  };

  useInterval(() => {
    if (dictatePolling || asr().phase === "idle") return;
    dictatePolling = true;
    void callAsr("host.asrState")
      .catch((error: unknown) => {
        dictateAnchor.set(undefined);
        asr.set(idleAsr);
        problem.set(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        dictatePolling = false;
      });
  }, 100);

  cleanup(() => {
    dictateClosed = true;
    if (asr().phase !== "idle") {
      void transport().call("host.asrStop", { id: dictateId });
    }
  });
  // The system's open panel (VibeValley's hidden file input); the picked files come with their bytes.
  const pick = async () => attach(readFiles(await Picker.pickFiles({ multiple: true })));
  const attach = (files: readonly File[]) => {
    const id = props.channel?.id;
    if (id && files.length > 0) void attachFiles(id, files, uploadFailed);
  };
  const insertCompare = (result: CompareUploadResult) => {
    const id = props.channel?.id;
    if (!id) return;
    for (const file of result.attachments) {
      drafts.add(id, file);
    }
    const now = untracked(box.text);
    const sep = now.trim() === "" ? "" : now.endsWith("\n") ? "\n" : "\n\n";
    const next = `${now}${sep}${result.block}\n`;
    put(next, next.length);
    compareOpen.set(false);
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
  const initialChatFocusSeq = untracked(noteChatFocus);
  effect(() => {
    const req = noteChatFocus();
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
      <If when={visibleNoteContext()}>
        {(ctx) => (
          <View
            testID="note-context-pill"
            class="mb-2 h-6 max-w-full min-w-0 flex-row items-center gap-1.5 self-start rounded-full border border-line bg-side pr-1 pl-2.5"
          >
            <Icon name="notes" size={12} tone="muted" />
            <Text class="min-w-0 shrink truncate text-xs text-ink">{noteContextLabel(ctx())}</Text>
            <BoxButton
              icon="close"
              iconSize={12}
              testid="note-context-clear"
              label={t("web.channel.composer.clearContext")}
              onPress={clearActiveNoteViewContext}
              class="h-5 w-5 shrink-0 rounded-full"
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
          <If when={asr().phase !== "idle"}>
            <View
              testID="composer-dictating"
              class={`flex-row items-center gap-1.5 rounded-full px-2 py-0.5 ${asr().phase === "polishing" ? "bg-warn-soft" : "bg-ok-soft"}`}
            >
              <If
                when={asr().phase === "polishing"}
                else={<MicWaveform testid="composer-waveform" compact active={asr().phase === "listening"} level={asr().micLevel} />}
              >
                <Icon name="generate" size={12} tone="warn-ink" />
              </If>
              <Text class={`text-2xs font-medium ${asr().phase === "polishing" ? "text-warn-ink" : "text-ok-ink"}`}>
                {asr().phase === "connecting"
                  ? t("web.channel.composer.dictateConnecting")
                  : asr().phase === "finishing"
                    ? t("web.channel.composer.dictateFinishing")
                    : asr().phase === "polishing"
                      ? t("web.channel.composer.dictatePolishing")
                      : t("web.channel.composer.dictateListening")}
              </Text>
            </View>
          </If>
          <If when={asr().phase === "idle"}>
            <If when={rawRevert()}>
              {(revert) => (
                <View
                  role="button"
                  testID="composer-dictate-revert"
                  accessibilityLabel={t("web.channel.composer.dictateRevertRaw")}
                  tooltip={<Bubble text={t("web.channel.composer.dictateRevertRaw")} />}
                  onPress={() => revertDictatedRaw(revert())}
                  class="h-6 flex-row items-center gap-1 rounded-full bg-hover px-2 hover:bg-selected active:translate-y-px"
                >
                  <Icon name="undo" size={12} tone="muted" />
                  <Text class="text-2xs font-medium text-muted">{t("web.channel.composer.dictateRevertRaw")}</Text>
                </View>
              )}
            </If>
          </If>
          <BoxButton
            icon={asr().phase === "idle" ? "record" : "stop"}
            iconSize={14}
            testid="composer-dictate"
            label={asr().phase === "idle" ? t("web.channel.composer.dictateStart") : t("web.channel.composer.dictateStop")}
            tone={asr().phase === "idle" ? "muted" : "berry"}
            class={asr().phase === "idle" ? "" : "bg-bad-soft"}
            onPress={() => void toggleDictation()}
            disabled={!props.channel}
          />
          <BoxButton icon="attach" testid="attach" label={t("web.channel.composer.attach")} onPress={() => void pick()} disabled={!props.channel} />
          <BoxButton
            icon="diff"
            testid="composer-compare-btn"
            label={t("web.base.compare.addAction")}
            onPress={() => compareOpen.set(true)}
            disabled={!props.channel}
          />
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
      <CompareUploadDialog open={compareOpen()} onClose={() => compareOpen.set(false)} onSubmit={insertCompare} />
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
