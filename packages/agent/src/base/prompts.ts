export const mcpConfig = {
  notJson: (path: string) => `${path} 不是 JSON`,
  badShape: (path: string, error: string) => `${path} 不是 JSON 或配置形状不对：${error}`,
};

export const skills = {
  noSuchSkill: (name: string, known: readonly string[]) => `没有叫 ${name} 的技能。有：${known.join("、") || "（没有）"}`,
  cannotRead: (path: string) => `读不到 ${path}`,
  body: (name: string, path: string, text: string) => "# " + name + "\n（来自 " + path + "）\n\n" + text,
  line: (name: string, description: string) => "- " + name + "：" + description,
};

export const mcp = {
  resourceBlock: "[资源]",
  connectFailed: (server: string, why: string, lastStderr: string) => `连不上 MCP 服务 ${server}：${why}${lastStderr !== "" ? "：" + lastStderr : ""}`,
  callFailed: (server: string, tool: string, why: string) => `${server} 的 ${tool} 出错：${why}`,
  noContent: "（没有内容）",
  toolDescription: (server: string, description: string) => "（" + server + "）" + description,
};

/** The tools every agent has on itself (self.ts). */
export const self = {
  loadSkillDescription: "读一个技能的全文（系统提示里「技能」列着有哪些）。要用某个技能之前先读它，再照着做。",
  rememberDescription:
    "记下一条以后的对话也要知道的事：用户的偏好、约定、仓库的关键事实。一句话，不记临时的事。记下的在下一次整理对话后进系统提示；在那之前，这次的结果就在对话里。",
  emptyNote: "note 是空的。",
  remembered: "记下了。",
  rewriteMemoryDescription: "整理你自己记下的内容：合并重复的、删掉过时或错的。先看系统提示里的「记性」，再给出完整的新内容，不改写用户交代的条目。",
  rewritten: (lineCount: number) => `重写好了，现在 ${lineCount} 行。`,
  spawnAgentDescription:
    "派一个帮手去做一件独立的事（查资料、读一片代码、改一个模块、跑一组检查），它做完把结果汇报给你。它看不到你们的对话：brief 里写清楚要做什么、在哪、做到什么程度算完、汇报什么。几件互不相干的事可以在同一步里派几个，它们会同时做。",
  emptyBrief: "brief 是空的。",
  subagentInstructions: (parent: string) =>
    "你是「" +
    parent +
    "」派出去的帮手，只做下面交代的这一件事，做完就停。\n" +
    "- 不能问问题：信息不够就按最合理的理解去做，在汇报里说明你的理解。\n" +
    "- 最后用一段话汇报：做了什么、结果是什么（要点、改过的文件、关键的数字）、没做成的和原因。你的最后一段话就是交回去的全部内容。",
};

/** An agent's own todos, as a model reads and changes them (todo.ts). */
export const todoWords = {
  duplicateId: (id: string) => "id「" + id + "」重复了",
  selfWait: (id: string) => "「" + id + "」不能等自己",
  missingAfter: (id: string, other: string) => "「" + id + "」要等的「" + other + "」不存在",
  circle: (ids: readonly string[]) => "这几件互相等，成了一个圈：" + ids.join("、"),
  noTasks: "一件任务都没有",
  invalidId: (id: string) => "「" + id + "」不能当 id：用简短的英文，比如 read、fix-auth",
  noBrief: (id: string) => "「" + id + "」没有写要做什么（brief）",
  tooMany: (max: number, count: number) => `最多 ${max} 件，这里有 ${count} 件：把小的合并，或者先做完一部分`,
  stateWords: {
    waiting: "还没做",
    working: "在做",
    done: "做完了",
    failed: "没做成",
    skipped: "跳过了",
  } as const,
  notFound: (id: string) => "没有「" + id + "」这件任务",
  cannotChangeBrief: (id: string, stateWord: string) => "「" + id + "」已经" + stateWord + "，不能再改要做什么或等谁",
  emptyBrief: "brief 是空的",
  cannotMove: (id: string, stateWord: string, toWord: string) => "「" + id + "」" + stateWord + "，不能改成" + toWord,
  problems: (problems: readonly string[]) => problems.join("；"),
  none: "现在没有任务。",
  header: (count: number, readyCount: number) => `任务（${count} 件，${readyCount} 件可以做）：`,
  canDo: "可以做",
  waitingFor: "等着",
  bySubagent: "（帮手做）",
  waitingOn: (ids: readonly string[]) => "（等 " + ids.join("、") + "）",
};

/** The agent's own todo tools: todo_add, todo_update, todo_list (todoTools.ts). */
export const todoToolWords = {
  addDescription:
    "把一件要分几步、有先后的活写成任务：每件一个简短的英文 id、要做什么（brief：在哪、做到什么程度算完、交回什么）、要等哪几件做完（after）、谁做（by：self 你自己做；subagent 交给帮手，等的做完了就自动派、几件同时做，做完把结果交回给你；帮手看不到你们的对话，brief 要写全）。" +
    "可以一次写一张图，也可以往已有的图里加；有一件不对（id 重复、等的不存在、互相等成了圈）整批都不收，回答里说哪条错。做完一件用 todo_update 标上。",
  notRecorded: (problems: readonly string[]) => "没收：" + problems.join("；"),
  updateDescription:
    "改一件任务：做完了 state 写 done、result 写结果（改了什么、结论、关键的数字）；做不成写 failed 和原因；不用做了写 skipped。" +
    "没做的可以改 brief 和 after；没做成的改了 brief 再把 state 写回 waiting 重来。全部做完，这张图就收起来了。",
  allDone: "\n\n都做完了，这张图收起来了。",
  graphDescription: "看现在的任务：每件在等、可以做、做完还是没做成，要等谁，结果的开头。",
};

export const memory = {
  /** Heads a memory file's prompt when it was cut: the user's file keeps the rest. */
  truncatedNote: (file: string) => `（更早的记录省略了，全文在 ${file}）\n`,
};
