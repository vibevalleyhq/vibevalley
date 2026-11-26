import { Scroll, Text, View, windowSize, type JSX } from "nsh";
import { Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { type ChatMessage, userId } from "@vibevalley/protocol";
import { isOneOf } from "@vibevalley/protocol/rules";

import { Bubble } from "../../../design/Tip";

/** What pressing an emoji on a message asks for: the user's reaction off when it is on the message now, else on. */
export const reactionOn = (m: Pick<ChatMessage, "reactions">, emoji: string) => !(m.reactions.find((r) => r.emoji === emoji)?.by.includes(userId) ?? false);

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

const groupKeys = ["frequent", "faces", "hands", "things", "nature", "signs"] as const;
/** A group of the picker by its id; an id with no name is shown as it is. */
const groupName = (id: string) => (isOneOf(groupKeys, id) ? t(`web.channel.emoji.groups.${id}`) : id);

/** Every emoji the farm offers, the usual ones first. */
function EmojiPicker(props: { width: number; onPick: (emoji: string) => void; onClose?: () => void }) {
  const groups = [{ id: "frequent", emoji: quickReactions }, ...emojiGroups];
  return (
    <View testID="emoji-picker" accessibilityLabel={t("web.channel.emoji.open")} class="gap-2" style={{ width: props.width - 16 }}>
      <Each of={groups} key={(g) => g.id}>
        {(g) => (
          <View accessibilityLabel={groupName(g().id)}>
            <Text class="px-1 pb-1 text-xs font-semibold text-muted">{groupName(g().id)}</Text>
            <View class="flex-row flex-wrap gap-0.5">
              <Each of={g().emoji} key={(e) => e}>
                {(e) => (
                  <View
                    role="button"
                    testID={`emoji-${e()}`}
                    accessibilityLabel={e()}
                    focusable={false}
                    onPress={() => props.onPick(e())}
                    class="h-8 w-8 items-center justify-center rounded-sm hover:bg-hover"
                  >
                    <Text class="text-lg">{e()}</Text>
                  </View>
                )}
              </Each>
            </View>
          </View>
        )}
      </Each>
    </View>
  );
}

/** The picker over the page beside `trigger`: above when there is room, else below. */
export function EmojiPopover(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (emoji: string) => void;
  trigger: JSX.Element;
  label: string;
  testid?: string;
}) {
  const popupWidth = () => Math.min(width, Math.max(220, windowSize().width - 24));
  const popupHeight = () => Math.min(height, Math.max(180, Math.round(windowSize().height * 0.6)));
  return (
    <Popover
      open={props.open}
      onOpenChange={(e) => props.onOpenChange(e.open)}
      placement="top"
      align="end"
      offset={4}
      popupClass="flex-col overflow-hidden rounded-lg border border-line bg-elevated p-2 shadow-float"
      popupStyle={{ width: popupWidth(), maxHeight: popupHeight() }}
      trigger={
        <View testID={props.testid} accessibilityLabel={props.label} tooltip={<Bubble text={props.label} />}>
          {props.trigger}
        </View>
      }
    >
      <Scroll style={{ maxHeight: popupHeight() - 16 }}>
        <EmojiPicker width={popupWidth()} onPick={props.onPick} onClose={() => props.onOpenChange(false)} />
      </Scroll>
    </Popover>
  );
}
