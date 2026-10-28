// What the chat says to the owner: who the owner and the orchestrator are in it, how a mention of them is written, the
// lines it posts when work is sent or handed on, its notices, and why a message or a channel is refused.

import { everyone, defaultOrchestrator, ownerId } from "@vibevalley/protocol";
import { localized } from "@vibevalley/protocol/words";

const zh = {
  /** The names the owner and the orchestrator speak under. */
  name: { owner: "主人", orchestrator: "管家" },
  /** How a mention of who is not a helper is written. */
  mention: { [defaultOrchestrator]: "@管家", [ownerId]: "@主人", [everyone]: "@所有人" } as Readonly<Record<string, string>>,
  list: (items: readonly string[]) => items.join("、"),
  channelName: "频道名只能是字母、数字、汉字、- 和 _，最多 24 个字",
  channelTaken: (name: string) => "已经有叫 " + name + " 的频道了",
  hopLimit: (limit: number) => `帮工之间已经来回 ${limit} 次了，先停一停：等主人说一句再接着叫人。`,
  notBack: "帮工还没接回来",
  breaker: (name: string, failed: number) => `${name} 连续 ${failed} 次一叫醒就失败了，先不再叫它；你直接给它带句话会再试。`,
  /** The dispatch line a job's thread hangs under, and the line when it is handed on. */
  dispatch: {
    step: (graph: string, task: string) => `做计划 ${graph} 的「${task}」`,
    split: (graph: string) => "拆计划 " + graph,
    draft: "看代码，起草这张工单",
    project: "项目",
    sent: (id: string, name: string, project: string, what: string) => `派 @${id}（${name}）去 ${project}：${what}`,
    redraft: (id: string, name: string) => `这张工单交给 @${id}（${name}）再起草一版`,
    handedOn: (id: string, name: string, nth: number) => `这张工单交给 @${id}（${name}）接着做，第 ${nth} 次派活`,
  },
  badTarget: (target: string) => `不认识这个地方：${target}（写 #<频道>，比如 #general；或 #<频道>:<消息号>）`,
  noChannelNamed: (name: string, tags: readonly string[]) => `没有叫 #${name} 的频道。有：${tags.join("、")}`,
  noMessage: (n: number) => `频道里没有 ${n} 这条消息`,
  empty: "没说什么",
  sendKeyLong: "sendKey 太长",
  channelGone: "找不到这个频道",
  absent: (who: readonly string[]) => who.join("、") + " 不在场，没送到",
  noHelper: (id: string) => `没有 ${id} 这个帮工`,
  noChannel: (id: string) => `没有 ${id} 这个频道`,
  notOrchestrator: (id: string) => `${id} 不是管家的档案：频道只能交给管家照看`,
  noMessageId: (id: string) => `没有 ${id} 这条消息`,
  threadOnlyTitle: "串只能改标题",
  defaultStays: "默认频道不能归档、不能删：先把别的频道设成默认",
  deletesChannel: (target: string, threads: number, said: number) => `删掉 ${target}，连同它的 ${threads} 个串和 ${said} 条消息`,
  inUse: (why: string) => `删不了：${why}。可以归档它`,
  helpersThere: "还有帮工在这个频道里干活",
  recurrencesThere: (n: number) => `还有 ${n} 个定时在这里`,
  connectorsThere: "接着连接器",
  queuedThere: (n: number) => `还有 ${n} 张工单排着队要在这里开工`,
  issuesThere: (n: number) => `这里派过 ${n} 张工单的活`,
  noAttachment: (id: string) => `没有 ${id} 这个附件：先上传，再带着它说话`,
  messageGone: "这条消息已经删了",
  notYours: "只能改你自己说的话",
  badEmoji: "回应是一个表情或一个短词，不带空格",
  threadOnlyInChannel: "串只开在频道里的消息下面",
  emptyFile: "这个文件是空的",
  fileTooBig: (max: number) => `文件太大了：至多 ${Math.round(max / 1024 / 1024)} MB`,
  deletes: (target: string, number: number, name: string, text: string) => `删掉 ${target} 的第 ${number} 条（${name}：${text}），号留着`,
  deletesDeliveries: (n: number) => `还没交出去的 ${n} 份不再送`,
  defaultIsChannel: "默认频道只能是一个频道，不能是私聊或串",
  noDirect: (target: string) => `${target}：你和对方之间没有私聊`,
};

const en: typeof zh = {
  name: { owner: "You", orchestrator: "Manager" },
  mention: { [defaultOrchestrator]: "@manager", [ownerId]: "@owner", [everyone]: "@everyone" },
  list: (items) => items.join(", "),
  channelName: "A channel name has only letters, digits, - and _, up to 24 characters",
  channelTaken: (name) => "There is already a channel called " + name,
  hopLimit: (limit) => `The helpers have gone back and forth ${limit} times: they pause here until you say something.`,
  notBack: "The helpers have not come back yet",
  breaker: (name, failed) =>
    `${name} failed ${failed} times in a row as soon as it was woken, so it is not woken again for now; telling it something directly tries again.`,
  dispatch: {
    step: (graph, task) => `step "${task}" of the plan ${graph}`,
    split: (graph) => "splitting the plan " + graph,
    draft: "reading the code and drafting this ticket",
    project: "the project",
    sent: (id, name, project, what) => `Sent @${id} (${name}) to ${project}: ${what}`,
    redraft: (id, name) => `This ticket goes to @${id} (${name}) for another draft`,
    handedOn: (id, name, nth) => `This ticket goes to @${id} (${name}) to carry on, sent for the ${ordinal(nth)} time`,
  },
  badTarget: (target) => `Unknown place: ${target} (write #<channel>, such as #general, or #<channel>:<message number>)`,
  noChannelNamed: (name, tags) => `There is no channel #${name}. There are: ${tags.join(", ")}`,
  noMessage: (n) => `The channel has no message ${n}`,
  empty: "Nothing was said",
  sendKeyLong: "The sendKey is too long",
  channelGone: "The channel cannot be found",
  absent: (who) => who.join(", ") + (who.length === 1 ? " is" : " are") + " not here; not delivered",
  noHelper: (id) => `There is no helper ${id}`,
  noChannel: (id) => `There is no channel ${id}`,
  notOrchestrator: (id) => `${id} is not an orchestrator's profile: only an orchestrator can look after a channel`,
  noMessageId: (id) => `There is no message ${id}`,
  threadOnlyTitle: "A thread can only get a title",
  defaultStays: "The default channel cannot be archived or deleted: make another one the default first",
  deletesChannel: (target, threads, said) => `Delete ${target}, with its ${threads} threads and ${said} messages`,
  inUse: (why) => `Cannot delete it: ${why}. It can be archived`,
  helpersThere: "helpers still work in this channel",
  recurrencesThere: (n) => `${n} recurrences are here`,
  connectorsThere: "a connector is bound to it",
  queuedThere: (n) => `${n} tickets wait in the queue to start here`,
  issuesThere: (n) => `${n} tickets were worked here`,
  noAttachment: (id) => `There is no attachment ${id}: upload it first, then say it`,
  messageGone: "This message is deleted already",
  notYours: "Only your own words can be changed",
  badEmoji: "A reaction is one emoji or a short word, without spaces",
  threadOnlyInChannel: "A thread opens only under a message in a channel",
  emptyFile: "The file is empty",
  fileTooBig: (max) => `The file is too big: ${Math.round(max / 1024 / 1024)} MB at most`,
  deletes: (target, number, name, text) => `Delete message ${number} in ${target} (${name}: ${text}); its number stays`,
  deletesDeliveries: (n) => `${n} not yet handed are no longer sent`,
  defaultIsChannel: "Only a channel can be the default, not a direct channel or a thread",
  noDirect: (target) => `${target}: there is no direct channel between you`,
};

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return n + "th";
  return n + (["th", "st", "nd", "rd"][n % 10] ?? "th");
}

export const channelWording = localized({ zh, en });
