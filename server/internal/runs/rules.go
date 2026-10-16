package runs

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// The helpers' pure rules (ported from the TypeScript server's report.ts, limits.ts, briefing.ts, and the parts of recall.ts the crew
// uses; removed): what a finished turn says in words, how many may work at once, who a helper is told it is. crew.go calls
// them with what the core state and the store have. Lengths are counted as JavaScript does (UTF-16 units), so the
// farm cuts text where the TypeScript server did.

// ── A finished turn, in words (report.ts) ────────────────────────────────────

// crewSummaryMax: a report's summary on the farm is its conclusion, this long at most.
const crewSummaryMax = 160

// crewClip is text on one line, cut to max characters with an ellipsis.
func crewClip(text string, max int) string {
	flat := base.Trim(base.Spaces.ReplaceAllString(text, " "))
	if base.Units(flat) > max {
		return base.Slice(flat, 0, max-1) + "…"
	}
	return flat
}

var crewFailure = map[oar.FailureClass]string{
	oar.FailureAuth:             "登录或密钥有问题",
	oar.FailureQuota:            "额度用完了",
	oar.FailureRateLimited:      "请求太频繁，被限流了",
	oar.FailureBilling:          "余额不够了",
	oar.FailureModelUnavailable: "这个模型用不了",
	oar.FailureInputTooLarge:    "上下文太长，装不下了",
	oar.FailureInvalidRequest:   "请求被服务商拒绝了",
	oar.FailureOverloaded:       "服务商太忙",
	oar.FailureProvider:         "服务商出错了",
	oar.FailureRuntimeExited:    "runtime 进程中途退出了",
	oar.FailureUnknown:          "出错了",
}

// crewFailureText is a failed turn in words: what kind of failure, the runtime's own reason, and what would help.
func crewFailureText(f oar.TurnOutcome) string {
	advice, _ := observe.FailureAdviceOf(f.Failure)
	next := ""
	switch {
	case advice.UserAction:
		next = "要你先处理一下"
	case advice.Retry == "now":
		next = "可以让它再试一次"
	case advice.Retry == "later":
		next = "过一阵再试"
	}
	reason := base.Slice(base.Trim(base.Spaces.ReplaceAllString(f.Reason, " ")), 0, 200)
	kind, ok := crewFailure[f.Failure]
	if !ok {
		kind = crewFailure[oar.FailureUnknown]
	}
	out := kind
	if f.Status != nil {
		out += fmt.Sprintf("（HTTP %d）", *f.Status)
	}
	if reason != "" {
		out += "：" + reason
	}
	if next != "" {
		out += "。" + next
	}
	return out
}

var (
	crewBlocks     = regexp.MustCompile(`\n{2,}`)
	crewParagraphs = regexp.MustCompile(`\n[` + base.SpaceClass + `]*\n`)
	// crewVerdict is the line the farm rules ask every report to end on: 「结论：…」, perhaps bold or in a list.
	crewVerdict = regexp.MustCompile(`(?:^|\n)[` + base.SpaceClass + `>*#_-]*(?:\*\*)?结论(?:\*\*)?[` + base.SpaceClass + `]*[:：][` + base.SpaceClass + `]*(?:\*\*)?`)
)

// crewConclusion is the end of what a helper said in a turn: its last paragraphs, min characters at least.
func crewConclusion(text string, min int) string {
	blocks := crewBlocks.Split(base.Trim(text), -1)
	tail := ""
	for i := len(blocks) - 1; i >= 0 && base.Units(tail) < min; i-- {
		if tail != "" {
			tail = blocks[i] + "\n\n" + tail
		} else {
			tail = blocks[i]
		}
	}
	return tail
}

// SummaryOf is a report in a line or two: its 结论 when it wrote one, else its last paragraphs.
func SummaryOf(text string) string {
	if all := crewVerdict.FindAllStringIndex(text, -1); len(all) > 0 {
		last := all[len(all)-1]
		// The verdict's own paragraph: a note written after it is not part of it.
		rest := base.Trim(strings.ReplaceAll(text[last[1]:], "**", ""))
		if verdict := base.Trim(crewParagraphs.Split(rest, 2)[0]); verdict != "" {
			return verdict
		}
	}
	return crewConclusion(text, 80)
}

// crewNeedsYou are failures a person has to fix (sign in, top up): said out loud on the farm, not only in the report.
var crewNeedsYou = map[oar.FailureClass]bool{oar.FailureAuth: true, oar.FailureBilling: true, oar.FailureQuota: true, oar.FailureModelUnavailable: true}

func crewOutcomeOf(o oar.TurnOutcome) protocol.Outcome {
	switch o.Kind {
	case "completed":
		return protocol.OutcomeCompleted
	case "aborted":
		return protocol.OutcomeInterrupted
	}
	return protocol.OutcomeFailed
}

// crewRead is a finished turn, read: how it went, what to keep of what it said, the line for the farm.
type crewRead struct {
	Outcome protocol.Outcome
	// Text is what it said, led by why it failed when it did.
	Text    string
	Summary string
	// Failure is why it failed, in words; empty when it did not.
	Failure string
	// NeedsYou: it failed in a way a person has to fix (sign in, top up, pick a model).
	NeedsYou bool
}

func crewReadReport(outcome oar.TurnOutcome, said string) crewRead {
	r := crewRead{Outcome: crewOutcomeOf(outcome)}
	if outcome.Kind == "failed" {
		r.Failure = crewFailureText(outcome)
		r.NeedsYou = crewNeedsYou[outcome.Failure]
	}
	said = base.Trim(said)
	// A failed turn leads with why it failed; what the helper said before that follows.
	switch {
	case r.Failure != "" && said != "":
		r.Text = r.Failure + "\n\n" + said
	case r.Failure != "":
		r.Text = r.Failure
	default:
		r.Text = said
	}
	summary := r.Failure
	if summary == "" {
		summary = SummaryOf(said)
	}
	if summary == "" {
		summary = "没做完"
		if r.Outcome == protocol.OutcomeCompleted {
			summary = "做完了"
		}
	}
	r.Summary = crewClip(summary, crewSummaryMax)
	return r
}

// ── How many may work at once (limits.ts) ────────────────────────────────────

// crewLimits are the caps on helpers working at once: the farm's, the runtime asked for (0: none), the project (0: none).
type crewLimits struct {
	Farm       int
	PerRuntime int
	PerProject int
}

// crewNoRoom is why one more helper on runtime in project should not start working now, in words; "" when there is
// room. except is a helper about to work again: it does not count against itself.
func crewNoRoom(helpers []protocol.Helper, runtime, project string, limits crewLimits, except string) string {
	var busy []protocol.Helper
	for _, h := range helpers {
		if protocol.IsBusy(h) && h.ID != except {
			busy = append(busy, h)
		}
	}
	if len(busy) >= limits.Farm {
		return fmt.Sprintf("已经有 %d 个帮工在干活了", limits.Farm)
	}
	onRuntime, inProject := 0, 0
	for _, h := range busy {
		if h.Runtime == runtime {
			onRuntime++
		}
		if h.Project != nil && *h.Project == project {
			inProject++
		}
	}
	if limits.PerRuntime > 0 && onRuntime >= limits.PerRuntime {
		return fmt.Sprintf("%s 上已经有 %d 个帮工在干活，最多同时 %d 个（在 Runtime 页面可以改）", protocol.RuntimeLabel(runtime), onRuntime, limits.PerRuntime)
	}
	if limits.PerProject > 0 && inProject >= limits.PerProject {
		return fmt.Sprintf("项目 %s 里已经有 %d 个帮工在干活，最多同时 %d 个：人多了容易改到同一个文件", project, inProject, limits.PerProject)
	}
	return ""
}

// crewHelperName is a new helper's name: the agent's, numbered when more than one from the same agent is on the farm.
func crewHelperName(helpers []protocol.Helper, agentID, agentName string) string {
	same := 0
	for _, h := range helpers {
		if h.Agent == agentID {
			same++
		}
	}
	if same == 0 {
		return agentName
	}
	return fmt.Sprintf("%s %d", agentName, same+1)
}

// Candidate is an agent as the farm weighs it for a job: can it be sent now (enabled, nothing blocking).
type Candidate struct {
	Agent  protocol.AgentProfile
	Usable bool
}

// ChooseAgent is who goes (docs/agents-and-runtimes.md「派给谁」): the agent named, by id or name, or the first
// usable one on a runtime named; else the one picked in the chat; else the usable agent whose tags the job mentions
// most, the first of equals. nil when nobody can.
func ChooseAgent(candidates []Candidate, task, named, picked string) *protocol.AgentProfile {
	if named != "" {
		for _, c := range candidates {
			if c.Agent.ID == named || c.Agent.Name == named {
				return &c.Agent
			}
		}
		for _, c := range candidates {
			if c.Agent.Runtime == named && c.Usable {
				return &c.Agent
			}
		}
	}
	if picked != "" {
		for _, c := range candidates {
			if c.Agent.ID == picked {
				return &c.Agent
			}
		}
	}
	text := strings.ToLower(task)
	var best *protocol.AgentProfile
	bestScore := -1
	for _, c := range candidates {
		if !c.Usable {
			continue
		}
		score := 0
		for _, t := range c.Agent.Tags {
			if strings.Contains(text, strings.ToLower(t)) {
				score++
			}
		}
		if score > bestScore {
			agent := c.Agent
			best, bestScore = &agent, score
		}
	}
	return best
}

// ── What a helper is told (briefing.ts) ──────────────────────────────────────

// JobBreak is between a persona sent in prompt mode (or what a turn is reminded of) and the job under it: what
// the detail panel shows starts after it.
const JobBreak = "\n\n---\n\n"

func crewToOarMcp(server protocol.MCPServer) oar.McpServer {
	switch s := server.Value.(type) {
	case protocol.MCPServerHTTP:
		return oar.McpServer{Name: s.Name, Type: "http", URL: s.URL, Headers: s.Headers}
	case protocol.MCPServerStdio:
		return oar.McpServer{Name: s.Name, Command: s.Command, Args: s.Args, Env: s.Env}
	}
	return oar.McpServer{}
}

// crewInstructions is the agent's persona with its skills under it, as one block of instructions.
func crewInstructions(agent protocol.AgentProfile, library []protocol.Skill) string {
	parts := []string{base.Trim(agent.Persona)}
	for _, id := range agent.Skills {
		if i := slices.IndexFunc(library, func(s protocol.Skill) bool { return s.ID == id }); i >= 0 {
			parts = append(parts, "## "+library[i].Name+"\n"+base.Trim(library[i].Body))
		}
	}
	return strings.Join(slices.DeleteFunc(parts, func(p string) bool { return p == "" }), "\n\n")
}

// crewFarmRules is what every helper is told about working on the farm: its place, to commit what it does, and how to
// talk on the group chat (田头) with the farm's tools. id is how others @ it.
func crewFarmRules(place base.Workplace, house, id string) string {
	where := fmt.Sprintf("你在项目「%s」的目录里干活（%s）。只改这个目录里的东西，不要 push。", place.Project, place.Cwd)
	if place.Branch != "" {
		where = fmt.Sprintf("你在项目「%s」的独立分支 %s 上干活（这是一个 git worktree：%s）。只改这个目录里的东西，不要切换或改动别的分支，不要 push。", place.Project, place.Branch, place.Cwd)
	}
	lines := []string{
		"## 在码农场物语干活的规矩",
		"- " + where,
		"- 做完一轮：git add 你改的文件，git commit，提交信息用一句中文说清楚做了什么。",
		"- 汇报时写上 commit 号，以及你是怎么验证的（跑了什么命令、结果如何）。",
		"- 汇报的最后一段以「结论：」开头，一两句话说清做成了什么（或卡在哪、需要主人定什么）；有提交就带上 commit 号。补充说明写在结论前面。",
		"",
		"## 记性",
		"- 你有记性：同一个 agent 的帮工共用。每一轮开头「【你记得的】」那段是以前记下的，用得上就用；和眼前的代码、主人这次说的对不上时，以眼前的为准。",
		"- 这一轮学到下次还用得上的（这个项目的约定和命令、踩过的坑、主人的偏好），在结论前面写几行，每行以「记住：」开头，一行一条，写成下次一看就懂的一句话；对所有项目都成立的写「记住（所有项目）：」。没有就不写。这一轮做了什么不用写进去，农场会自己记。",
		"",
		"## 在田头说话（农场的群聊）",
		fmt.Sprintf("- 你在群聊里是 @%s。主人是 @主人，管家是 @管家，别的帮工是 @w 加编号（farm_who 列出地里有谁）。", id),
		"- 写 @ 就是叫醒那个人，每次都花钱。只是提到谁（列出地里有谁、转述谁说了什么），写名字或编号，不带 @：「w22 说……」。",
		"- 你这件活有自己的工单串：这一轮最后的汇报会自动贴进去，不用另发。一轮中间要说话（确认收到、提问、交接），用 farm_say；target 不填就是你的工单串。",
		"- 收到点名给你的消息，先用一句话确认或问清楚，再埋头干。回复照抄消息里的 target，在原来的串里接着说。",
		"- 只在有实际内容时说话，不报「我在等」「我还在做」。别人做完的活不替他汇报。",
		"- 在一个串里被 @，先用 farm_read 读这个串，再回。刚醒来看到的旧消息只读不回，除非直接问到你。",
		"- 要别的帮工做什么就 @ 他，说清楚要什么；不要和他来回闲聊，拿不准就 @主人。停下之前，看看有没有欠别人的回复。",
	}
	if house := base.Trim(house); house != "" {
		lines = append(lines, "", "## 这台机器上所有项目的约定", house)
	}
	return strings.Join(lines, "\n")
}

// crewExtra are the session options an agent adds to what spawn gives (model, effort, env, cwd): its persona, MCP
// servers and disallowed tools.
type crewExtra struct {
	SystemPrompt       *string
	AppendSystemPrompt *string
	MCPServers         []oar.McpServer
	DisallowedTools    []string
}

// crewWithOptions is the runtime with this agent's session options added. smith's spawn takes only model, effort,
// env and cwd, so the rest rides on a runtime of this session's own.
func crewWithOptions(base oar.Runtime, extra crewExtra) oar.Runtime {
	out := base
	out.Session = func(ctx context.Context, installation oar.AvailableInstallation, options oar.SessionOptions) (oar.Session, error) {
		if extra.SystemPrompt != nil {
			options.SystemPrompt = extra.SystemPrompt
		}
		if extra.AppendSystemPrompt != nil {
			options.AppendSystemPrompt = extra.AppendSystemPrompt
		}
		options.MCPServers = extra.MCPServers
		if extra.DisallowedTools != nil {
			options.DisallowedTools = extra.DisallowedTools
		}
		return base.Session(ctx, installation, options)
	}
	return out
}

// PlanningTask is what a planning helper is told: read the code, split the job into steps a helper each, and give
// the plan as a json code block (protocol's PlanDraft). It changes nothing.
func PlanningTask(goal, project string, agents []protocol.AgentProfile) string {
	type node struct {
		ID    string   `json:"id"`
		Title string   `json:"title"`
		Task  string   `json:"task"`
		Needs []string `json:"needs"`
		Agent string   `json:"agent,omitempty"`
		Scope []string `json:"scope"`
		Check string   `json:"check"`
		// Acceptance marks the step that writes the acceptance.
		Acceptance bool `json:"acceptance,omitempty"`
	}
	agent := "lab"
	if len(agents) > 0 {
		agent = agents[0].ID
	}
	example := struct {
		Title string `json:"title"`
		Nodes []node `json:"nodes"`
	}{"按月查询打卡记录", []node{
		{ID: "accept", Title: "验收", Task: "……", Needs: []string{}, Scope: []string{"test/month.test.ts"}, Check: "pnpm test test/month.test.ts", Acceptance: true},
		{ID: "schema", Title: "数据层", Task: "……", Needs: []string{"accept"}, Scope: []string{"src/db"}, Check: "pnpm test"},
		{ID: "api", Title: "查询接口", Task: "……", Needs: []string{"schema"}, Agent: agent, Scope: []string{"src/api"}, Check: "pnpm test"},
	}}
	pretty, _ := json.MarshalIndent(example, "", "  ")
	lines := []string{
		"这一轮你是规划师：把下面这件事拆成一张种植计划，交给几个帮工分头去做。你自己不写代码、不改文件、不提交。",
		"",
		"要做的事：" + base.Trim(goal),
		fmt.Sprintf("项目：%s（你现在就在它的目录里）", project),
		"",
		"先读代码，弄清现状，再拆。拆的规矩：",
		fmt.Sprintf("- 最多 %d 步，一般三到六步。一步是一个帮工在自己的分支上能做完、提交、单独验证的一件事，不要拆得太碎。", protocol.MaxNodes),
		"- 工单写清：目标、要改哪里、做到什么程度算完、要留下什么给后面的步骤（接口签名、文件位置、数据格式）。帮工只看得到它自己这一步的工单和前面步骤的结论。",
		"- needs 写这一步要等哪些步骤做完。不互相依赖的步骤会同时做：尽量让它们改不同的文件，写在 scope 里。",
		"- 别拆成一条串行的长链（每一步都等上一步，就只能一个一个做）。有先后的按阶段分组，同一阶段里的步骤互不依赖。",
		"- 项目里有测试或构建命令的，写进 check（比如 pnpm test），这一步做完会在它的分支上跑，过了才合。",
		"- 修 bug，或要做的事能用测试说清楚的：第一步写验收（acceptance: true）。它只写现在会失败的测试（复现 bug，或说明做成什么样），不修、不实现；check 写只跑这些测试的命令，要因为问题本身失败，不能因为写错、编译不过失败。别的步骤都等它。它合进去以后就冻结了，后面的步骤不能改它，最后一步要让它通过。",
		"- 最后放一步整体验证：跑全部测试、修小问题、补文档，写一段总结。",
		"- id 用简短的英文小写单词，比如 schema、api、ui。",
	}
	if len(agents) > 0 {
		lines = append(lines, "- 能派的帮工（agent 填 id；不填就按「适合」挑）：")
		for _, a := range agents {
			tags := ""
			if len(a.Tags) > 0 {
				tags = "（" + strings.Join(a.Tags, "、") + "）"
			}
			lines = append(lines, fmt.Sprintf("  - %s：%s，适合：%s%s", a.ID, a.Name, a.Role, tags))
		}
	}
	lines = append(lines, "", "汇报的最后，用一个 json 代码块给出整张计划，格式照这个：", "```json", string(pretty), "```", "代码块之后写一句结论：拆成了几步、为什么这样拆。")
	return strings.Join(lines, "\n")
}

// ── What a turn is reminded of (recall.ts, the crew's part) ──────────────────

// RecallHead is the first words of what a turn is reminded of: crewRecalledIn finds the block by them.
const RecallHead = "【你记得的】"

// crewRecallBlock is what goes on top of a turn's input: the memories it is reminded of. Empty when there are none.
func crewRecallBlock(memories []protocol.Memory, project string) string {
	if len(memories) == 0 {
		return ""
	}
	lines := []string{RecallHead + "你（同一个 agent）以前在农场干活时记下的，可能用得上，也可能过时了：和眼前的代码、主人这次说的对不上时，以眼前的为准。"}
	for _, m := range memories {
		lines = append(lines, protocol.LineOf(m, project))
	}
	return strings.Join(lines, "\n")
}

// crewWithRecall is a turn's input with what it is reminded of on top, set apart so the detail panel shows the two apart.
func crewWithRecall(block, input string) string {
	if block == "" {
		return input
	}
	return block + JobBreak + input
}

// crewRecalledIn is what a turn's input was reminded of (its lines, without the head); "" when nothing.
func crewRecalledIn(input string) string {
	parts := strings.Split(input, JobBreak)
	if len(parts) < 2 {
		return ""
	}
	block := parts[len(parts)-2]
	if !strings.HasPrefix(block, RecallHead) {
		return ""
	}
	lines := strings.Split(block, "\n")
	return strings.Join(lines[1:], "\n")
}
