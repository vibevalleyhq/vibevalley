package session

import (
	"strings"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/runtime"
	"vibevalley/internal/testkit"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/x/str"
)

func ev(body oar.EventBody) oar.Event {
	return oar.Event{Envelope: oar.Envelope{SessionID: "s", AgentPath: []string{}}, Body: body}
}

var ctx = factContext{ID: "w1", Runtime: "pi", Cwd: "/work/clock-in", CnyPerUsd: 7}

func sessionBase() protocol.Session {
	project := "clock-in"
	return protocol.Session{ID: "w1", Name: "老周", Agent: "zhou", Runtime: "pi", Task: "加接口", Project: &project, Phase: protocol.Phase{Value: protocol.PhaseArriving{}}}
}

func working(doing protocol.Doing) *protocol.Session {
	h := sessionBase()
	h.Phase = protocol.Phase{Value: protocol.PhaseWorking{Doing: doing}}
	return &h
}

var thinking = protocol.Doing{Action: protocol.SessionActionThinking}

func f(v float64) *float64 { return &v }
func i(v int64) *int64     { return &v }

func TestSessionsRunStartsWithTheJobAndCountsFromWhatWasSpent(t *testing.T) {
	h := sessionBase()
	h.Spent = &protocol.Spent{Tokens: 50, CNY: f(0.1)}
	r := eventFacts(ev(oar.TurnStarted{RequestID: "r", Input: "你是老周" + JobBreak + "加一个查询接口"}), &h, tracking{}, ctx)
	testkit.Eq(t, r.Facts, []protocol.FactValue{protocol.FactRun{ID: "w1"}}, "facts")
	testkit.Eq(t, r.Journal, []op{{Type: "prompt", Text: "加一个查询接口"}}, "journal")
	testkit.Eq(t, *r.Tracking.RunFrom, protocol.Spent{Tokens: 50, CNY: f(0.1)}, "turnFrom")
}

func TestSessionsRunRemindedOfMemories(t *testing.T) {
	block := RecallHead + "你以前记下的……\n- （这个项目）测试用 pnpm test"
	h := sessionBase()
	r := eventFacts(ev(oar.TurnStarted{RequestID: "r", Input: "你是老周" + JobBreak + withRecall(block, "加一个查询接口")}), &h, tracking{}, ctx)
	testkit.Eq(t, r.Journal, []op{{Type: "prompt", Text: "加一个查询接口"}, {Type: "note", Kind: protocol.SessionEventTypeMemoryRecalled, Text: "- （这个项目）测试用 pnpm test"}}, "journal")
}

func TestSessionsCommandShowsFromItsFolder(t *testing.T) {
	input := `{"command":"cd /work/clock-in && pnpm test"}`
	started := eventFacts(ev(oar.ToolCallStarted{CallID: "c1", Tool: "bash", Input: &input}), working(thinking), tracking{}, ctx)
	testkit.Eq(t, started.Facts, []protocol.FactValue{protocol.FactDoing{ID: "w1", Action: protocol.SessionActionRunCommand, Label: "pnpm test"}}, "started")
	testkit.Eq(t, started.Journal[0].Type, "toolStarted", "op")
	testkit.Eq(t, *started.Tracking.ShownCall, shownCall{ID: "c1", Tool: "bash"}, "shown")

	again := `{"command":"pnpm test"}`
	same := eventFacts(ev(oar.ToolCallStarted{CallID: "c2", Tool: "bash", Input: &again}), working(protocol.Doing{Action: protocol.SessionActionRunCommand, Label: "pnpm test"}), tracking{}, ctx)
	testkit.Eq(t, len(same.Facts), 0, "again")

	failed := eventFacts(ev(oar.ToolCallEnded{CallID: "c1", ExitCode: oar.IntOf(1), Content: []oar.ToolOutputPart{{Type: "text", Text: "1 failing"}}}),
		working(protocol.Doing{Action: protocol.SessionActionRunCommand, Label: "pnpm test"}), started.Tracking, ctx)
	testkit.Eq(t, failed.Journal, []op{{Type: "toolEnded", CallID: "c1", Output: "1 failing", Ok: false}}, "ended")
	testkit.Eq(t, failed.Facts, []protocol.FactValue{protocol.FactDoing{ID: "w1", Action: protocol.SessionActionThinking, Label: ""}}, "back to thinking")
}

func TestSessionsFullInputNamesTheTargetBetter(t *testing.T) {
	tracking := tracking{ShownCall: &shownCall{ID: "c1", Tool: "read"}}
	input := `{"path":"/work/clock-in/src/http.ts"}`
	r := eventFacts(ev(oar.ToolCallInput{CallID: "c1", Input: input}), working(protocol.Doing{Action: protocol.SessionActionReadFile, Label: "read"}), tracking, ctx)
	testkit.Eq(t, r.Journal, []op{{Type: "toolInput", CallID: "c1", Input: input, Text: "src/http.ts"}}, "journal")
	testkit.Eq(t, r.Facts, []protocol.FactValue{protocol.FactDoing{ID: "w1", Action: protocol.SessionActionReadFile, Label: "src/http.ts"}}, "facts")
}

func TestSessionsReasoningIsAStepWhenShown(t *testing.T) {
	r := eventFacts(ev(oar.Reasoning{Content: oar.ReasoningContent{Kind: "text", Text: "先看看路由在哪"}}), working(protocol.Doing{Action: protocol.SessionActionReadFile, Label: "a.ts"}), tracking{}, ctx)
	testkit.Eq(t, r.Journal, []op{{Type: "thought", Text: "先看看路由在哪"}}, "journal")
	testkit.Eq(t, r.Facts, []protocol.FactValue{protocol.FactDoing{ID: "w1", Action: protocol.SessionActionThinking}}, "facts")
	testkit.Eq(t, len(eventFacts(ev(oar.Reasoning{Content: oar.ReasoningContent{Kind: "redacted"}}), working(thinking), tracking{}, ctx).Journal), 0, "redacted")
}

func TestSessionsSubAgentStepsSayWhose(t *testing.T) {
	own := eventFacts(ev(oar.TextDelta{Text: "好"}), working(thinking), tracking{}, ctx)
	testkit.Eq(t, own.Journal, []op{{Type: "response", Text: "好"}}, "own")
	input := "{}"
	event := ev(oar.ToolCallStarted{CallID: "c1", Tool: "bash", Input: &input})
	event.AgentPath = []string{"task-1"}
	sub := eventFacts(event, working(thinking), tracking{}, ctx)
	testkit.Eq(t, sub.Journal[0].From, From{"task-1"}, "from")
}

func TestSessionsNotWorkingNoBubble(t *testing.T) {
	h := sessionBase()
	h.Phase = protocol.Phase{Value: protocol.PhaseResting{}}
	for _, body := range []oar.EventBody{oar.Reasoning{Content: oar.ReasoningContent{Kind: "empty"}}, oar.TextDelta{Text: "好的"}} {
		testkit.Eq(t, len(eventFacts(ev(body), &h, tracking{}, ctx).Facts), 0, "facts")
	}
}

func TestSessionsSpendingCountedFromTheLastTotal(t *testing.T) {
	price := runtime.Price{Input: 1, Output: 2, CacheRead: 0.1}
	usage := func(input, output int64) oar.EventBody {
		return oar.Usage{Usage: oar.UsageReport{Tokens: &oar.TokenTotals{Input: input, Output: output, CacheRead: i(0), CacheWrite: i(0)}}}
	}
	first := eventFacts(ev(usage(1_000_000, 0)), working(thinking), tracking{Price: &price}, ctx)
	testkit.Eq(t, first.SpentCny, 7.0, "first yuan")
	testkit.Eq(t, first.Facts, []protocol.FactValue{protocol.FactSpent{ID: "w1", Spent: protocol.Spent{Tokens: 1_000_000, CNY: f(7)}}}, "first")

	h := working(thinking)
	h.Spent = &protocol.Spent{Tokens: 1_000_000, CNY: f(7)}
	second := eventFacts(ev(usage(1_000_000, 500_000)), h, first.Tracking, ctx)
	testkit.Eq(t, second.SpentCny, 7.0, "second yuan")
	testkit.Eq(t, second.Facts, []protocol.FactValue{protocol.FactSpent{ID: "w1", Spent: protocol.Spent{Tokens: 1_500_000, CNY: f(14)}}}, "second")

	unpriced := eventFacts(ev(oar.Usage{Usage: oar.UsageReport{Tokens: &oar.TokenTotals{Input: 10, Output: 5}}}), working(thinking), tracking{}, ctx)
	testkit.Eq(t, unpriced.SpentCny, 0.0, "unpriced yuan")
	testkit.Eq(t, unpriced.Facts, []protocol.FactValue{protocol.FactSpent{ID: "w1", Spent: protocol.Spent{Tokens: 15}}}, "unpriced")

	testkit.Eq(t, dollars(oar.TokenTotals{Input: 1_000_000, CacheRead: i(400_000), CacheWrite: i(0)}, price), 0.64, "dollars")
	testkit.Eq(t, *since(protocol.Spent{Tokens: 30, CNY: f(3)}, &protocol.Spent{Tokens: 10, CNY: f(1)}), protocol.Spent{Tokens: 20, CNY: f(2)}, "since")
	if since(protocol.Spent{Tokens: 30}, nil) != nil {
		t.Fatal("since nothing is nothing")
	}
}

func TestSessionsQuietEndsWithAWordNotWithUsage(t *testing.T) {
	doing := protocol.Doing{Action: protocol.SessionActionRunCommand, Label: "pnpm build"}
	usage := eventFacts(ev(oar.Usage{}), working(doing), tracking{Quiet: true}, ctx)
	testkit.Eq(t, usage.Tracking.Quiet, true, "usage keeps quiet")
	testkit.Eq(t, len(usage.Facts), 0, "usage facts")
	word := eventFacts(ev(oar.TextDelta{Text: "构建完了"}), working(doing), tracking{Quiet: true}, ctx)
	testkit.Eq(t, word.Tracking.Quiet, false, "a word ends it")
	testkit.Eq(t, word.Facts, []protocol.FactValue{
		protocol.FactDoing{ID: "w1", Action: doing.Action, Label: doing.Label},
		protocol.FactDoing{ID: "w1", Action: protocol.SessionActionSpeakingText},
	}, "facts")
}

func TestSessionsRetriesModelFailuresAndExitsAreSaid(t *testing.T) {
	maxAttempts, delay := 3, int64(1500)
	retry := eventFacts(ev(oar.Retry{Attempt: 2, MaxAttempts: &maxAttempts, DelayMs: &delay, Reason: "429"}), working(thinking), tracking{}, ctx)
	testkit.Eq(t, retry.Facts, []protocol.FactValue{protocol.FactRetry{ID: "w1", Attempt: 2, Of: i(3)}}, "retry fact")
	testkit.Eq(t, retry.Journal, []op{{Type: "note", Kind: protocol.SessionEventTypeLLMRetry, Text: "调用模型没成功，第 2/3 次重试，2 秒后：429"}}, "retry step")

	testkit.Eq(t, eventFacts(ev(oar.Model{Model: "deepseek-flash"}), working(thinking), tracking{}, ctx).Model, "deepseek-flash", "model")

	failed := eventFacts(ev(oar.TurnEnded{Outcome: oar.Failed(oar.FailureBilling, "Insufficient Balance")}), working(thinking), tracking{}, ctx)
	testkit.Eq(t, failed.Journal[0].Type, "note", "failed step")
	testkit.Match(t, failed.Journal[0].Text, `^余额不够了：Insufficient Balance`, "failed text")

	code := 137
	h := working(thinking)
	h.Runs = 2
	exited := eventFacts(ev(oar.Exited{Code: &code}), h, tracking{}, ctx)
	testkit.Eq(t, exited.Facts, []protocol.FactValue{protocol.FactReport{ID: "w1", Outcome: protocol.OutcomeFailed, Summary: "pi 进程退出了（退出码 137）", Runs: 2}}, "exited")
	testkit.Eq(t, exited.Warn, "老周 的 pi 进程退出了（退出码 137）", "warn")
	ripe := sessionBase()
	ripe.Phase = protocol.Phase{Value: protocol.PhaseRipe{}}
	zero := 0
	testkit.Eq(t, len(eventFacts(ev(oar.Exited{Code: &zero}), &ripe, tracking{}, ctx).Facts), 0, "between turns")
}

func TestNear(t *testing.T) {
	testkit.Eq(t, near("/work/p", "/work/p/src/a.ts"), "src/a.ts", "inside")
	testkit.Eq(t, near("/work/p", "/work/p"), ".", "itself")
	testkit.Eq(t, near("/work/p", "/etc/hosts"), "/etc/hosts", "outside")
	testkit.Eq(t, near("/work/p", "cd /work/p && pnpm test"), "pnpm test", "cd")
	testkit.Eq(t, near("/work/p", "cat /work/p/README.md"), "cat README.md", "inside a command")
}

func TestSummaryIsTheVerdict(t *testing.T) {
	text := strings.Join([]string{"读了 src/http.ts。", "**结论：** 两个路由，POST /api/clock-in 和 POST /api/clock-out。", "（另外可选：README 第 3 行可以补个链接。）"}, "\n\n")
	testkit.Eq(t, SummaryOf(text), "两个路由，POST /api/clock-in 和 POST /api/clock-out。", "bold verdict")
	testkit.Eq(t, SummaryOf("前面的话\n\n- 结论：做完了，commit abc123"), "做完了，commit abc123", "listed verdict")
	testkit.Match(t, SummaryOf("开头在看代码。\n\n最后：一切正常，测试 28 个都过了。"), `测试 28 个都过了`, "no verdict")
}

func TestCompletedRunRead(t *testing.T) {
	read := readReport(oar.Completed(), "  改了路由。\n\n结论：加好了，commit abc123  ")
	testkit.Eq(t, read, sessionRead{Outcome: protocol.OutcomeCompleted, Text: "改了路由。\n\n结论：加好了，commit abc123", Summary: "加好了，commit abc123"}, "read")
	testkit.Eq(t, readReport(oar.Completed(), "").Summary, "做完了", "empty completed")
	testkit.Eq(t, readReport(oar.AbortedOutcome(), "").Outcome, protocol.OutcomeInterrupted, "aborted")
	testkit.Eq(t, readReport(oar.AbortedOutcome(), "").Summary, "没做完", "aborted summary")
}

func TestFailedRunLeadsWithWhy(t *testing.T) {
	status := 402
	outcome := oar.Failed(oar.FailureBilling, "Insufficient Balance")
	outcome.Status = &status
	billing := readReport(outcome, "先看了看代码")
	testkit.Eq(t, billing.Outcome, protocol.OutcomeFailed, "outcome")
	testkit.Eq(t, billing.NeedsYou, true, "needs you")
	testkit.Match(t, billing.Failure, `^余额不够了（HTTP 402）：Insufficient Balance`, "failure")
	testkit.Eq(t, billing.Summary, str.Clip(billing.Failure, 160), "summary")
	testkit.Eq(t, billing.Text, billing.Failure+"\n\n先看了看代码", "text")
	testkit.Eq(t, readReport(oar.Failed(oar.FailureOverloaded, ""), "").NeedsYou, false, "overloaded")
}

func TestClip(t *testing.T) {
	testkit.Eq(t, str.Clip("a\n  b", 10), "a b", "one line")
	testkit.Eq(t, str.Clip("abcdefghij", 5), "abcd…", "cut")
}

func limitSession(id, runtime, project string, working bool) protocol.Session {
	phase := protocol.Phase{Value: protocol.PhaseRipe{}}
	if working {
		phase = protocol.Phase{Value: protocol.PhaseWorking{Doing: thinking}}
	}
	return protocol.Session{ID: id, Name: id, Agent: "zhou", Runtime: runtime, Project: &project, Phase: phase}
}

func TestRoomOnTheFarm(t *testing.T) {
	limits := sessionLimits{Workspace: 3, PerRuntime: 2, PerProject: 2}
	h := limitSession
	testkit.Eq(t, noRoom(nil, "pi", "a", limits, ""), "", "empty farm")
	testkit.Match(t, noRoom([]protocol.Session{h("w1", "pi", "a", true), h("w2", "claude", "b", true), h("w3", "codex", "c", true)}, "pi", "a", limits, ""), `已经有 3 个帮工在干活了`, "farm")
	testkit.Match(t, noRoom([]protocol.Session{h("w1", "pi", "a", true), h("w2", "pi", "b", true)}, "pi", "c", limits, ""), `最多同时 2 个（在 Runtime 页面可以改）`, "runtime")
	testkit.Match(t, noRoom([]protocol.Session{h("w1", "pi", "a", true), h("w2", "claude", "a", true)}, "codex", "a", limits, ""), `项目 a 里已经有 2 个帮工在干活`, "project")

	two := []protocol.Session{h("w1", "pi", "a", true), h("w2", "pi", "a", true)}
	testkit.Eq(t, noRoom([]protocol.Session{h("w1", "pi", "a", false), h("w2", "pi", "a", false)}, "pi", "a", limits, ""), "", "only working count")
	if noRoom(two, "pi", "a", limits, "") == "" {
		t.Fatal("two working fill it")
	}
	testkit.Eq(t, noRoom(two, "pi", "a", sessionLimits{Workspace: 6}, ""), "", "0 is no cap")
	testkit.Eq(t, noRoom(two, "pi", "a", sessionLimits{Workspace: 3, PerRuntime: 3, PerProject: 3}, "w1"), "", "not against itself")
}

func TestSessionName(t *testing.T) {
	h := limitSession
	testkit.Eq(t, sessionName(nil, "zhou", "老周"), "老周", "first")
	testkit.Eq(t, sessionName([]protocol.Session{h("w1", "pi", "a", true)}, "zhou", "老周"), "老周 2", "second")
	testkit.Eq(t, sessionName([]protocol.Session{h("w1", "pi", "a", true), h("w2", "pi", "a", true)}, "zhou", "老周"), "老周 3", "third")
}

func TestChooseAgent(t *testing.T) {
	a := protocol.Agent{ID: "a", Name: "甲", Runtime: "pi", Tags: []string{"前端"}}
	b := protocol.Agent{ID: "b", Name: "乙", Runtime: "claude", Tags: []string{"测试", "后端"}}
	candidates := []Candidate{{a, true}, {b, true}}
	testkit.Eq(t, ChooseAgent(candidates, "随便", "乙", "").ID, "b", "by name")
	testkit.Eq(t, ChooseAgent(candidates, "随便", "claude", "").ID, "b", "by runtime")
	testkit.Eq(t, ChooseAgent(candidates, "随便", "", "b").ID, "b", "picked")
	testkit.Eq(t, ChooseAgent(candidates, "补后端测试", "", "").ID, "b", "by tags")
	testkit.Eq(t, ChooseAgent(candidates, "随便", "", "").ID, "a", "first of equals")
}

func TestCommentOnlyFromItsMark(t *testing.T) {
	if commentOn("随便说一句") != nil {
		t.Fatal("a plain message comments on nothing")
	}
	if on := commentOn(CommentText(protocol.SessionEvent{Seq: 3, Type: protocol.SessionEventTypeAssistantMessage, Text: "好"}, "再想想")); on == nil || *on != 3 {
		t.Fatalf("a comment on step 3: %v", on)
	}
}
