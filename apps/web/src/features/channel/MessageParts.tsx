// Every change to a message is the server's (channel.*): the list shows it once the channel's follower hears it back.

import { chatWording } from "./words";
import { createSignal, For, Show, untrack } from "solid-js";
import { type Attachment, attachmentPath, type ChatMessage, type Embed, ownerId } from "@vibevalley/protocol";
import { api, reasonOf } from "../../base/api";
import { useRouter } from "../../base/router";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { toast } from "../../ui/toasts";
import { aria, autofocus } from "../../base/util";
import { drafts } from "./draft";
import { useMessage } from "./follow";
import { quickReactions } from "./emoji";
import { EmojiPicker } from "./EmojiPicker";
import { useCore } from "../../base/frame";
import { markUnread } from "./data";
import { channelLabel, channelOf, type LinkedMessage, linkedMessages, messagePath, workbenchClock } from "./rules";

const sizeText = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const nameOf = (m: ChatMessage) => (m.from === ownerId ? chatWording().messages.owner : m.name);

const run = (call: () => Promise<unknown>) => void call().catch((e) => toast(reasonOf(e), "bad"));

export function ReplyQuote(props: { channel: string; number: number }) {
  const answered = useMessage(() => ({ channel: props.channel, number: props.number }));
  const core = useCore();
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.navigate(messagePath(channelOf(core()?.chat, props.channel), props.number))}
      class="mb-0.5 flex w-full min-w-0 cursor-pointer items-center gap-1.5 text-left text-xs text-muted hover:text-ink"
    >
      <Icon name="button-back" size={10} class="opacity-60" />
      <Show when={answered()} fallback={<span>#{props.number}</span>}>
        {(m) => (
          <Show when={m().deleted === undefined} fallback={<span class="italic">{chatWording().messages.replyGone}</span>}>
            <span class="shrink-0 font-medium text-ink">{nameOf(m())}</span>
            <span class="min-w-0 truncate">
              {m().text ||
                m()
                  .attachments?.map((a) => a.name)
                  .join("、")}
            </span>
          </Show>
        )}
      </Show>
    </button>
  );
}

export function MessageBody(props: { m: ChatMessage }) {
  return (
    <Show when={props.m.deleted === undefined} fallback={<p class="text-sm text-muted italic">{chatWording().messages.deleted}</p>}>
      <Show when={props.m.text}>
        <Markdown text={props.m.text} mentions />
      </Show>
      <Show when={props.m.edited !== undefined}>
        <span class="text-xs text-faint">{chatWording().messages.edited}</span>
      </Show>
    </Show>
  );
}

/** How a file shows in a message: a picture, a player, a PDF to open in a tab, or a file to save. */
const shownAs = (type: string) =>
  type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : type.startsWith("audio/") ? "audio" : type === "application/pdf" ? "pdf" : "file";

export function Attachments(props: { files: readonly Attachment[] }) {
  return (
    <div class="mt-1 flex flex-wrap items-start gap-2">
      <For each={props.files} keyed={(f) => f.id}>
        {(f) => {
          // Keyed by its id, which names its bytes: a file never changes.
          const file = untrack(f);
          const at = () => attachmentPath(file.id);
          switch (shownAs(file.type)) {
            case "image":
              return (
                <a href={at()} target="_blank" rel="noreferrer" class="block">
                  <img src={at()} alt={file.name} class="max-h-64 max-w-80 rounded-md border border-line object-contain" loading="lazy" />
                </a>
              );
            case "video":
              return <video src={at()} controls preload="metadata" aria-label={file.name} class="max-h-72 max-w-96 rounded-md border border-line bg-ink" />;
            case "audio":
              return <audio src={at()} controls preload="metadata" aria-label={file.name} class="max-w-96" />;
            case "pdf":
            case "file":
              return (
                <a
                  href={at()}
                  target="_blank"
                  rel="noreferrer"
                  class="flex items-center gap-2 rounded-md border border-line bg-page px-3 py-2 text-sm hover:bg-hover"
                >
                  <Icon name={shownAs(file.type) === "pdf" ? "icon-log" : "button-folder"} size={16} />
                  <span class="flex min-w-0 flex-col">
                    <span class="max-w-64 truncate">{file.name}</span>
                    <span class="text-xs text-muted">
                      {shownAs(file.type) === "pdf" ? chatWording().media.pdf : chatWording().messages.file(sizeText(file.size))}
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
    <div class="mt-1 flex flex-col gap-1.5" aria-label={chatWording().media.preview}>
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
                <span class="line-clamp-2 text-sm font-semibold text-accent">{e().title}</span>
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
      <For each={props.m.reactions ?? []} keyed={(r) => r.emoji}>
        {(r) => {
          const mine = () => r().by.includes(ownerId);
          return (
            <button
              type="button"
              aria-pressed={aria(mine())}
              title={chatWording().messages.reactedBy(r().emoji, r().by.map(props.names).join("、"))}
              onClick={() => run(() => api.channel.reaction.toggle({ id: props.m.id, emoji: r().emoji }))}
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
      <AddReaction id={props.m.id} />
    </div>
  );
}

/** A reaction picked from every emoji, for a message that has some already. */
function AddReaction(props: { id: string }) {
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  return (
    <>
      <button
        type="button"
        ref={(el) => (button = el)}
        aria-label={chatWording().emoji.more}
        title={chatWording().emoji.more}
        aria-expanded={aria(open())}
        onClick={() => setOpen(!open())}
        // Only on the message under the pointer or the focus, as the toolbar: every message has a 👀 to sit beside.
        class={[
          "flex cursor-pointer items-center rounded-full border border-line bg-page px-2 py-0.5 text-xs hover:bg-hover",
          open() ? "" : "opacity-0 group-focus-within/m:opacity-100 group-hover/m:opacity-100 focus-visible:opacity-100",
        ]}
      >
        <Icon name="button-add" size={12} />
      </button>
      <Show when={open()}>
        <EmojiPicker
          anchor={button}
          onClose={() => setOpen(false)}
          onPick={(emoji) => {
            setOpen(false);
            const id = untrack(() => props.id);
            run(() => api.channel.reaction.toggle({ id, emoji }));
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
  const copyLink = () => {
    setMore(false);
    const link = location.origin + messagePath(channelOf(core()?.chat, props.m.channel), props.m.number);
    run(async () => {
      await navigator.clipboard.writeText(link);
      toast(chatWording().more.copied);
    });
  };
  const editable = () => props.m.from === ownerId && props.m.kind === "chat";
  return (
    <div
      role="toolbar"
      aria-label={chatWording().tools.label}
      // Shown while hovered, and while something it opened is: the picker is outside the row.
      class={[
        "absolute -top-3 right-2 z-10 items-center gap-0.5 rounded-md border border-line bg-page p-0.5 shadow-float",
        everyEmoji() || more() ? "flex" : "hidden group-focus-within/m:flex group-hover/m:flex",
      ]}
    >
      <Show when={picking()}>
        <div role="group" aria-label={chatWording().tools.pick} class="flex items-center gap-0.5 border-r border-line pr-0.5">
          <For each={quickReactions}>
            {(emoji) => (
              <button
                type="button"
                class={tool}
                aria-label={emoji}
                onClick={() => {
                  setPicking(false);
                  run(() => api.channel.reaction.toggle({ id: props.m.id, emoji }));
                }}
              >
                {emoji}
              </button>
            )}
          </For>
          <button
            type="button"
            ref={(el) => (moreEmoji = el)}
            class={tool}
            aria-label={chatWording().emoji.more}
            title={chatWording().emoji.more}
            aria-expanded={aria(everyEmoji())}
            onClick={() => setEveryEmoji(!everyEmoji())}
          >
            <Icon name="button-add" size={14} />
          </button>
        </div>
      </Show>
      <Show when={everyEmoji()}>
        <EmojiPicker
          anchor={moreEmoji}
          onClose={() => setEveryEmoji(false)}
          onPick={(emoji) => {
            setEveryEmoji(false);
            setPicking(false);
            const id = untrack(() => props.m.id);
            run(() => api.channel.reaction.toggle({ id, emoji }));
          }}
        />
      </Show>
      <button type="button" class={tool} aria-label={chatWording().tools.react} title={chatWording().tools.react} onClick={() => setPicking(!picking())}>
        <Icon name="icon-hand" size={16} />
      </button>
      <button
        type="button"
        class={tool}
        aria-label={chatWording().tools.reply}
        title={chatWording().tools.reply}
        onClick={() => drafts.reply(props.m.channel, props.m)}
      >
        <Icon name="button-back" size={14} />
      </button>
      <Show when={props.inChannel}>
        <button
          type="button"
          class={tool}
          aria-label={chatWording().tools.thread}
          title={chatWording().tools.thread}
          onClick={() =>
            run(async () => {
              const thread = await api.channel.thread.create({ id: props.m.id });
              router.navigate(`/chat/${thread}`);
            })
          }
        >
          <Icon name="button-thread" size={16} />
        </button>
      </Show>
      <button
        type="button"
        class={tool}
        aria-label={props.m.pinned !== undefined ? chatWording().tools.unpin : chatWording().tools.pin}
        title={props.m.pinned !== undefined ? chatWording().tools.unpin : chatWording().tools.pin}
        aria-pressed={aria(props.m.pinned !== undefined)}
        onClick={() => run(() => api.channel.pin.toggle({ id: props.m.id }))}
      >
        <Icon name="icon-star" size={16} class={props.m.pinned !== undefined ? "" : "opacity-60"} />
      </button>
      <Show when={editable()}>
        <button type="button" class={tool} aria-label={chatWording().tools.edit} title={chatWording().tools.edit} onClick={() => props.onEdit()}>
          <Icon name="button-edit" size={14} />
        </button>
      </Show>
      <div class="relative">
        <button
          type="button"
          class={tool}
          aria-label={chatWording().more.label}
          title={chatWording().more.label}
          aria-expanded={aria(more())}
          onClick={() => setMore(!more())}
        >
          <Icon name="button-more" size={14} />
        </button>
        <Show when={more()}>
          <div
            role="menu"
            aria-label={chatWording().more.label}
            class="absolute right-0 bottom-full z-20 mb-1 flex w-44 flex-col rounded-md border border-line bg-page p-1 shadow-float"
          >
            <button type="button" role="menuitem" class="cursor-pointer rounded px-2 py-1 text-left text-sm hover:bg-hover" onClick={copyLink}>
              {chatWording().more.copyLink}
            </button>
            <button
              type="button"
              role="menuitem"
              class="cursor-pointer rounded px-2 py-1 text-left text-sm hover:bg-hover"
              onClick={() => {
                setMore(false);
                run(() => markUnread(props.m.channel, props.m.number));
              }}
            >
              {chatWording().more.markUnread}
            </button>
          </div>
        </Show>
      </div>
      <button
        type="button"
        class={[tool, { "bg-berry/15": sure() }]}
        aria-label={sure() ? chatWording().tools.sure : chatWording().tools.remove}
        title={sure() ? chatWording().tools.sure : chatWording().tools.remove}
        onBlur={() => setSure(false)}
        onClick={() => {
          if (!sure()) return void setSure(true);
          setSure(false);
          run(() => api.channel.message.delete({ id: props.m.id }));
        }}
      >
        <Icon name="button-delete" size={14} />
      </button>
    </div>
  );
}

export function EditBox(props: { m: ChatMessage; onDone: () => void }) {
  // The words as they were when editing began: a change heard meanwhile does not move the box under the owner's hands.
  const { id, text: was, attachments: files = [] } = untrack(() => props.m);
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
        value={text()}
        aria-label={chatWording().tools.edit}
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
        class="block w-full resize-none rounded-md border border-focus bg-page px-2 py-1.5 text-base outline-none [field-sizing:content]"
      />
      <Show when={files.length > 0}>
        <div class="mt-1 flex flex-wrap gap-1.5">
          <For each={files}>
            {(f) => {
              const keeps = () => kept().includes(f.id);
              return (
                <button
                  type="button"
                  aria-pressed={aria(keeps())}
                  aria-label={keeps() ? chatWording().media.takeOff(f.name) : chatWording().media.keep(f.name)}
                  onClick={() => setKept((k) => (keeps() ? k.filter((x) => x !== f.id) : [...k, f.id]))}
                  class={[
                    "flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
                    keeps() ? "border-line bg-page" : "border-dashed border-line text-faint line-through",
                  ]}
                >
                  <Icon name="button-folder" size={12} />
                  <span class="max-w-48 truncate">{f.name}</span>
                  <Icon name={keeps() ? "button-close" : "button-add"} size={10} />
                </button>
              );
            }}
          </For>
        </div>
      </Show>
      <p class="mt-1 text-xs text-muted">{chatWording().tools.editHint}</p>
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
      aria-label={chatWording().messages.linked(channelLabel(where()), props.at.number)}
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
          <Show when={said().deleted === undefined} fallback={<span class="text-sm text-muted italic">{chatWording().messages.replyGone}</span>}>
            <span class="line-clamp-3 text-sm">
              {said().text ||
                said()
                  .attachments?.map((a) => a.name)
                  .join("、")}
            </span>
          </Show>
        )}
      </Show>
    </button>
  );
}
