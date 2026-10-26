// What the issues say to models: the rules a helper's job ends with (the criteria, an answer issue's, a draft's), and
// the refusal the orchestrator gets for changing an issue the owner did not ask for. In Chinese whatever the owner's
// locale: the helper answers in the owner's.

import type { Issue, Question } from "@vibevalley/protocol";

/** Changing an issue or moving it is the owner's call: the orchestrator asks for what it saw itself. */
export const needsOwner = "改工单、挪状态要主人说一声。这一轮不是主人叫你的：在频道里问主人要不要这样做。";

/** What a draft's job is matched against the profiles' tags by (chooseAgent). */
export const draftMatch = (title: string) => "起草 " + title;

export const criteriaHead =
  "验收标准（主人照这几条验收；做完逐条对照，在结论前面每条写一行「标准 N：做到了」「标准 N：没做到」或「标准 N：不确定」，后面接凭据：跑了什么命令、结果如何，或改了哪个文件）：";

export const answerOpening =
  "这一轮你只查清楚、回答问题：读代码、跑只读的命令，不改文件、不提交；干活的规矩里提交、写 commit 号的那两条，这一轮不用照做。你改了什么，交回来以后都会被清掉。";

const answerExample = {
  conclusion: "看板拖卡还在调旧的 start 接口，所以挪到已完成时没反应。",
  evidence: ["apps/web/src/pages/issues/Board.tsx:120 拖放调的是 api.issue.start", "rg 'issue.start' 只在 Board.tsx 里出现一次"],
  unsure: ["不确定命令行有没有走同一条路"],
  next: ["把拖放改成 issue.status"],
};

export const answerFormat = [
  "汇报的最后，用一个 json 代码块交结论，格式照这个：",
  "```json",
  JSON.stringify(answerExample, null, 2),
  "```",
  "conclusion 一两句说答案；evidence 是依据，至少一条：文件和行号看到了什么、跑了什么命令输出了什么；unsure 是拿不准的，next 是建议接着做的，没有就给空数组。",
].join("\n");

export const refinementOpening =
  "这一轮你只起草工单：读代码，把主人想做的事写成一张能派出去的工单，交给别的帮工去做。你不改文件、不提交；干活的规矩里提交、写 commit 号的那两条，这一轮不用照做。你改了什么，交回来以后都会被清掉。";

/** What the drafting session is told: the owner's word, the draft so far when there is one (as the owner may have edited it), and what it asked with the owner's answer. */
export function refinementBrief(
  t: Pick<Issue, "title" | "description" | "criteria"> & { readonly questions?: readonly Question[] },
  word: string,
  project: string,
): string {
  word = word.trim();
  const questions = t.questions ?? [];
  const criteria = t.criteria ?? [];
  const answering = word !== "" && questions.length > 0;
  const redraft = !!t.description || criteria.length > 0;
  const example = {
    title: "看板拖卡改用 issue.status",
    why: "看板拖卡片还在调旧的 start 接口，挪到已完成时收不了。",
    todo: ["board.dart 的拖放改调 issue.status", "删掉旧接口的调用"],
    criteria: ["把一张备选拖到待办，它开工", "flutter test test/workbench/issues_test.dart 通过"],
    notDoing: ["不改看板的样子"],
    files: ["app/lib/workbench/issues/board.dart"],
  };
  const lines = [refinementOpening, "", `项目：${project}（你现在就在它的目录里）`, "主人想做的：" + (word !== "" && !redraft ? word : t.title)];
  if (redraft) {
    lines.push("", "上一版草稿（主人可能改过，以这一版为准）：", "标题：" + t.title);
    if (t.description) lines.push(t.description);
    if (criteria.length > 0) lines.push("验收标准：", "- " + criteria.join("\n- "));
  }
  if (answering)
    lines.push("", "你上一版问主人的：", "- " + questions.map((a) => a.question).join("\n- "), "主人的回答：" + word, "", "照主人的回答再起草一版，整张重写。");
  else if (redraft && word) lines.push("", "主人这次说：" + word, "", "照主人说的再起草一版，整张重写。");
  else if (redraft) lines.push("", "再起草一版，整张重写。");
  lines.push(
    "",
    "先读代码，弄清现状，再写。写的规矩：",
    "- title：短标题，说做什么，不超过 20 个字；细节写在 why、todo 里，不写进标题。",
    "- why：为什么要做，一两句。",
    "- todo：要做的几件事，一件一条，写到改哪里。",
    "- criteria：怎么算做完，一条一个主人能照着验的点（跑什么命令、看到什么结果、页面上是什么样）。",
    "- notDoing：这张工单不做的，免得做多了；没有就给空数组。",
    "- files：可能涉及的文件或目录。",
    "- 拿不准、要主人定的，写在代码块前面，每行以「要问主人：」开头，一行问一件事，想得到的几种回答写在句末「（选项：A｜B）」；能自己查到的不要问。问了也照你最好的猜测把草稿写完整。",
    "",
    "汇报的最后，用一个 json 代码块给出草稿，格式照这个：",
    "```json",
    JSON.stringify(example, null, 2),
    "```",
    "代码块之后写一句结论：草稿写好了没有，还要问主人什么。",
  );
  return lines.join("\n");
}
