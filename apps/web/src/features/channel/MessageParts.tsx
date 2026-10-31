// Every change to a message is the server's (channel.*): the list shows it once the channel's follower hears it back.

import { createSignal, For, onSettled, Show, untrack } from "solid-js";

import { Toolbar } from "@vibevalley/base-ui";
import { list, t } from "@vibevalley/i18n";
import { type Attachment, attachmentPath, type ChatMessage, type Embed, ownerId } from "@vibevalley/protocol";

import { api, reasonOf } from "@/base/api";
import { useCore } from "@/base/frame";
import { useRouter } from "@/base/router";
import { aria, autofocus } from "@/base/util";
import { fileKind, sizeText } from "@/ui/AttachmentTile";
import { Icon } from "@/ui/Icon";
import { Lightbox } from "@/ui/Lightbox";
import { Markdown } from "@/ui/Markdown";
import { MoreMenu } from "@/ui/MoreMenu";
import { toast } from "@/ui/toasts";

import { drafts } from "./draft";
import { quickReactions, reactionOn } from "./emoji";
import { EmojiPicker } from "./EmojiPicker";
import { workbenchClock } from "./feed";
import { useMessage } from "./follow";
import { type LinkedMessage, linkedMessages } from "./links";
import { channelLabel, channelOf, messagePath } from "./places";
import { markUnread } from "./reading";

const nameOf = (m: ChatMessage) => (m.from === ownerId ? t("web.channel.messages.owner") : m.name);

const run = (call: () => Promise<unknown>) => void call().catch((e) => toast(reasonOf(e), "bad"));

export function ReplyQuote(props: { channel: string; number: number }) {
  const answered = useMessage(() => ({ channel: props.channel, number: props.number }));
  const core = useCore();
  const router = useRouter();
  return (
    <button
      type="button"
      data-testid="quote"
      data-key={props.number}
      onClick={() => router.navigate(messagePath(channelOf(core()?.chat, props.channel), props.number))}
      class="mb-0.5 flex w-full min-w-0 cursor-pointer items-center gap-1.5 text-left text-xs text-muted hover:text-ink"
    >
      <Icon name="reply" size={10} class="opacity-60" />
      <Show when={answered()} fallback={<span>#{props.number}</span>}>
        {(m) => (
          <Show when={m().deleted === undefined} fallback={<span class="italic">{t("web.channel.messages.replyGone")}</span>}>
            <span class="shrink-0 font-medium text-ink">{nameOf(m())}</span>
            <span class="min-w-0 truncate">{m().text || list(m().attachments.map((a) => a.name))}</span>
          </Show>
        )}
      </Show>
    </button>
  );
}

/** Past this height a message's words start folded: a helper's long report should not push the conversation away. */
const foldPx = 360;

export function MessageBody(props: { m: ChatMessage }) {
  let box: HTMLDivElement | undefined;
  const [long, setLong] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  onSettled(() => {
    if (!box) return;
    const watch = new ResizeObserver(() => setLong(box!.scrollHeight > foldPx + 40));
    watch.observe(box);
    return () => watch.disconnect();
  });
  return (
    <Show when={props.m.deleted === undefined} fallback={<p class="text-sm text-muted italic">{t("web.channel.messages.deleted")}</p>}>
      <Show when={props.m.text}>
        <div
          ref={(el) => (box = el)}
          data-testid="message-body"
          data-folded={long() && !open() ? "" : undefined}
          class={{ "overflow-hidden fold-fade": long() && !open() }}
          style={long() && !open() ? { "max-height": `${foldPx}px` } : undefined}
        >
          <Markdown text={props.m.text} mentions />
        </div>
        <Show when={long()}>
          <button
            type="button"
            data-testid="message-more"
            aria-expanded={open() ? "true" : "false"}
            onClick={() => setOpen(!open())}
            class="mt-0.5 cursor-pointer rounded-sm px-1 text-xs text-muted hover:bg-hover hover:text-ink"
          >
            {open() ? t("web.base.rich.longLess") : t("web.base.rich.longMore")}
          </button>
        </Show>
      </Show>
      <Show when={props.m.edited !== undefined}>
        <span class="text-xs text-faint">{t("web.channel.messages.edited")}</span>
      </Show>
    </Show>
  );
}

const shownAs = fileKind;

export function Attachments(props: { files: readonly Attachment[] }) {
  // The message's pictures open over the page, one at a time, in their order here.
  const pictures = () => props.files.filter((f) => shownAs(f.type) === "image").map((f) => ({ id: f.id, src: attachmentPath(f.id), name: f.name }));
  const [open, setOpen] = createSignal<number>();
  return (
    <div class="mt-1 flex flex-wrap items-start gap-2">
      <Lightbox pictures={pictures()} at={open()} onAt={setOpen} />
      <For each={props.files} keyed={(f) => f.id}>
        {(f) => {
          // Keyed by its id, which names its bytes: a file never changes.
          const file = untrack(f);
          const at = () => attachmentPath(file.id);
          switch (shownAs(file.type)) {
            case "image":
              return (
                <button
                  type="button"
                  data-testid="attachment"
                  data-key={file.id}
                  data-kind="image"
                  aria-label={file.name}
                  class="block cursor-zoom-in rounded-md transition-opacity duration-120 hover:opacity-90"
                  onClick={() => setOpen(pictures().findIndex((p) => p.id === file.id))}
                >
                  <img src={at()} alt={file.name} class="max-h-64 max-w-80 rounded-md border border-line object-contain" loading="lazy" />
                </button>
              );
            case "video":
              return (
                <video
                  data-testid="attachment"
                  data-key={file.id}
                  data-kind="video"
                  src={at()}
                  controls
                  preload="metadata"
                  aria-label={file.name}
                  class="max-h-72 max-w-96 rounded-md border border-line bg-ink"
                />
              );
            case "audio":
              return (
                <audio
                  data-testid="attachment"
                  data-key={file.id}
                  data-kind="audio"
                  src={at()}
                  controls
                  preload="metadata"
                  aria-label={file.name}
                  class="max-w-96"
                />
              );
            case "pdf":
            case "file":
              return (
                <a
                  href={at()}
                  data-testid="attachment"
                  data-key={file.id}
                  data-kind={shownAs(file.type)}
                  target="_blank"
                  rel="noreferrer"
                  class="flex items-center gap-2 rounded-md border border-line bg-page px-3 py-2 text-sm hover:bg-hover"
                >
                  <Icon name={shownAs(file.type) === "pdf" ? "file" : "attach"} size={16} />
                  <span class="flex min-w-0 flex-col">
                    <span class="max-w-64 truncate">{file.name}</span>
                    <span class="text-xs text-muted">
                      {shownAs(file.type) === "pdf" ? t("web.channel.media.pdf") : t("web.channel.messages.file", { size: sizeText(file.size) })}
                    </span>
                  </span>
                </a>
              );
          }
        }}
      </For>
    </div>
  );
}

/** The links' previews the server read: what the page says of itself, and its picture from its own site. */
export function Embeds(props: { embeds: readonly Embed[] }) {
  return (
    <div class="mt-1 flex flex-col gap-1.5" aria-label={t("web.channel.media.preview")}>
      <For each={props.embeds} keyed={(e) => e.url}>
        {(e) => (
          <a
            href={e().url}
            target="_blank"
            rel="noreferrer noopener"
            class="flex max-w-lg gap-3 rounded-md border-l-4 border-accent bg-side px-3 py-2 hover:bg-hover"
          >
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <Show when={e().site}>
                <span class="truncate text-xs text-muted">{e().site}</span>
              </Show>
              <Show when={e().title}>
                <span class="line-clamp-2 text-sm font-semibold text-ok-ink">{e().title}</span>
              </Show>
              <Show when={e().description}>
                <span class="line-clamp-3 text-xs">{e().description}</span>
              </Show>
            </span>
            <Show when={e().image}>
              {(src) => <img src={src()} alt="" referrerpolicy="no-referrer" loading="lazy" class="size-16 shrink-0 rounded object-cover" />}
            </Show>
          </a>
        )}
      </For>
    </div>
  );
}

export function Reactions(props: { m: ChatMessage; names: (id: string) => string }) {
  return (
    <div class="mt-1 flex flex-wrap gap-1">
      <For each={props.m.reactions} keyed={(r) => r.emoji}>
        {(r) => {
          const mine = () => r().by.includes(ownerId);
          return (
            <button
              type="button"
              data-testid="reaction"
              data-key={r().emoji}
              data-count={r().by.length}
              aria-pressed={aria(mine())}
              title={t("web.channel.messages.reactedBy", { emoji: r().emoji, names: list(r().by.map(props.names)) })}
              onClick={() => run(() => api.channel.reaction.set({ id: props.m.id, emoji: r().emoji, on: !mine() }))}
              class={[
                "flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                mine() ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover",
              ]}
            >
              <span>{r().emoji}</span>
              <span>{r().by.length}</span>
            </button>
          );
        }}
      </For>
      <AddReaction m={props.m} />
    </div>
  );
}

/** A reaction picked from every emoji, for a message that has some already. */
function AddReaction(props: { m: ChatMessage }) {
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  return (
    <>
      <button
        type="button"
        ref={(el) => (button = el)}
        data-testid="add-reaction"
        aria-label={t("web.channel.emoji.more")}
        title={t("web.channel.emoji.more")}
        aria-expanded={aria(open())}
        onClick={() => setOpen(!open())}
        // Only on the message under the pointer or the focus, as the toolbar: every message has a 👀 to sit beside.
        class={[
          "flex cursor-pointer items-center rounded-full border border-line bg-page px-2 py-0.5 text-xs hover:bg-hover",
          open() ? "" : "opacity-0 group-focus-within/m:opacity-100 group-hover/m:opacity-100 focus-visible:opacity-100",
        ]}
      >
        <Icon name="add" size={12} />
      </button>
      <Show when={open()}>
        <EmojiPicker
          anchor={button}
          onClose={() => setOpen(false)}
          onPick={(emoji) => {
            setOpen(false);
            const m = untrack(() => props.m);
            run(() => api.channel.reaction.set({ id: m.id, emoji, on: reactionOn(m, emoji) }));
          }}
        />
      </Show>
    </>
  );
}

const tool = "inline-flex size-7 cursor-pointer items-center justify-center rounded hover:bg-hover";

export function MessageTools(props: { m: ChatMessage; inChannel: boolean; onEdit: () => void }) {
  const router = useRouter();
  const core = useCore();
  const [picking, setPicking] = createSignal(false);
  const [everyEmoji, setEveryEmoji] = createSignal(false);
  let moreEmoji: HTMLButtonElement | undefined;
  const [sure, setSure] = createSignal(false);
  const [more, setMore] = createSignal(false);
  const unread = () => {
    const { channel, number } = props.m;
    run(() => markUnread(channel, number));
  };
  const copyLink = () => {
    const link = location.origin + messagePath(channelOf(core()?.chat, props.m.channel), props.m.number);
    run(async () => {
      await navigator.clipboard.writeText(link);
      toast(t("web.channel.more.copied"));
    });
  };
  const editable = () => props.m.from === ownerId && props.m.kind === "chat";
  return (
    <Toolbar.Root
      data-testid="message-tools"
      aria-label={t("web.channel.tools.label")}
      // Shown while hovered, and while something it opened is: the picker is outside the row.
      class={[
        "absolute -top-3 right-2 z-10 items-center gap-0.5 rounded-md border border-line bg-page p-0.5 shadow-float",
        everyEmoji() || more() ? "flex" : "hidden group-focus-within/m:flex group-hover/m:flex",
      ]}
    >
      <Show when={picking()}>
        <div role="group" aria-label={t("web.channel.tools.pick")} class="flex items-center gap-0.5 border-r border-line pr-0.5">
          <For each={quickReactions}>
            {(emoji) => (
              <Toolbar.Button
                class={tool}
                data-testid="quick-reaction"
                data-key={emoji}
                aria-label={emoji}
                onClick={() => {
                  setPicking(false);
                  const m = props.m;
                  run(() => api.channel.reaction.set({ id: m.id, emoji, on: reactionOn(m, emoji) }));
                }}
              >
                {emoji}
              </Toolbar.Button>
            )}
          </For>
          <Toolbar.Button
            ref={(el) => (moreEmoji = el)}
            class={tool}
            data-testid="more-emoji"
            aria-label={t("web.channel.emoji.more")}
            title={t("web.channel.emoji.more")}
            aria-expanded={aria(everyEmoji())}
            onClick={() => setEveryEmoji(!everyEmoji())}
          >
            <Icon name="add" size={14} />
          </Toolbar.Button>
        </div>
      </Show>
      <Show when={everyEmoji()}>
        <EmojiPicker
          anchor={moreEmoji}
          onClose={() => setEveryEmoji(false)}
          onPick={(emoji) => {
            setEveryEmoji(false);
            setPicking(false);
            const m = untrack(() => props.m);
            run(() => api.channel.reaction.set({ id: m.id, emoji, on: reactionOn(m, emoji) }));
          }}
        />
      </Show>
      <Toolbar.Button
        class={tool}
        data-testid="message-tool"
        data-key="react"
        aria-label={t("web.channel.tools.react")}
        title={t("web.channel.tools.react")}
        onClick={() => setPicking(!picking())}
      >
        <Icon name="react" size={16} />
      </Toolbar.Button>
      <Toolbar.Button
        class={tool}
        data-testid="message-tool"
        data-key="reply"
        aria-label={t("web.channel.tools.reply")}
        title={t("web.channel.tools.reply")}
        onClick={() => drafts.reply(props.m.channel, props.m)}
      >
        <Icon name="reply" size={14} />
      </Toolbar.Button>
      <Show when={props.inChannel}>
        <Toolbar.Button
          class={tool}
          data-testid="message-tool"
          data-key="thread"
          aria-label={t("web.channel.tools.thread")}
          title={t("web.channel.tools.thread")}
          onClick={() => {
            const id = props.m.id;
            run(async () => {
              const thread = await api.channel.thread.create({ id });
              router.navigate(`/chat/${thread}`);
            });
          }}
        >
          <Icon name="thread" size={16} />
        </Toolbar.Button>
      </Show>
      <Toolbar.Button
        class={tool}
        data-testid="message-tool"
        data-key="pin"
        aria-label={props.m.pinned !== undefined ? t("web.channel.tools.unpin") : t("web.channel.tools.pin")}
        title={props.m.pinned !== undefined ? t("web.channel.tools.unpin") : t("web.channel.tools.pin")}
        aria-pressed={aria(props.m.pinned !== undefined)}
        onClick={() => {
          const m = props.m;
          run(() => api.channel.pin.set({ id: m.id, on: m.pinned === undefined }));
        }}
      >
        <Icon name="pin" size={16} class={props.m.pinned !== undefined ? "" : "opacity-60"} />
      </Toolbar.Button>
      <Show when={editable()}>
        <Toolbar.Button
          class={tool}
          data-testid="message-tool"
          data-key="edit"
          aria-label={t("web.channel.tools.edit")}
          title={t("web.channel.tools.edit")}
          onClick={() => props.onEdit()}
        >
          <Icon name="edit" size={14} />
        </Toolbar.Button>
      </Show>
      <MoreMenu
        label={t("web.channel.more.label")}
        testid="message-tool"
        dataKey="more"
        side="top"
        open={more()}
        onOpenChange={setMore}
        render={(p) => <Toolbar.Button {...p} />}
        items={[
          { key: "copy-link", label: t("web.channel.more.copyLink"), icon: "copy", onSelect: copyLink },
          { key: "mark-unread", label: t("web.channel.more.markUnread"), icon: "show", onSelect: unread },
        ]}
      />
      <Toolbar.Button
        class={[tool, { "bg-berry/15": sure() }]}
        data-testid="message-tool"
        data-key="delete"
        data-sure={sure() ? "" : undefined}
        aria-label={sure() ? t("web.channel.tools.sure") : t("web.channel.tools.remove")}
        title={sure() ? t("web.channel.tools.sure") : t("web.channel.tools.remove")}
        onBlur={() => setSure(false)}
        onClick={() => {
          if (!sure()) return void setSure(true);
          setSure(false);
          const id = props.m.id;
          run(() => api.channel.message.delete({ id }));
        }}
      >
        <Icon name="delete" size={14} />
      </Toolbar.Button>
    </Toolbar.Root>
  );
}

export function EditBox(props: { m: ChatMessage; onDone: () => void }) {
  // The words as they were when editing began: a change heard meanwhile does not move the box under the owner's hands.
  const { id, text: was, attachments: files } = untrack(() => props.m);
  const done = () => untrack(() => props.onDone)();
  const [text, setText] = createSignal(was);
  const [kept, setKept] = createSignal<readonly string[]>(files.map((f) => f.id));
  const save = () => {
    const words = text().trim();
    const fewer = kept().length < files.length;
    if ((!words && kept().length === 0) || (words === was && !fewer)) return done();
    const keep = [...kept()];
    run(async () => {
      await api.channel.message.update({ id, text: words, ...(fewer ? { attachments: keep } : {}) });
      done();
    });
  };
  return (
    <div class="mt-0.5">
      <textarea
        ref={autofocus()}
        data-testid="message-edit"
        value={text()}
        aria-label={t("web.channel.tools.edit")}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.isComposing) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            done();
          }
        }}
        class="block [field-sizing:content] w-full resize-none rounded-md border border-focus bg-page px-2 py-1.5 text-base outline-none"
      />
      <Show when={files.length > 0}>
        <div class="mt-1 flex flex-wrap gap-1.5">
          <For each={files}>
            {(f) => {
              const keeps = () => kept().includes(f.id);
              return (
                <button
                  type="button"
                  data-testid="edit-file"
                  data-key={f.name}
                  aria-pressed={aria(keeps())}
                  aria-label={keeps() ? t("web.channel.media.takeOff", { name: f.name }) : t("web.channel.media.keep", { name: f.name })}
                  onClick={() => setKept((k) => (keeps() ? k.filter((x) => x !== f.id) : [...k, f.id]))}
                  class={[
                    "flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
                    keeps() ? "border-line bg-page" : "border-dashed border-line text-faint line-through",
                  ]}
                >
                  <Icon name="attach" size={12} />
                  <span class="max-w-48 truncate">{f.name}</span>
                  <Icon name={keeps() ? "close" : "add"} size={10} />
                </button>
              );
            }}
          </For>
        </div>
      </Show>
      <p class="mt-1 text-xs text-muted">{t("web.channel.tools.editHint")}</p>
    </div>
  );
}

/** The farm's messages a message links to, each as it is now; a press goes there. */
export function LinkedMessages(props: { text: string }) {
  const core = useCore();
  const links = () => linkedMessages(props.text, core()?.chat, location.host);
  return (
    <Show when={links().length > 0}>
      <div class="mt-1 flex flex-col gap-1.5">
        <For each={links()} keyed={(l) => `${l.channel}:${l.number}`}>
          {(l) => <LinkedCard at={l()} />}
        </For>
      </div>
    </Show>
  );
}

function LinkedCard(props: { at: LinkedMessage }) {
  const core = useCore();
  const router = useRouter();
  const m = useMessage(() => props.at);
  const where = () => channelOf(core()?.chat, props.at.channel);
  return (
    <button
      type="button"
      data-testid="linked-message"
      data-key={`${props.at.channel}:${props.at.number}`}
      aria-label={t("web.channel.messages.linked", { where: channelLabel(where()), number: props.at.number })}
      onClick={() => router.navigate(messagePath(where(), props.at.number))}
      class="flex max-w-lg cursor-pointer flex-col gap-0.5 rounded-md border-l-4 border-wheat bg-side px-3 py-2 text-left hover:bg-hover"
    >
      <span class="flex items-baseline gap-2 text-xs text-muted">
        <span class="font-semibold text-ink">{m() ? nameOf(m()!) : `#${props.at.number}`}</span>
        <span>{channelLabel(where())}</span>
        <Show when={m()}>{(said) => <span>{workbenchClock(said().at)}</span>}</Show>
      </span>
      <Show when={m()}>
        {(said) => (
          <Show when={said().deleted === undefined} fallback={<span class="text-sm text-muted italic">{t("web.channel.messages.replyGone")}</span>}>
            <span class="line-clamp-3 text-sm">{said().text || list(said().attachments.map((a) => a.name))}</span>
          </Show>
        )}
      </Show>
    </button>
  );
}
