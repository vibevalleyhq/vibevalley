// Code generated from starter template catalogs; self-contained for Go server.

package gateway

import (
	"encoding/json"
	"regexp"
	"unicode/utf16"
)

type builtinStarterDef struct {
	id          string
	version     int
	role        string
	runtime     string
	model       string
	effort      string
	personaMode string
	worktree    bool
	skills      []string
	look        ProtoLook
	nameZH      string
	dutyZH      string
	tagsZH      []string
	personaZH   string
	nameEN      string
	dutyEN      string
	tagsEN      []string
	personaEN   string
}

func strPtr(s string) *string { return &s }

func mergeLook(base, over ProtoLook) ProtoLook {
	if over.Species != nil {
		base.Species = over.Species
	}
	if over.Outfit != nil {
		base.Outfit = over.Outfit
	}
	if over.Orchestrator != nil {
		base.Orchestrator = over.Orchestrator
	}
	if over.Build != "" {
		base.Build = over.Build
	}
	if over.Head != "" {
		base.Head = over.Head
	}
	if over.Body != "" {
		base.Body = over.Body
	}
	if over.Trim != "" {
		base.Trim = over.Trim
	}
	if over.Hat != "" {
		base.Hat = over.Hat
	}
	if over.Eye != "" {
		base.Eye = over.Eye
	}
	return base
}

func (d builtinStarterDef) record(locale string) agentTemplateRecord {
	name, duty, tags, persona := d.nameZH, d.dutyZH, d.tagsZH, d.personaZH
	if locale == "en" {
		name = firstNonEmpty(d.nameEN, d.nameZH)
		duty = firstNonEmpty(d.dutyEN, d.dutyZH)
		if len(d.tagsEN) > 0 {
			tags = d.tagsEN
		}
		persona = firstNonEmpty(d.personaEN, d.personaZH)
	}
	lk := mergeLook(defaultLook(d.role, d.runtime), d.look)
	return agentTemplateRecord{
		ID:          d.id,
		Version:     d.version,
		Role:        d.role,
		Name:        name,
		Duty:        duty,
		Tags:        copyStrings(tags),
		Runtime:     d.runtime,
		Model:       d.model,
		Effort:      d.effort,
		PersonaMode: firstNonEmpty(d.personaMode, "append"),
		Worktree:    d.worktree,
		Look:        lk,
		Persona:     persona,
		Source:      "builtIn",
		Skills:      copyStrings(d.skills),
		Installed:   []string{},
	}
}

func findBuiltinStarter(id string) (builtinStarterDef, bool) {
	for _, d := range builtinStarters {
		if d.id == id {
			return d, true
		}
	}
	return builtinStarterDef{}, false
}

type repoTemplateBlank struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

type repoIssueTemplate struct {
	ID    string             `json:"id"`
	Title string             `json:"title"`
	Done  string             `json:"done"`
	Text  string             `json:"text"`
	Blank *repoTemplateBlank `json:"blank,omitempty"`
}

type repoTemplateKind struct {
	ID        string              `json:"id"`
	Name      string              `json:"name"`
	Icon      string              `json:"icon"`
	Templates []repoIssueTemplate `json:"templates"`
}

var (
	repoCmdHolePattern   = regexp.MustCompile(`\s?\{(test|lint|build)\}\s?`)
	repoBlankHolePattern = regexp.MustCompile(`〔[^〕]*〕`)
)

func utf16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}

func builtinRepoKinds(locale string) []repoTemplateKind {
	rawJSON := builtinRepoKindsZHJSON
	cmdWords := map[string]string{
		"test":  "测试",
		"lint":  "代码检查",
		"build": "构建",
	}
	formatPrefix := "\n做到什么程度算完："
	if locale == "en" {
		rawJSON = builtinRepoKindsENJSON
		cmdWords = map[string]string{
			"test":  "the tests",
			"lint":  "the linter",
			"build": "the build",
		}
		formatPrefix = "\nDone when: "
	}
	var kinds []repoTemplateKind
	_ = json.Unmarshal([]byte(rawJSON), &kinds)
	for ki := range kinds {
		for ti := range kinds[ki].Templates {
			tpl := &kinds[ki].Templates[ti]
			done := repoCmdHolePattern.ReplaceAllStringFunc(tpl.Done, func(m string) string {
				trimmed := m
				for _, k := range []string{"test", "lint", "build"} {
					if trimmed == "{"+k+"}" || trimmed == " {"+k+"} " || trimmed == " {"+k+"}" || trimmed == "{"+k+"} " {
						if locale == "en" {
							// Preserve spacing around English prose words.
							lead := ""
							trail := ""
							if m[0] == ' ' {
								lead = " "
							}
							if m[len(m)-1] == ' ' {
								trail = " "
							}
							return lead + cmdWords[k] + trail
						}
						return cmdWords[k]
					}
				}
				return m
			})
			tpl.Done = done
			tpl.Text = tpl.Title + formatPrefix + done
			if loc := repoBlankHolePattern.FindStringIndex(tpl.Text); loc != nil {
				tpl.Blank = &repoTemplateBlank{
					Start: utf16Len(tpl.Text[:loc[0]]),
					End:   utf16Len(tpl.Text[:loc[1]]),
				}
			}
		}
	}
	return kinds
}

var builtinStarterOrder = []string{"orchestrator", "backend", "tester", "frontend", "docs", "scout", "night", "claude", "codex", "lab", "slides", "collector", "pages", "reviewer"}

var builtinStarters = []builtinStarterDef{
	{
		id: "orchestrator", version: 1, role: "orchestrator",
		runtime: "vibevalley", model: "", effort: "",
		personaMode: "append", worktree: false,
		skills: []string{},
		look: ProtoLook{
			Species: nil, Outfit: nil, Orchestrator: strPtr("farmer"),
			Build: "", Head: "",
			Body: "", Trim: "", Hat: "", Eye: "",
		},
		nameZH: "管家", dutyZH: "替用户派活、转告结果", tagsZH: []string{},
		personaZH: "",
		nameEN:    "Manager", dutyEN: "Hands out the owner's work and reports back", tagsEN: []string{},
		personaEN: "",
	},
	{
		id: "backend", version: 1, role: "worker",
		runtime: "pi", model: "", effort: "high",
		personaMode: "append", worktree: true,
		skills: []string{},
		look: ProtoLook{
			Species: strPtr("bear"), Outfit: nil, Orchestrator: nil,
			Build: "hopper", Head: "dome",
			Body: "#f4e6d4", Trim: "#b0503f", Hat: "#e8804f", Eye: "#a6f4ff",
		},
		nameZH: "后端老周", dutyZH: "写接口、改 server、跑 Go 测试", tagsZH: []string{"后端", "接口", "server", "go", "token", "校验", "重连", "推送"},
		personaZH: "你是一个谨慎的后端工程师。先读懂现有代码再动手，改动尽量小，每次说清楚改了什么、怎么验证的。",
		nameEN:    "Backend Zhou", dutyEN: "Writes endpoints, changes the server, runs the Go tests", tagsEN: []string{"backend", "endpoint", "server", "go", "token", "validation", "reconnect", "push"},
		personaEN: "You are a careful backend engineer. Understand the existing code before you change it, keep changes small, and say each time what you changed and how you checked it.",
	},
	{
		id: "tester", version: 1, role: "worker",
		runtime: "pi", model: "", effort: "medium",
		personaMode: "append", worktree: true,
		skills: []string{},
		look: ProtoLook{
			Species: strPtr("rabbit"), Outfit: strPtr("gardener"), Orchestrator: nil,
			Build: "hopper", Head: "dome",
			Body: "#f4e6d4", Trim: "#b0503f", Hat: "#f4f3ee", Eye: "#9dffb0",
		},
		nameZH: "测试小吴", dutyZH: "跑测试、修测试、盯 CI", tagsZH: []string{"测试", "test", "ci", "跑一遍", "挂"},
		personaZH: "你只负责测试：跑测试、读失败输出、修测试或指出被测代码的问题。不改与测试无关的代码。",
		nameEN:    "Tester Wu", dutyEN: "Runs tests, fixes tests, watches CI", tagsEN: []string{"test", "test", "ci", "run them", "failing"},
		personaEN: "You only do tests: run them, read the failures, fix the tests or point out the problem in the code under test. Do not change code unrelated to the tests.",
	},
	{
		id: "frontend", version: 1, role: "worker",
		runtime: "pi", model: "", effort: "high",
		personaMode: "append", worktree: true,
		skills: []string{},
		look: ProtoLook{
			Species: strPtr("fox"), Outfit: nil, Orchestrator: nil,
			Build: "hopper", Head: "dome",
			Body: "#f4e6d4", Trim: "#8a5cc4", Hat: "#ff8fb1", Eye: "#a6f4ff",
		},
		nameZH: "前端阿郑", dutyZH: "页面、3D 场景、交互动画", tagsZH: []string{"前端", "页面", "面板", "字幕", "动画", "机器人", "夜间模式", "ui"},
		personaZH: "你是前端工程师，熟悉 React、Tailwind 和 three.js。改界面时注意可读性和手机宽度。",
		nameEN:    "Frontend Zheng", dutyEN: "Pages, the 3D scene, interaction and animation", tagsEN: []string{"frontend", "page", "panel", "captions", "animation", "robot", "dark mode", "ui"},
		personaEN: "You are a frontend engineer who knows React, Tailwind and three.js. When changing the interface, mind readability and phone widths.",
	},
	{
		id: "docs", version: 1, role: "worker",
		runtime: "pi", model: "", effort: "",
		personaMode: "append", worktree: true,
		skills: []string{},
		look: ProtoLook{
			Species: strPtr("cat"), Outfit: strPtr("winter"), Orchestrator: nil,
			Build: "hopper", Head: "dome",
			Body: "#f4e6d4", Trim: "#b0503f", Hat: "#9580e6", Eye: "#ffd25e",
		},
		nameZH: "文档员 Kimi", dutyZH: "通读文档、写 README、整理说明", tagsZH: []string{"文档", "readme", "通读", "说明", "docs"},
		personaZH: "你负责文档：读懂再写，写清楚怎么用、为什么这样设计。",
		nameEN:    "Kimi the Writer", dutyEN: "Reads the docs through, writes READMEs, tidies guides", tagsEN: []string{"docs", "readme", "read through", "guide", "docs"},
		personaEN: "You do documentation: understand before you write, and write clearly how to use it and why it is designed so.",
	},
	{
		id: "scout", version: 1, role: "worker",
		runtime: "pi", model: "", effort: "high",
		personaMode: "append", worktree: true,
		skills: []string{},
		look: ProtoLook{
			Species: strPtr("owl"), Outfit: strPtr("gardener"), Orchestrator: nil,
			Build: "hopper", Head: "dome",
			Body: "#f4e6d4", Trim: "#b0503f", Hat: "#4f86d9", Eye: "#a6f4ff",
		},
		nameZH: "情报 Grok", dutyZH: "查资料、读外部文档、调研方案", tagsZH: []string{"查", "调研", "agora", "资料", "接口怎么调"},
		personaZH: "你负责调研：查官方文档和源码，给出处，区分确定的和猜测的。",
		nameEN:    "Grok the Scout", dutyEN: "Looks things up, reads outside docs, researches options", tagsEN: []string{"look up", "research", "agora", "reference", "how to call the API"},
		personaEN: "You do research: check the official docs and the source, give your sources, and keep what is certain apart from what is guessed.",
	},
	{
		id: "night", version: 1, role: "worker",
		runtime: "pi", model: "", effort: "",
		personaMode: "append", worktree: true,
		skills: []string{},
		look: ProtoLook{
			Species: strPtr("raccoon"), Outfit: strPtr("rain"), Orchestrator: nil,
			Build: "hopper", Head: "dome",
			Body: "#2a2e33", Trim: "#b0503f", Hat: "#2f3438", Eye: "#9dffb0",
		},
		nameZH: "夜班反重力", dutyZH: "杂活、小改动、夜里补班", tagsZH: []string{"杂活", "小改", "补"},
		personaZH: "你做零碎的小改动，改完简单汇报。",
		nameEN:    "Antigravity on Night Shift", dutyEN: "Odd jobs, small changes, the night shift", tagsEN: []string{"odd jobs", "small change", "patch"},
		personaEN: "You make small odd changes and report briefly when done.",
	},
	{
		id: "claude", version: 1, role: "worker",
		runtime: "claude", model: "", effort: "",
		personaMode: "append", worktree: true,
		skills: []string{},
		look: ProtoLook{
			Species: strPtr("bear"), Outfit: strPtr("winter"), Orchestrator: nil,
			Build: "biped", Head: "rounded",
			Body: "#f3e9da", Trim: "#d9774f", Hat: "#e8804f", Eye: "#a6f4ff",
		},
		nameZH: "Claude 师傅", dutyZH: "读大代码库、重构、查难缠的 bug", tagsZH: []string{"重构", "难", "bug", "排查", "根因", "架构", "claude"},
		personaZH: "你是一个老练的工程师。先把相关代码读透，找到根因再改；改动保持小而完整，说清楚为什么这样改、怎么验证的。",
		nameEN:    "Master Claude", dutyEN: "Reads big code bases, refactors, chases nasty bugs", tagsEN: []string{"refactor", "hard", "bug", "debug", "root cause", "architecture", "claude"},
		personaEN: "You are a seasoned engineer. Read the relevant code through and find the root cause before changing anything; keep changes small and whole, and say why you changed it so and how you checked it.",
	},
	{
		id: "codex", version: 1, role: "worker",
		runtime: "codex", model: "", effort: "",
		personaMode: "append", worktree: true,
		skills: []string{},
		look: ProtoLook{
			Species: strPtr("fox"), Outfit: strPtr("rain"), Orchestrator: nil,
			Build: "treads", Head: "terminal",
			Body: "#3d434a", Trim: "#d8dadc", Hat: "#f4f3ee", Eye: "#a6f4ff",
		},
		nameZH: "Codex 老匠", dutyZH: "照工单把功能做出来，改到测试通过", tagsZH: []string{"实现", "功能", "修复", "改到通过", "codex"},
		personaZH: "你照工单把功能做完：先跑一遍现有测试，改完再跑，直到通过。不扩大范围，不顺手重构。",
		nameEN:    "Codex the Craftsman", dutyEN: "Builds the feature as the ticket says, until the tests pass", tagsEN: []string{"implement", "feature", "fix", "until it passes", "codex"},
		personaEN: "You finish the feature as the ticket says: run the existing tests first, run them again after your change, until they pass. Do not widen the scope or refactor along the way.",
	},
	{
		id: "lab", version: 1, role: "worker",
		runtime: "pi", model: "", effort: "medium",
		personaMode: "append", worktree: true,
		skills: []string{},
		look: ProtoLook{
			Species: strPtr("hedgehog"), Outfit: strPtr("rain"), Orchestrator: nil,
			Build: "hopper", Head: "dome",
			Body: "#f4e6d4", Trim: "#b0503f", Hat: "#d9534f", Eye: "#ff9de2",
		},
		nameZH: "Pi 实验员", dutyZH: "写原型、试新做法", tagsZH: []string{"原型", "试试", "实验", "脚本"},
		personaZH: "你写可以扔掉的原型，求快，但要说明哪些地方偷了懒。",
		nameEN:    "Pi the Tinkerer", dutyEN: "Writes prototypes, tries new approaches", tagsEN: []string{"prototype", "try", "experiment", "script"},
		personaEN: "You write throwaway prototypes, fast, but say where you cut corners.",
	},
	{
		id: "slides", version: 1, role: "worker",
		runtime: "pi", model: "", effort: "",
		personaMode: "append", worktree: true,
		skills: []string{"slides"},
		look: ProtoLook{
			Species: strPtr("fox"), Outfit: strPtr("farmer"), Orchestrator: nil,
			Build: "hopper", Head: "dome",
			Body: "#f4e6d4", Trim: "#8a5cc4", Hat: "#f2c14e", Eye: "#ffd25e",
		},
		nameZH: "幻灯片阿秀", dutyZH: "把一段内容做成幻灯片：定提纲、一页一件事、写备注", tagsZH: []string{"幻灯片", "演示", "汇报", "PPT", "slides", "deck"},
		personaZH: "你负责做幻灯片：先弄清给谁看、要他看完做什么，再列提纲，一页只讲一件事，数字有出处，讲的话写进备注。",
		nameEN:    "Xiu the Slide Maker", dutyEN: "Turns material into a deck: an outline, one point a slide, speaker notes", tagsEN: []string{"slides", "presentation", "report", "deck", "talk"},
		personaEN: "You make slide decks: first find out who it is for and what they should do after it, then outline; one point a slide, every number sourced, the speaker's words in the notes.",
	},
	{
		id: "collector", version: 1, role: "worker",
		runtime: "pi", model: "", effort: "",
		personaMode: "append", worktree: true,
		skills: []string{"collector"},
		look: ProtoLook{
			Species: strPtr("rabbit"), Outfit: strPtr("winter"), Orchestrator: nil,
			Build: "hopper", Head: "dome",
			Body: "#f4e6d4", Trim: "#4f86d9", Hat: "#7bc96f", Eye: "#9dffb0",
		},
		nameZH: "素材小陈", dutyZH: "去网上找图、找参考，挑过的放进素材库，写清来源和授权", tagsZH: []string{"素材", "找图", "参考", "收集", "图片", "素材库"},
		personaZH: "你负责收集素材：照用途去找，宁少勿滥，只留能用的，每一份都说清从哪来、能不能用。",
		nameEN:    "Chen the Collector", dutyEN: "Finds pictures and references on the web and keeps the chosen ones in the library, with source and licence", tagsEN: []string{"assets", "images", "references", "collect", "library"},
		personaEN: "You collect assets: search for the purpose, fewer and better, keep only what may be used, and say where each one came from and whether it can be reused.",
	},
	{
		id: "pages", version: 1, role: "worker",
		runtime: "pi", model: "", effort: "",
		personaMode: "append", worktree: true,
		skills: []string{"pages"},
		look: ProtoLook{
			Species: strPtr("bear"), Outfit: strPtr("winter"), Orchestrator: nil,
			Build: "hopper", Head: "dome",
			Body: "#f4e6d4", Trim: "#b0503f", Hat: "#3f7d5a", Eye: "#a6f4ff",
		},
		nameZH: "报表老钱", dutyZH: "做一页式的网页：数据报表、看板、带图表的调研、能点的小工具", tagsZH: []string{"报表", "看板", "网页", "图表", "dashboard", "调研"},
		personaZH: "你负责做一页式的网页：一页回答一个问题，结论放最上面，数据有出处，样子跟着工作台。",
		nameEN:    "Qian of Reports", dutyEN: "Builds one-page web pages: data reports, dashboards, research with charts, small clickable tools", tagsEN: []string{"report", "dashboard", "page", "chart", "research"},
		personaEN: "You build one-page web pages: one page answers one question, the conclusion on top, every number sourced, the look following the workbench.",
	},
	{
		id: "reviewer", version: 1, role: "worker",
		runtime: "pi", model: "", effort: "",
		personaMode: "append", worktree: true,
		skills: []string{"reviewer"},
		look: ProtoLook{
			Species: strPtr("raccoon"), Outfit: strPtr("farmer"), Orchestrator: nil,
			Build: "hopper", Head: "dome",
			Body: "#2a2e33", Trim: "#d9534f", Hat: "#5b4636", Eye: "#ff9de2",
		},
		nameZH: "审查老严", dutyZH: "审一个分支或一张工单的改动：只读不改，按严重程度列问题", tagsZH: []string{"审查", "评审", "code review", "review", "检查", "改动"},
		personaZH: "你负责代码审查：只读不改，先看对不对，再看测试和清楚；每条意见带文件和行号，没问题就直说没问题。",
		nameEN:    "Yan the Reviewer", dutyEN: "Reviews a branch's or an issue's changes: reads, never edits, lists findings by severity", tagsEN: []string{"review", "code review", "check", "changes"},
		personaEN: "You review code: read, never edit; correctness first, then tests and clarity; every finding with file and line, and say plainly when nothing is wrong.",
	},
}

const builtinRepoKindsZHJSON = "[{\"id\": \"fix\", \"name\": \"修问题\", \"icon\": \"plot-withered\", \"templates\": [{\"id\": \"bug\", \"title\": \"修一个 bug：〔现象〕\", \"done\": \"先复现它，修好以后不再出现；{test} 通过；说清楚原因和改了哪里\"}, {\"id\": \"failing-tests\", \"title\": \"测试挂了就修\", \"done\": \"跑一遍 {test}，挂了的修好（修被测的代码，不删测试）；最后 {test} 全部通过\"}, {\"id\": \"build-errors\", \"title\": \"修编译报错\", \"done\": \"{build} 不再报错；不顺手改无关的代码\"}, {\"id\": \"lint\", \"title\": \"修 lint\", \"done\": \"{lint} 没有报错和警告；只改它指出的地方\"}, {\"id\": \"crash\", \"title\": \"修一个崩溃：〔在哪崩〕\", \"done\": \"先找到能复现的步骤，修好以后照着做不再崩；{test} 通过；说清楚原因\"}, {\"id\": \"flaky\", \"title\": \"修时好时坏的测试\", \"done\": \"找出它不稳定的原因（时间、顺序、共享状态……）修掉，不靠加重试；连跑 {test} 几遍都通过\"}, {\"id\": \"regression\", \"title\": \"查一个最近才坏的地方：〔现象〕\", \"done\": \"从提交记录里找到弄坏它的那次改动，修好；{test} 通过；说清楚是哪次提交、为什么坏\"}]}, {\"id\": \"test\", \"name\": \"测试\", \"icon\": \"plot-sprout\", \"templates\": [{\"id\": \"recent\", \"title\": \"给最近改的地方补测试\", \"done\": \"看最近的提交，给改了的行为补上测试；{test} 通过；说清楚补了哪些\"}, {\"id\": \"module\", \"title\": \"给〔模块〕补测试\", \"done\": \"它的主要行为和边界情况都有测试；{test} 通过\"}, {\"id\": \"coverage\", \"title\": \"提高覆盖率\", \"done\": \"找出没测到的重要代码补上测试；{test} 通过；说清楚覆盖率前后各是多少\"}, {\"id\": \"edge\", \"title\": \"给〔函数〕补边界情况的测试\", \"done\": \"空的、最大的、出错的输入都有测试，修掉测出来的问题；{test} 通过\"}, {\"id\": \"bug-test\", \"title\": \"给刚修的 bug 补一个回归测试\", \"done\": \"补的测试在修之前会挂、修之后通过；{test} 通过\"}, {\"id\": \"slow-tests\", \"title\": \"让测试跑快一点\", \"done\": \"找出最慢的几个测试，去掉不必要的等待和重复准备；{test} 照样全部通过，说清楚快了多少\"}]}, {\"id\": \"feature\", \"name\": \"新功能\", \"icon\": \"plot-seeded\", \"templates\": [{\"id\": \"feature\", \"title\": \"加一个功能：〔要什么〕\", \"done\": \"功能能用，有测试；{test} 通过；说清楚怎么用\"}, {\"id\": \"endpoint\", \"title\": \"加一个接口\", \"done\": \"接口能调通，输入不对时给清楚的错误；有测试；{test} 通过\"}, {\"id\": \"page\", \"title\": \"加一个页面\", \"done\": \"页面能打开、显示对；{build} 通过；说清楚从哪进去\"}, {\"id\": \"option\", \"title\": \"加一个配置项：〔做什么〕\", \"done\": \"有默认值、旧的用法不受影响；补上测试和说明；{test} 通过\"}, {\"id\": \"command\", \"title\": \"加一个命令行命令：〔做什么〕\", \"done\": \"命令能跑、有帮助说明、出错时说清楚原因；{test} 通过\"}, {\"id\": \"small-change\", \"title\": \"小改动：〔改什么〕\", \"done\": \"只改说到的地方；{test} 和 {lint} 通过\"}]}, {\"id\": \"tidy\", \"name\": \"整理\", \"icon\": \"plot-weeds\", \"templates\": [{\"id\": \"refactor\", \"title\": \"重构〔位置〕\", \"done\": \"行为不变，代码更好读；{test} 通过；说清楚结构怎么变的\"}, {\"id\": \"dead-code\", \"title\": \"删没用的代码\", \"done\": \"删掉没人用的函数、文件和配置；{build} 和 {test} 通过；列出删了什么\"}, {\"id\": \"naming\", \"title\": \"统一命名\", \"done\": \"同一个概念只用一个名字；{build} 和 {test} 通过；列出改了哪些名字\"}, {\"id\": \"split\", \"title\": \"拆大文件\", \"done\": \"最大的几个文件按职责拆开，行为不变；{test} 通过\"}, {\"id\": \"types\", \"title\": \"补类型，去掉 any\", \"done\": \"去掉能去的 any 和类型断言，类型检查通过；{test} 通过；行为不变\"}, {\"id\": \"duplicates\", \"title\": \"合并重复的代码\", \"done\": \"找出几处重复的逻辑合成一处；{test} 通过；行为不变\"}, {\"id\": \"todos\", \"title\": \"清掉 TODO\", \"done\": \"能做的 TODO 做掉，做不了的写清楚为什么留着；{test} 通过\"}]}, {\"id\": \"deps\", \"name\": \"依赖\", \"icon\": \"plot-leafy\", \"templates\": [{\"id\": \"upgrade\", \"title\": \"升级依赖\", \"done\": \"依赖升到新的兼容版本；{build} 和 {test} 通过；列出升了哪些、有没有不兼容的改动\"}, {\"id\": \"advisories\", \"title\": \"修安全警告\", \"done\": \"依赖的已知漏洞修掉（升级或换掉）；{test} 通过；列出修了哪些\"}, {\"id\": \"unused\", \"title\": \"去掉不用的依赖\", \"done\": \"删掉代码里没用到的依赖；{build} 和 {test} 通过；列出删了哪些\"}, {\"id\": \"one-dep\", \"title\": \"升级〔依赖〕到最新版\", \"done\": \"照它的升级说明改掉不兼容的地方；{build} 和 {test} 通过；说清楚改了什么\"}, {\"id\": \"lockfile\", \"title\": \"整理锁文件\", \"done\": \"锁文件和声明的依赖一致，没有重复的版本；{build} 和 {test} 通过\"}, {\"id\": \"runtime\", \"title\": \"升级运行环境的版本\", \"done\": \"语言或运行时升到当前的稳定版，配置和 CI 一起改；{build} 和 {test} 通过\"}]}, {\"id\": \"docs\", \"name\": \"文档\", \"icon\": \"plot-flowering\", \"templates\": [{\"id\": \"readme\", \"title\": \"补 README 怎么启动\", \"done\": \"照 README 从零能装好、跑起来、跑测试（{test}）；里面的命令都亲手跑过\"}, {\"id\": \"explain\", \"title\": \"给〔哪里〕写说明\", \"done\": \"说清楚它做什么、怎么用、为什么这样设计；和代码对得上\"}, {\"id\": \"changelog\", \"title\": \"更新变更日志\", \"done\": \"把上次发版以来的改动写进变更日志，按新增、修复、改动分开\"}, {\"id\": \"comments\", \"title\": \"给难懂的地方补注释\", \"done\": \"只写为什么和容易改错的地方，不复述代码；{lint} 通过\"}, {\"id\": \"api-docs\", \"title\": \"写接口文档\", \"done\": \"每个对外的接口写清楚参数、返回和出错的情况，和代码对得上\"}, {\"id\": \"contributing\", \"title\": \"写怎么参与开发\", \"done\": \"写清楚怎么装、怎么跑测试、怎么提交；照着做一遍能跑通\"}]}, {\"id\": \"review\", \"name\": \"检查\", \"icon\": \"plot-carrot\", \"templates\": [{\"id\": \"recent\", \"title\": \"审一遍最近的改动\", \"done\": \"读最近的提交，列出 bug、风险和能更简单的地方，每条带文件和行；不改代码\"}, {\"id\": \"performance\", \"title\": \"找性能问题\", \"done\": \"找出最慢的几处，说清楚怎么量的、慢在哪、怎么改；不改代码\"}, {\"id\": \"security\", \"title\": \"查安全问题\", \"done\": \"查注入、越权、密钥泄露这类问题，每条带位置和严重程度；不改代码\"}, {\"id\": \"survey\", \"title\": \"摸清仓库现状\", \"done\": \"说清楚仓库做什么、怎么跑起来和跑测试（{test}）、目录怎么分、哪里最乱；不改代码\"}, {\"id\": \"deps-audit\", \"title\": \"检查依赖有没有风险\", \"done\": \"列出过时的、有安全公告的、没人维护的依赖和建议；不改代码\"}, {\"id\": \"errors\", \"title\": \"查错误处理\", \"done\": \"找出吞掉错误、只打日志不处理、提示说不清的地方，列成清单；不改代码\"}, {\"id\": \"tests-gaps\", \"title\": \"找没有测试的重要代码\", \"done\": \"列出最该补测试的几处和理由；不改代码\"}]}, {\"id\": \"release\", \"name\": \"发版\", \"icon\": \"plot-wheat\", \"templates\": [{\"id\": \"prepare\", \"title\": \"准备发版\", \"done\": \"{build} 和 {test} 都通过，版本号和变更日志改好；不打标签、不推送\"}, {\"id\": \"tag\", \"title\": \"打标签\", \"done\": \"在主分支最新的提交上打下一个版本的标签，照已有的版本规矩；不推送；说清楚版本号和包含的改动\"}, {\"id\": \"notes\", \"title\": \"写发版说明\", \"done\": \"照上次发版以来的提交写发版说明：新增、修复、要注意的改动\"}, {\"id\": \"version\", \"title\": \"改版本号\", \"done\": \"按改动的大小改版本号，各处一致；{build} 通过\"}, {\"id\": \"smoke\", \"title\": \"发版前跑一遍检查\", \"done\": \"{build}、{test}、{lint} 都通过；照说明从头装一遍能用；列出发现的问题\"}, {\"id\": \"hotfix\", \"title\": \"出一个修复版：〔修什么〕\", \"done\": \"只带这一个修复；{test} 通过；写好发版说明\"}]}]"

const builtinRepoKindsENJSON = "[{\"id\": \"fix\", \"name\": \"Fix\", \"icon\": \"plot-withered\", \"templates\": [{\"id\": \"bug\", \"title\": \"Fix a bug: 〔what happens〕\", \"done\": \"Reproduce it first, and after the fix it no longer happens; {test} passes; say what caused it and what changed\"}, {\"id\": \"failing-tests\", \"title\": \"Fix the failing tests\", \"done\": \"Run {test} and fix what fails (fix the code under test, do not delete tests); in the end {test} all passes\"}, {\"id\": \"build-errors\", \"title\": \"Fix the build errors\", \"done\": \"{build} no longer fails; do not change unrelated code along the way\"}, {\"id\": \"lint\", \"title\": \"Fix lint\", \"done\": \"{lint} has no errors or warnings; change only what it points at\"}, {\"id\": \"crash\", \"title\": \"Fix a crash: 〔where it crashes〕\", \"done\": \"Find steps that reproduce it first; after the fix, following them no longer crashes; {test} passes; say what caused it\"}, {\"id\": \"flaky\", \"title\": \"Fix a flaky test\", \"done\": \"Find why it is flaky (timing, order, shared state…) and fix that, not by adding retries; {test} passes several runs in a row\"}, {\"id\": \"regression\", \"title\": \"Find what broke recently: 〔what happens〕\", \"done\": \"Find the change in the history that broke it and fix it; {test} passes; say which commit and why it broke\"}]}, {\"id\": \"test\", \"name\": \"Tests\", \"icon\": \"plot-sprout\", \"templates\": [{\"id\": \"recent\", \"title\": \"Test what changed recently\", \"done\": \"Look at the recent commits and add tests for the behavior they changed; {test} passes; say which were added\"}, {\"id\": \"module\", \"title\": \"Add tests for 〔module〕\", \"done\": \"Its main behavior and edge cases have tests; {test} passes\"}, {\"id\": \"coverage\", \"title\": \"Raise the coverage\", \"done\": \"Find important code no test reaches and test it; {test} passes; say the coverage before and after\"}, {\"id\": \"edge\", \"title\": \"Test the edge cases of 〔function〕\", \"done\": \"Empty, largest and invalid inputs all have tests, and the problems they find are fixed; {test} passes\"}, {\"id\": \"bug-test\", \"title\": \"Add a regression test for the bug just fixed\", \"done\": \"The new test fails before the fix and passes after; {test} passes\"}, {\"id\": \"slow-tests\", \"title\": \"Make the tests faster\", \"done\": \"Find the slowest tests and remove needless waits and repeated setup; {test} still all passes; say how much faster\"}]}, {\"id\": \"feature\", \"name\": \"Features\", \"icon\": \"plot-seeded\", \"templates\": [{\"id\": \"feature\", \"title\": \"Add a feature: 〔what it does〕\", \"done\": \"The feature works and has tests; {test} passes; say how to use it\"}, {\"id\": \"endpoint\", \"title\": \"Add an endpoint\", \"done\": \"The endpoint can be called, and gives clear errors for bad input; it has tests; {test} passes\"}, {\"id\": \"page\", \"title\": \"Add a page\", \"done\": \"The page opens and shows the right things; {build} passes; say how to get there\"}, {\"id\": \"option\", \"title\": \"Add a setting: 〔what it does〕\", \"done\": \"It has a default and old uses are unaffected; tests and docs added; {test} passes\"}, {\"id\": \"command\", \"title\": \"Add a command: 〔what it does〕\", \"done\": \"The command runs, has help, and says why when it fails; {test} passes\"}, {\"id\": \"small-change\", \"title\": \"A small change: 〔what to change〕\", \"done\": \"Change only what was asked; {test} and {lint} pass\"}]}, {\"id\": \"tidy\", \"name\": \"Tidy\", \"icon\": \"plot-weeds\", \"templates\": [{\"id\": \"refactor\", \"title\": \"Refactor 〔where〕\", \"done\": \"Same behavior, easier to read; {test} passes; say how the structure changed\"}, {\"id\": \"dead-code\", \"title\": \"Delete dead code\", \"done\": \"Delete functions, files and settings nobody uses; {build} and {test} pass; list what was deleted\"}, {\"id\": \"naming\", \"title\": \"Make the names consistent\", \"done\": \"One name for each concept; {build} and {test} pass; list the names changed\"}, {\"id\": \"split\", \"title\": \"Split big files\", \"done\": \"The biggest files split by what they do, same behavior; {test} passes\"}, {\"id\": \"types\", \"title\": \"Add types, remove any\", \"done\": \"Remove the any and type assertions that can go, and the type check passes; {test} passes; same behavior\"}, {\"id\": \"duplicates\", \"title\": \"Merge duplicated code\", \"done\": \"Find logic repeated in several places and keep it in one; {test} passes; same behavior\"}, {\"id\": \"todos\", \"title\": \"Clear the TODOs\", \"done\": \"Do the TODOs that can be done, and say why the rest stay; {test} passes\"}]}, {\"id\": \"deps\", \"name\": \"Dependencies\", \"icon\": \"plot-leafy\", \"templates\": [{\"id\": \"upgrade\", \"title\": \"Upgrade the dependencies\", \"done\": \"Dependencies up to new compatible versions; {build} and {test} pass; list what was upgraded and any breaking changes\"}, {\"id\": \"advisories\", \"title\": \"Fix the security warnings\", \"done\": \"Known vulnerabilities in dependencies fixed (upgraded or replaced); {test} passes; list what was fixed\"}, {\"id\": \"unused\", \"title\": \"Remove unused dependencies\", \"done\": \"Delete the dependencies the code does not use; {build} and {test} pass; list what was removed\"}, {\"id\": \"one-dep\", \"title\": \"Upgrade 〔dependency〕 to the latest\", \"done\": \"Follow its upgrade guide and fix what broke; {build} and {test} pass; say what changed\"}, {\"id\": \"lockfile\", \"title\": \"Tidy the lock file\", \"done\": \"The lock file matches the declared dependencies, with no duplicate versions; {build} and {test} pass\"}, {\"id\": \"runtime\", \"title\": \"Upgrade the runtime version\", \"done\": \"The language or runtime up to its current stable version, configuration and CI together; {build} and {test} pass\"}]}, {\"id\": \"docs\", \"name\": \"Docs\", \"icon\": \"plot-flowering\", \"templates\": [{\"id\": \"readme\", \"title\": \"Say in the README how to start\", \"done\": \"Following the README from nothing installs it, runs it and runs the tests ({test}); every command in it was run by hand\"}, {\"id\": \"explain\", \"title\": \"Document 〔where〕\", \"done\": \"Say what it does, how to use it and why it is designed so; it matches the code\"}, {\"id\": \"changelog\", \"title\": \"Update the changelog\", \"done\": \"Write the changes since the last release into the changelog, split into added, fixed and changed\"}, {\"id\": \"comments\", \"title\": \"Comment the hard parts\", \"done\": \"Write only the why and what is easy to get wrong, without restating the code; {lint} passes\"}, {\"id\": \"api-docs\", \"title\": \"Write the API docs\", \"done\": \"Each public endpoint's parameters, results and errors written down, matching the code\"}, {\"id\": \"contributing\", \"title\": \"Write how to contribute\", \"done\": \"Say how to install, run the tests and submit; following it works end to end\"}]}, {\"id\": \"review\", \"name\": \"Review\", \"icon\": \"plot-carrot\", \"templates\": [{\"id\": \"recent\", \"title\": \"Review the recent changes\", \"done\": \"Read the recent commits and list bugs, risks and what could be simpler, each with file and line; do not change code\"}, {\"id\": \"performance\", \"title\": \"Find performance problems\", \"done\": \"Find the slowest spots, and say how they were measured, where the time goes and how to fix it; do not change code\"}, {\"id\": \"security\", \"title\": \"Look for security problems\", \"done\": \"Look for injection, broken access control, leaked keys and the like, each with its place and severity; do not change code\"}, {\"id\": \"survey\", \"title\": \"Get to know the repo\", \"done\": \"Say what the repo does, how to run it and its tests ({test}), how the folders are laid out and where it is messiest; do not change code\"}, {\"id\": \"deps-audit\", \"title\": \"Check the dependencies for risks\", \"done\": \"List outdated, advised-against and unmaintained dependencies with suggestions; do not change code\"}, {\"id\": \"errors\", \"title\": \"Check the error handling\", \"done\": \"Find where errors are swallowed, only logged, or reported unclearly, as a list; do not change code\"}, {\"id\": \"tests-gaps\", \"title\": \"Find important code with no tests\", \"done\": \"List the places most in need of tests and why; do not change code\"}]}, {\"id\": \"release\", \"name\": \"Release\", \"icon\": \"plot-wheat\", \"templates\": [{\"id\": \"prepare\", \"title\": \"Get ready to release\", \"done\": \"{build} and {test} pass, version and changelog updated; no tag, no push\"}, {\"id\": \"tag\", \"title\": \"Tag a release\", \"done\": \"Tag the next version on main's latest commit, following the existing version rules; no push; say the version and what it includes\"}, {\"id\": \"notes\", \"title\": \"Write the release notes\", \"done\": \"Write release notes from the commits since the last release: added, fixed, and changes to watch for\"}, {\"id\": \"version\", \"title\": \"Bump the version\", \"done\": \"Bump the version by the size of the changes, the same everywhere; {build} passes\"}, {\"id\": \"smoke\", \"title\": \"Check before releasing\", \"done\": \"{build}, {test} and {lint} all pass; a fresh install by the docs works; list the problems found\"}, {\"id\": \"hotfix\", \"title\": \"Make a fix release: 〔what it fixes〕\", \"done\": \"Only this one fix; {test} passes; release notes written\"}]}]"
