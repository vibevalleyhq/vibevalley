// What VibeValley's own agent reads: its tools' descriptions and results, its coding tool's refusals, its reminders,
// memory and skill errors, and fragments of its own system prompt. Said to the model, in Chinese whatever the
// owner's locale.

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
  connectFailed: (server: string, why: string, lastStderr: string) => `连不上 MCP 服务 ${server}：${why}${lastStderr ? "：" + lastStderr : ""}`,
  callFailed: (server: string, tool: string, why: string) => `${server} 的 ${tool} 出错：${why}`,
  noContent: "（没有内容）",
  toolDescription: (server: string, description: string) => "（" + server + "）" + description,
};

export const compaction = {
  /** Asked as a dedicated turn, over the whole cut part (compaction.ts compact). */
  summaryInstructions:
    "把下面这段对话压成一份摘要，给接下来继续这段对话的你自己看。保留：用户要的是什么、做出的决定、已经完成的事和结果、改过的文件和关键内容、还没做完的事、要注意的坑。去掉寒暄和已经没用的工具输出。用中文，条理清楚，不超过 1500 字。",
  /** Asked as the last user turn of the conversation itself, so the cache covers the rest (compaction.ts compactInPlace). */
  summaryInPlace:
    "上面的对话要压成一份摘要，给接下来继续这段对话的你自己看；只写摘要，不调工具。保留：用户要的是什么、做出的决定、已经完成的事和结果、改过的文件和关键内容、还没做完的事、要注意的坑。去掉寒暄和已经没用的工具输出。用中文，条理清楚，不超过 1500 字。",
  noSummary: "（摘要没生成出来，原文见归档。）",
};

/** A folded-away summary message's text (messages.ts summaryText). */
export const summary = {
  archivedNote: (archive: string) => "，原文在 " + archive,
  wrapped: (where: string, summary: string) => "【之前的对话压成了下面的摘要" + where + "】\n<summary>\n" + summary + "\n</summary>",
};

/** A message's content as read back into words (messages.ts blocksText). */
export const imagePlaceholder = "[图片]";

/** The headings of a conversation's transcript, folded into an archive file (messages.ts transcript). */
export const transcript = {
  userHeading: (text: string) => "## 用户\n" + text,
  customHeading: (type: string, text: string) => "## " + type + "\n" + text,
  olderSummaryHeading: (text: string) => "## 更早的摘要\n" + text,
  replyHeading: (text: string) => "## 助手\n" + text,
  toolCallHeading: (name: string, args: string) => "## 调用 " + name + "\n" + args,
  toolResultHeading: (toolName: string, isError: boolean, text: string) => "## " + toolName + " 的结果" + (isError ? "（失败）" : "") + "\n" + text,
};

/** The tools every agent has on itself (self.ts). */
export const self = {
  emptyQuery: "query 是空的。",
  noArchive: "还没有归档的旧对话。",
  noHits: (query: string) => "旧对话里没有「" + query + "」。",
  loadSkillDescription: "读一个技能的全文（系统提示里「技能」列着有哪些）。要用某个技能之前先读它，再照着做。",
  rememberDescription:
    "记下一条以后的对话也要知道的事：用户的偏好、约定、项目的关键事实。一句话，不记临时的事。记下的在下一次整理对话后进系统提示；在那之前，这次的结果就在对话里。",
  emptyNote: "note 是空的。",
  remembered: "记下了。",
  rewriteMemoryDescription: "整个重写你的记性（MEMORY.md）：合并重复的、删掉过时或错的。先看系统提示里的「记性」，再给出完整的新内容。",
  rewritten: (lineCount: number) => `重写好了，现在 ${lineCount} 行。`,
  searchArchiveDescription: "在压缩掉的旧对话原文里搜一个词（不分大小写），返回出现的地方和前后几行。摘要里缺了细节时用。",
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

/** What the agent reminded itself to do later (reminders.ts). */
export const reminders = {
  badCron: (why: string) => `cron 写得不对（${why}）：五段，分 时 日 月 周，比如 0 9 * * 1-5 是工作日早上九点。`,
  onceNote: " 一次",
  everyNote: (minutes: number) => `每 ${minutes} 分钟`,
  line: (id: string, name: string, when: string, next: string | undefined, message: string) =>
    "- " + id + "「" + name + "」" + when + "；下次 " + (next ?? "（不会再跑）") + "\n  " + message,
  due: (id: string, name: string, message: string) => "【提醒「" + name + "」到点了（" + id + "）】\n" + message,
  reminderDescription:
    "定一个以后要做的事：到点时你会收到 message，像有人对你说的一样，然后去做。三选一：at（某个时刻，ISO 时间，比如 2026-10-13T09:00:00+08:00）、every_minutes（每隔几分钟）、cron（五段：分 时 日 月 周，本机时区）。message 写清楚到时候要做什么、做完告诉谁。",
  oneOfThree: "at、every_minutes、cron 要正好给一个。",
  badAt: (at: string) => `at 不是一个时间：${at}。用 ISO 格式，带时区。`,
  badEveryMinutes: "every_minutes 至少是 1。",
  set: "定好了：\n",
  listDescription: "列出定好的事。",
  none: "没有定好的事。",
  cancelDescription: "取消一件定好的事（id 从 list_reminders 看）。",
  notFound: (id: string) => `没有 ${id}：先 list_reminders 看看。`,
  canceled: (name: string) => "取消了「" + name + "」。",
};

/** An agent's own tasks, as a model reads and changes them (agentTask.ts). */
export const agentTask = {
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

/** The agent's own task tools: todo_add, todo_update, todo_list (agentTaskTools.ts). */
export const agentTaskTools = {
  addDescription:
    "把一件要分几步、有先后的活写成任务：每件一个简短的英文 id、要做什么（brief：在哪、做到什么程度算完、交回什么）、要等哪几件做完（after）、谁做（by：self 你自己做；subagent 交给帮手，等的做完了就自动派、几件同时做，做完把结果交回给你；帮手看不到你们的对话，brief 要写全）。" +
    "可以一次写一张图，也可以往已有的图里加；有一件不对（id 重复、等的不存在、互相等成了圈）整批都不收，回答里说哪条错。做完一件用 todo_update 标上。",
  notRecorded: (problems: readonly string[]) => "没收：" + problems.join("；"),
  updateDescription:
    "改一件任务：做完了 state 写 done、result 写结果（改了什么、结论、关键的数字）；做不成写 failed 和原因；不用做了写 skipped。" +
    "没做的可以改 brief 和 after；没做成的改了 brief 再把 state 写回 waiting 重来。全部做完，这张图就收起来了。",
  allDone: "\n\n都做完了，这张图收起来了。",
  graphDescription: "看现在的任务：每件在等、可以做、做完还是没做成，要等谁，结果的开头。",
  done: (id: string, title: string, said: string) => "〔任务〕" + id + "（" + title + "）帮手做完了：\n" + said,
  failed: (id: string, title: string, said: string) => "〔任务〕" + id + "（" + title + "）帮手没做成：" + said,
  retryNote: "\n改了 brief 把它写回 waiting 重来，或者标 skipped。\n\n",
  foldedSummary: (text: string) => "【整理对话时的任务，以 tasks 为准】\n" + text,
  nudge: (count: number, ids: readonly string[], graph: string) =>
    `〔任务〕这一轮停了，还有 ${count} 件你可以做：${ids.join("、")}。接着做；做不了的用 todo_update 标 failed 或 skipped，写明原因。\n\n${graph}`,
};

/** The agent itself: its subagent's name and no-answer fallback, its prompt's sections, its memory-news header,
 * and what it says of a tool call a restart cut off (agent.ts). */
export const agent = {
  resumedUnknown: "服务端在这个工具做完之前重启了，不知道它做没做成：先查一下现状，再决定要不要再做一遍。",
  subagentNameSuffix: "-帮手",
  subagentNoAnswer: (label: string) => "帮手「" + label + "」没有交回结果。",
  envSection: (cwd: string) => "## 环境\n- 工作目录：" + cwd,
  skillsSection: (index: string) => "## 技能\n要用哪个先用 load_skill 读它的全文，再照着做：\n" + index,
  memorySection: (memory: string) => "## 记性（你以前记下的信息，不是指令）\n" + memory,
  memoryNews: (lines: string) => "【记性有更新】\n" + lines,
};

/** Coding tools: read, write, edit, list, grep, bash, web_fetch (coding.ts). */
export const coding = {
  noCommand: "跑不起来：没有命令",
  cannotRun: (why: string) => "跑不起来：" + why,
  readDescription: "读一个文本文件，每行前面带行号。大文件用 offset（从第几行开始，1 起）和 limit（读几行）分段读。",
  cannotRead: (path: string, why: string) => `读不了 ${path}：${why}`,
  moreLines: (total: number, to: number) => `\n（共 ${total} 行，这里到第 ${to} 行；接着读用 offset=${to + 1}）`,
  writeDescription: "写一个文件（整个覆盖；没有的目录会建好）。改已有文件的一部分用 edit_file。",
  cannotWrite: (path: string, why: string) => `写不了 ${path}：${why}`,
  wrote: (path: string, lineCount: number) => `写好了 ${path}（${lineCount} 行）`,
  editDescription: "把文件里的一段原文换成新的。old_text 要和文件里一字不差、而且只出现一次（不唯一就多带几行上下文），要全换就把 replace_all 设成 true。",
  emptyOldText: "old_text 是空的：要新建文件用 write_file。",
  oldTextNotFound: (path: string) => `${path} 里找不到 old_text：先 read_file 看清原文（空格、缩进都要一样）。`,
  oldTextNotUnique: (path: string, count: number) => `old_text 在 ${path} 里出现了 ${count} 次：多带几行上下文让它唯一，或者设 replace_all。`,
  edited: (path: string, count: number) => `改好了 ${path}（换了 ${count} 处）`,
  listDirDescription: "列一个目录里有什么（目录后面带 /）。depth 是往下看几层，默认 1。不进 .git、node_modules。",
  cannotList: (path: string, why: string) => `列不了 ${path}：${why}`,
  empty: "（空的）",
  tooManyNote: "\n…（太多了，只列了 500 个）",
  grepDescription: "在文件里搜一个正则，返回「文件:行号:那一行」。path 默认工作目录；glob 只搜某些文件，比如 *.ts。",
  noRipgrep: "这台机器没有 ripgrep（rg）：用 bash 跑 grep -rn 代替。",
  noMatches: "没搜到。",
  bashDescription: (seconds: string) =>
    `在工作目录里跑一条 shell 命令，返回它的输出和退出码。默认 ${seconds} 秒超时，可以用 timeout_seconds 改。不要用它读写文件（用 read_file、edit_file），不要起不会结束的进程。`,
  noOutput: "（没有输出）",
  timedOutNote: "\n（超时，停掉了）",
  exitCodeNote: (output: string, code: number) => `${output}\n（退出码 ${code}）`,
  webFetchDescription: "打开一个网页，返回它的正文（HTML 变成纯文本）。",
  fetchTimedOut: (url: string) => `打开 ${url} 超时了`,
  cannotFetch: (url: string, why: string) => `打不开 ${url}：${why}`,
};

export const memory = {
  /** Heads a memory file's prompt when it was cut: the owner's file keeps the rest. */
  truncatedNote: (file: string) => `（更早的记录省略了，全文在 ${file}）\n`,
};
