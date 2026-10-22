import { type Issue, managerAgent, type ProjectStack, type Run } from "@vibevalley/protocol";
import { templateCatalog } from "../agent/seed.ts";
import { graphsOf } from "../task/issues.ts";
import { describe, expect, it, test } from "vite-plus/test";
import { checkCases, goldenCases } from "../testing/golden.ts";
import {
  pullRequestConclusion,
  criteriaHead,
  refinementBrief,
  refinementDescription,
  refinementOpening,
  filledKinds,
  filledTemplate,
  issueJob,
  kept,
  nextTaskId,
  parseRefinement,
  sentTitles,
  milestonesOf,
  splitJob,
} from "./rules.ts";

test("the recorded cases", () => {
  const cases = goldenCases("issue");
  expect(new Set(cases.map((c) => c.fn))).toEqual(new Set(["nextTaskID"]));
  expect(checkCases(cases, (c) => nextTaskId(graphsOf((c.in as { state: never }).state).map((g) => g.id)))).toEqual([]);
});

describe("an issue as a job", () => {
  it("title and job", () => {
    expect(splitJob("\n  写打卡  \n\n细节在 README\n还有测试\n")).toEqual(["写打卡", "细节在 README\n还有测试"]);
    expect(issueJob({ title: "写打卡", description: "细节在 README\n还有测试" })).toBe("写打卡\n\n细节在 README\n还有测试");
    expect(issueJob({ title: "只有标题" })).toBe("只有标题");
    expect(splitJob("  ")).toEqual(["", ""]);
  });

  it("a job written as one long line keeps a short title and all of it as the description", () => {
    const job = "通读 vibevalley 项目，给主人一份整体架构和当前进度的评估。1）技术栈 2）模块 3）测试 4）最该推进的三件事";
    expect(splitJob(job)).toEqual(["通读 vibevalley 项目，给主人一份整体架构和当前进度的评估", job]);
  });

  it("the story of an issue, newest first", () => {
    const issue = {
      id: "t1",
      number: 1,
      title: "评估",
      priority: "medium",
      createdAt: 100,
      sessions: ["w1"],
      status: "in_review",
      moves: [],
      acceptance: "glance",
      findings: [{ id: "f1", text: "少了测试", at: 400 }],
      questions: [{ question: "全交给 w3 还是分着做？", options: ["全交给 w3", "分着做"] }],
      attention: { state: "asking", acts: [] },
    } as Issue;
    const runs: Run[] = [
      {
        id: "r1",
        session: "w1",
        triggeredBy: { kind: "issue" },
        heard: [],
        startedAt: 200,
        endedAt: 300,
        outcome: "completed",
        summary: "写好了",
        spent: { tokens: 10, cny: 0.5 },
      },
      {
        id: "r2",
        session: "w1",
        triggeredBy: { kind: "comment" },
        heard: [],
        startedAt: 410,
        endedAt: 500,
        outcome: "completed",
        summary: "补了",
        spent: { tokens: 5 },
      },
    ];
    const { milestones, spent } = milestonesOf(issue, runs, new Map([["w1", "Claude 师傅"]]));
    expect(milestones.map((m) => [m.at, m.kind, m.who ?? "", m.text])).toEqual([
      [500, "asked", "Claude 师傅", "问你：全交给 w3 还是分着做？"],
      [410, "told", "Claude 师傅", "你带了话，接着做一轮"],
      [400, "rejected", "", "打回：少了测试"],
      [300, "reported", "Claude 师傅", "交回来了：写好了"],
      [200, "started", "Claude 师傅", "开工"],
      [100, "opened", "", "开单"],
    ]);
    expect(spent).toEqual({ tokens: 15, cny: 0.5 });
  });

  it("the job carries its criteria", () => {
    expect(issueJob({ title: "改拖卡", description: "为什么：\n旧接口", criteria: ["拖到待办就开工", "测试通过"] })).toBe(
      "改拖卡\n\n为什么：\n旧接口\n\n" + criteriaHead + "\n1. 拖到待办就开工\n2. 测试通过",
    );
  });

  it("the next task's id", () => {
    expect(nextTaskId([])).toBe("p1");
    expect(nextTaskId(["p3", "p12", "p9"])).toBe("p13");
    expect(nextTaskId(["p3", "px", "p 7 ", "p-9", "p0x10", "p1.5", "q40"])).toBe("p4");
  });
});

describe("a pull request", () => {
  it("a pull request's conclusion", () => {
    expect(pullRequestConclusion("开场白\n\n**结论：** 已完成 abc123\n第二行\n\n补充说明")).toBe("已完成 abc123\n第二行");
    const text = "完整的最后一轮回复。".repeat(20) + "\n\n最后一段";
    expect(pullRequestConclusion(text)).toBe(text);
  });
});

describe("drafts", () => {
  it("are read from the last block", () => {
    const said =
      '看过了。\n\n```json\n{"title": "旧的"}\n```\n\n要问主人：端口用哪个？\n\n```json\n' +
      `{"title": " 看板拖卡改用 issue.status ", "why": "旧接口收不了", "todo": ["改 board.dart", " "], "criteria": "拖到待办就开工", "notDoing": [], "files": ["app/lib/workbench/issues/board.dart"]}` +
      "\n```\n\n结论：写好了";
    const { draft, problem } = parseRefinement(said);
    expect(problem).toBe("");
    expect(draft!.title).toBe("看板拖卡改用 issue.status");
    expect(kept(draft!.criteria)).toEqual(["拖到待办就开工"]);
    expect(refinementDescription(draft!)).toBe("为什么：\n旧接口收不了\n\n要做的：\n- 改 board.dart\n\n可能涉及：\n- app/lib/workbench/issues/board.dart");
    for (const [said, problem] of [
      ["草稿写好了", "没找到草稿"],
      ["```json\n{title: 1}\n```", "json 读不了"],
      ['```json\n{"why": "x"}\n```', "草稿没有标题"],
      ['```json\n{"title": "x", "todo": [1]}\n```', "json 读不了"],
    ])
      expect(parseRefinement(said!).problem.startsWith(problem!)).toBe(true);
    const later = parseRefinement('```json\n{"title": "x"}\n```\n```\n不是 json\n```');
    expect([later.draft?.title, later.problem]).toEqual(["x", ""]);
  });

  it("briefs", () => {
    const first = refinementBrief({ title: "新工单" }, "看板拖卡还在调旧接口", "board");
    for (const want of [refinementOpening, "项目：board", "主人想做的：看板拖卡还在调旧接口", "```json", '"criteria"', "要问主人："])
      expect(first).toContain(want);
    expect(first).not.toContain("上一版草稿");
    const refined = {
      title: "看板拖卡改用 issue.status",
      description: "为什么：\n旧接口",
      criteria: ["拖到待办就开工"],
      questions: [{ question: "端口用哪个？" }],
    };
    const answer = refinementBrief(refined, "用 8797", "board");
    for (const want of [
      "上一版草稿",
      "标题：看板拖卡改用 issue.status",
      "为什么：\n旧接口",
      "- 拖到待办就开工",
      "你上一版问主人的：\n- 端口用哪个？",
      "主人的回答：用 8797",
    ])
      expect(answer).toContain(want);
    const again = refinementBrief({ ...refined, questions: [] }, "也改测试", "board");
    expect(again).toContain("主人这次说：也改测试");
    expect(again).not.toContain("主人的回答");
  });
});

describe("templates", () => {
  const goStack: ProjectStack = { name: "go", label: "Go", test: "go test ./...", lint: "go vet ./...", build: "go build ./..." };

  it("the catalog is well formed", () => {
    const kinds = templateCatalog();
    expect(kinds.length).toBeGreaterThan(0);
    const kindIds = new Set<string>();
    for (const k of kinds) {
      expect(k.id && k.name && k.icon.startsWith("plot-") && k.templates.length > 0 && !kindIds.has(k.id)).toBeTruthy();
      kindIds.add(k.id);
      const ids = new Set<string>();
      for (const s of k.templates) {
        expect(s.id && !ids.has(s.id) && s.title && s.done && !s.text && !s.blank).toBeTruthy();
        ids.add(s.id);
        for (const hole of (s.title + s.done).match(/\{[^}]*\}/g) ?? []) expect(["{test}", "{lint}", "{build}"]).toContain(hole);
      }
    }
  });

  it("a template is filled for the stack", () => {
    const template = { id: "x", title: "修一个 bug：〔现象〕", done: "{build} 不再报错；跑一遍 {test}，再看（{lint}）", text: "" };
    const got = filledTemplate(template, goStack);
    expect(got.done).toBe("`go build ./...` 不再报错；跑一遍 `go test ./...`，再看（`go vet ./...`）");
    expect(got.text).toBe("修一个 bug：〔现象〕\n做到什么程度算完：" + got.done);
    expect(got.blank).toEqual({ start: 8, end: 12 });
    expect(got.text.slice(got.blank!.start, got.blank!.end)).toBe("〔现象〕");
    expect(filledTemplate(template, {}).done).toBe("构建不再报错；跑一遍测试，再看（代码检查）");
    const partly = filledTemplate({ id: "", title: "测试挂了就修", done: "{build} 和 {test} 都通过", text: "" }, { name: "node", test: "bun run test" });
    expect([partly.done, partly.blank]).toEqual(["构建和 `bun run test` 都通过", undefined]);
  });

  it("every catalog template fills without holes", () => {
    for (const stack of [goStack, {}])
      for (const k of filledKinds(templateCatalog(), stack))
        for (const s of k.templates) {
          expect(/[{}]/.test(s.text)).toBe(false);
          expect(s.text).toContain("\n做到什么程度算完：");
          expect(s.title.includes("〔")).toBe(s.blank !== undefined);
        }
    expect(templateCatalog()[0]!.templates[0]!.text).toBeFalsy();
  });

  it("recent titles are the project's own sent issues", () => {
    const issue = (title: string, project: string, at: number, more: Partial<Issue> = {}) =>
      ({ title, project, createdAt: at, sessions: ["s"], ...more }) as Issue;
    const all = [
      issue("修登录", "app", 1),
      issue("  加  打卡 ", "app", 5),
      issue("修登录", "app", 4),
      issue("别的项目", "web", 9),
      issue("没派过", "app", 8, { sessions: [] }),
      issue("计划里的一步", "app", 8, { parent: "g" }),
      issue("定时", "app", 8, { recurrence: "s1" }),
      issue("给管家", "app", 8, { assignee: managerAgent }),
      issue("长".repeat(61), "app", 8),
      issue("三", "app", 3),
      issue("二", "app", 2),
      issue("零", "app", 0),
      issue("负", "app", -1),
    ];
    expect(sentTitles(all, "app")).toEqual(["加 打卡", "修登录", "三", "二", "零"]);
    expect(sentTitles(all, "none")).toEqual([]);
  });
});
