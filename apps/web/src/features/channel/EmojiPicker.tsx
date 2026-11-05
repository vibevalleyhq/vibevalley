import { Portal } from "@solidjs/web";
import { For, onSettled, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type ChatMessage, ownerId } from "@vibevalley/protocol";
import { isOneOf } from "@vibevalley/protocol/rules";

/** What pressing an emoji on a message asks for: the owner's reaction off when it is on the message now, else on. */
export const reactionOn = (m: Pick<ChatMessage, "reactions">, emoji: string) => !(m.reactions.find((r) => r.emoji === emoji)?.by.includes(ownerId) ?? false);

/** What a reaction offers first; an agent can still react with any other. */
export const quickReactions = ["👍", "❤️", "😂", "🎉", "👀", "✅", "🙏", "🤔"];

// The words name the groups (words.ts emoji.groups); any other emoji is still said by typing it.
const emojiGroups: readonly { readonly id: string; readonly emoji: readonly string[] }[] = [
  {
    id: "faces",
    emoji: [
      "😀",
      "😃",
      "😄",
      "😁",
      "😆",
      "😅",
      "🤣",
      "😂",
      "🙂",
      "🙃",
      "😉",
      "😊",
      "😇",
      "🥰",
      "😍",
      "🤩",
      "😘",
      "😋",
      "😛",
      "😜",
      "🤪",
      "😝",
      "🤗",
      "🤭",
      "🤫",
      "🤔",
      "🤐",
      "🤨",
      "😐",
      "😑",
      "😶",
      "😏",
      "😒",
      "🙄",
      "😬",
      "🤥",
      "😌",
      "😔",
      "😪",
      "🤤",
      "😴",
      "😷",
      "🤒",
      "🤕",
      "🤢",
      "🤮",
      "🥵",
      "🥶",
      "🥴",
      "😵",
      "🤯",
      "🤠",
      "🥳",
      "😎",
      "🤓",
      "🧐",
      "😕",
      "😟",
      "🙁",
      "😮",
      "😯",
      "😲",
      "😳",
      "🥺",
      "😦",
      "😧",
      "😨",
      "😰",
      "😥",
      "😢",
      "😭",
      "😱",
      "😖",
      "😣",
      "😞",
      "😓",
      "😩",
      "😫",
      "🥱",
      "😤",
      "😡",
      "😠",
      "🤬",
      "😈",
      "💀",
      "💩",
      "🤡",
      "👻",
      "👽",
      "🤖",
    ],
  },
  {
    id: "hands",
    emoji: [
      "👍",
      "👎",
      "👌",
      "✌️",
      "🤞",
      "🤟",
      "🤘",
      "🤙",
      "👈",
      "👉",
      "👆",
      "👇",
      "☝️",
      "✋",
      "🤚",
      "🖐️",
      "🖖",
      "👋",
      "👏",
      "🙌",
      "👐",
      "🤲",
      "🙏",
      "✍️",
      "💪",
      "🫡",
      "🫶",
      "🤝",
    ],
  },
  {
    id: "things",
    emoji: [
      "🎉",
      "🎊",
      "🎁",
      "🏆",
      "🥇",
      "⚽",
      "🎮",
      "🎯",
      "🧩",
      "💡",
      "🔧",
      "🔨",
      "🛠️",
      "⚙️",
      "🧪",
      "🔍",
      "📌",
      "📎",
      "📝",
      "📦",
      "📚",
      "💻",
      "🖥️",
      "⌨️",
      "📱",
      "🔒",
      "🔑",
      "🚀",
      "⏰",
      "☕",
      "🍵",
      "🍕",
      "🍰",
      "🍎",
    ],
  },
  {
    id: "nature",
    emoji: [
      "🌱",
      "🌿",
      "☘️",
      "🍀",
      "🌾",
      "🌻",
      "🌸",
      "🌳",
      "🍂",
      "🍁",
      "🌧️",
      "☀️",
      "🌈",
      "⭐",
      "🌙",
      "🔥",
      "💧",
      "❄️",
      "🐶",
      "🐱",
      "🐔",
      "🐮",
      "🐷",
      "🐝",
      "🦋",
      "🐛",
    ],
  },
  {
    id: "signs",
    emoji: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "💯", "✅", "☑️", "❌", "⭕", "❗", "❓", "⚠️", "🚫", "➕", "➖", "🔁", "🔄", "⏳", "👀", "💬", "💤"],
  },
];

const width = 320;
const height = 288;
const gap = 4;

/** Where the picker goes beside the button that opened it: above when there is room, else below. inside the window. */
function placeBy(anchor: HTMLElement | undefined) {
  const r = anchor?.getBoundingClientRect();
  if (!r) return { left: gap, top: gap };
  const top = r.top >= height + gap * 2 ? r.top - height - gap : Math.min(r.bottom + gap, window.innerHeight - height - gap);
  const left = Math.min(Math.max(r.right - width, gap), window.innerWidth - width - gap);
  return { left: Math.max(left, gap), top: Math.max(top, gap) };
}

/** Every emoji the farm offers, the usual ones first. a press outside or Esc closes it. */

const groupKeys = ["frequent", "faces", "hands", "things", "nature", "signs"] as const;
/** A group of the picker by its id; an id with no name is shown as it is. */
const groupName = (id: string) => (isOneOf(groupKeys, id) ? t(`web.channel.emoji.groups.${id}`) : id);
export function EmojiPicker(props: { anchor: HTMLElement | undefined; onPick: (emoji: string) => void; onClose: () => void }) {
  let box: HTMLDivElement | undefined;
  const at = untrack(() => placeBy(props.anchor));
  const close = () => untrack(() => props.onClose)();
  onSettled(() => {
    const outside = (e: PointerEvent) => {
      const t = e.target instanceof Node ? e.target : null;
      if (t && box?.contains(t) !== true && untrack(() => props.anchor)?.contains(t) !== true) close();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  });
  const groups = [{ id: "frequent", emoji: quickReactions }, ...emojiGroups];
  return (
    <Portal>
      <div
        ref={(el) => (box = el)}
        role="dialog"
        data-testid="emoji-picker"
        aria-label={t("web.channel.emoji.open")}
        style={{ left: `${at.left}px`, top: `${at.top}px`, width: `${width}px`, "max-height": `${height}px` }}
        class="fixed z-30 flex animate-pop-in flex-col gap-2 overflow-y-auto rounded-lg border border-line bg-page p-2 text-ink shadow-float"
      >
        <For each={groups}>
          {(g) => (
            <section aria-label={groupName(g.id)}>
              <p class="px-1 pb-1 text-xs font-semibold text-muted">{groupName(g.id)}</p>
              <div class="grid grid-cols-8 gap-0.5">
                <For each={g.emoji}>
                  {(e) => (
                    <button
                      type="button"
                      data-key={e}
                      aria-label={e}
                      // Keeps the focus, and with it a box's caret, where it was.
                      onMouseDown={(ev) => ev.preventDefault()}
                      onClick={() => props.onPick(e)}
                      class="inline-flex size-8 cursor-pointer items-center justify-center rounded font-sans text-lg hover:bg-hover"
                    >
                      {e}
                    </button>
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
      </div>
    </Portal>
  );
}
