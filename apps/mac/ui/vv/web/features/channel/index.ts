// Ported from VibeValley apps/web/src/features/channel/index.ts: the same
// exports, from the ported views and the vendored models.
export { ChatPage } from "./views/ChatPage";
export { QuickSwitcher, switcher } from "./views/QuickSwitcher";
export { createChannelForm } from "./views/Dialogs";
export { chatMarks, chatSay, createComposer, drafts, pendingLines, useReplying } from "./model/composing";
export { reactionSet, sameReaction, setMark, useMarkedFollowed, useMarkRead } from "./model/marks";
export { EmojiPicker, quickReactions, reactionOn } from "./views/EmojiPicker";
export { followed, useFollowed, useMessage, useReports } from "./model/follow";
export {
  channelLabel,
  channelName,
  messagePath,
  topOf,
  topsOf,
  directsOf,
  chatPath,
  parentAt,
  issueThreadOf,
  threadOwnerOf,
  threadTitle,
  unreadIn,
  unreadTotal,
  unreadUnder,
} from "./model/places";
export { feedOf, orchestratorTyping } from "./model/places";
export { phaseText } from "./views/presence";
