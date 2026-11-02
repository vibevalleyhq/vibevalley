// What a helper is told of the chat when it is woken for messages or busy with unread ones: said to the model, in
// Chinese whatever the owner's locale. The lines live in mailbox/prompts.ts, which Mailbox also says.

export { inboxLines, messageLine, wakeInput } from "@/mailbox/prompts.ts";

export const talkBrief = (name: string, said: string) =>
  `主人在和你（档案「${name}」）私聊。用主人的语言回答，延续这段对话。你有独立的工作目录，可用来保留聊天中的笔记和产出；这段对话没有关联工单或项目。主人要改一个项目时，先明确项目和要做的事，再用工单安排。\n\n私聊里最近说的，回答最后的问题：\n` +
  said;
