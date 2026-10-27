// What the gateway says to the owner (errors.ts, handlers.ts): where to look for what was not found, and why a request
// does not match its path.

import { localized } from "@vibevalley/protocol/words";

const zh = {
  /** errors.ts lookIn: what each list is for. */
  lookIn: {
    issue: "列出工单，找它的编号",
    session: "列出帮工，找它的 id",
    project: "列出项目，找它的名字",
    runtime: "列出农机，找它的 id",
    doc: "列出文档，找它的 id",
    agent: "列出档案，找它的 id",
    skill: "列出技能，找它的 id",
    recurrence: "列出定时，找它的 id",
    device: "看连着的设备，找它的 id",
    archive: "列出管家的旧账",
    channel: "频道和对话在核心状态的 state.chat 里",
    graph: "计划在核心状态的 graphs 里",
    memories: "列出它的记性，找那一条的 id",
  },
  projectRef: (id: string) => "项目 " + id,
  helperRef: (id: string) => "帮工 " + id,
  archiveRef: (name: string) => "旧账 " + name,
};

const en: typeof zh = {
  lookIn: {
    issue: "List the tickets and find its number",
    session: "List the helpers and find its id",
    project: "List the projects and find its name",
    runtime: "List the machines and find its id",
    doc: "List the docs and find its id",
    agent: "List the profiles and find its id",
    skill: "List the skills and find its id",
    recurrence: "List the schedules and find its id",
    device: "See the connected devices and find its id",
    archive: "List the manager's archive",
    channel: "The channels are in the core state, under state.chat",
    graph: "Plans are in the core state, under graphs",
    memories: "List its memories and find that one's id",
  },
  projectRef: (id) => "project " + id,
  helperRef: (id) => "helper " + id,
  archiveRef: (name) => "archive " + name,
};

export const gatewayWording = localized({ zh, en });
