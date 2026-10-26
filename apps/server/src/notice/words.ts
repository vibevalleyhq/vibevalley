// What the inbox says to the owner, on every route it reaches them on (the phone, the system notice, the tray, the
// call): one entry a kind, so a kind added to InboxKind is worded here.

import type { InboxKind, InboxWords } from "@vibevalley/protocol";
import { localized, wording } from "@vibevalley/protocol/words";

const zh = {
  item: {
    review: (who: string, text: string): InboxWords => ({ label: "等你看", title: `${who} 做完了`, body: text, tray: `${who} 做完了，等你看` }),
    ask: (who: string, text: string): InboxWords => ({ label: "有问题问你", title: `${who} 有问题问你`, body: text }),
    fix: (who: string, text: string): InboxWords => ({ label: "活没做成", title: `${who} 没做成`, body: text, tray: `${who} 没做成` }),
    interrupted: (who: string, text: string): InboxWords => ({ label: wording().stuck.interrupted, title: `${who} 停在了半路`, body: text }),
    conflict: (who: string, text: string): InboxWords => ({
      label: "合不进去",
      title: `${who} 的活合进主分支会冲突`,
      body: text,
      tray: `${who} 的活会冲突`,
    }),
    quiet: (who: string): InboxWords => ({
      label: "好久没动静",
      title: `${who} 好一阵没动静了`,
      body: "可能在跑很久的命令，也可能卡住了：看看它的干活过程。",
      tray: `${who} 好一阵没动静`,
    }),
    "graph-draft": (_: string, text: string): InboxWords => ({
      label: "计划拆好了",
      title: `计划「${text}」拆好了`,
      body: "看过再开工",
      tray: `计划「${text}」等你看`,
    }),
    "graph-ready": (_: string, text: string): InboxWords => ({
      label: "计划做完了",
      title: `计划「${text}」都做完了`,
      body: "看看改动，合进主分支",
      tray: `计划「${text}」等你合进主分支`,
    }),
    "task-failed": (_: string, text: string): InboxWords => ({
      label: "计划卡住了",
      title: `计划卡住了：${text}`,
      body: "重试、改工单，或者跳过",
      tray: `计划「${text}」没做成`,
    }),
    mention: (who: string, text: string): InboxWords => ({ label: "找你", title: `${who} 叫你`, body: text }),
    "recurrence-ask": (_: string, text: string): InboxWords => ({
      label: "定时等你同意",
      title: "管家想定一个定时",
      body: `「${text}」：同意了才开始`,
      tray: `定时「${text}」等你同意`,
    }),
  } satisfies Record<InboxKind, (who: string, text: string) => InboxWords>,
  /** Who an item from the orchestrator is from. */
  orchestrator: "管家",
  conflictFiles: (files: number) => `${files} 个文件和主分支冲突`,
  /** A plan's step, as an item names it. */
  step: (plan: string, step: string) => plan + "：" + step,
};

const en: typeof zh = {
  item: {
    review: (who, text) => ({ label: "For you to see", title: `${who} is done`, body: text, tray: `${who} is done, for you to see` }),
    ask: (who, text) => ({ label: "A question for you", title: `${who} has a question for you`, body: text }),
    fix: (who, text) => ({ label: "It failed", title: `${who} failed`, body: text, tray: `${who} failed` }),
    interrupted: (who, text) => ({ label: wording().stuck.interrupted, title: `${who} stopped halfway`, body: text }),
    conflict: (who, text) => ({ label: "Won't merge", title: `${who}'s work would conflict with main`, body: text, tray: `${who}'s work would conflict` }),
    quiet: (who) => ({
      label: "Quiet for a while",
      title: `${who} has been quiet for a while`,
      body: "It may be running a long command, or it may be stuck: look at what it has been doing.",
      tray: `${who} has gone quiet`,
    }),
    "graph-draft": (_, text) => ({
      label: "Plan drafted",
      title: `The plan "${text}" is drafted`,
      body: "Look it over before it starts",
      tray: `The plan "${text}" is for you to see`,
    }),
    "graph-ready": (_, text) => ({
      label: "Plan done",
      title: `The plan "${text}" is all done`,
      body: "Look over the changes and merge them into main",
      tray: `The plan "${text}" is ready to merge into main`,
    }),
    "task-failed": (_, text) => ({
      label: "Plan stuck",
      title: `A plan is stuck: ${text}`,
      body: "Retry, edit the ticket, or skip it",
      tray: `The plan "${text}" failed`,
    }),
    mention: (who, text) => ({ label: "Calling you", title: `${who} is calling you`, body: text }),
    "recurrence-ask": (_, text) => ({
      label: "A schedule to approve",
      title: "The manager wants to set a schedule",
      body: `"${text}": it starts once you approve`,
      tray: `The schedule "${text}" waits for your approval`,
    }),
  },
  orchestrator: "The manager",
  conflictFiles: (files) => `${files} ${files === 1 ? "file conflicts" : "files conflict"} with main`,
  step: (plan, step) => plan + ": " + step,
};

export const noticeWording = localized({ zh, en });
