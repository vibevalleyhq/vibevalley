package runs

import (
	"strings"
	"testing"

	"vibevalley/internal/base"
	"vibevalley/internal/farmtest"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/smith/oar"
)

// The crew's pure rules (session-facts.test.ts, report.test.ts, limits.test.ts): each case is an event, a helper and
// the session's bookkeeping in, facts and steps out; a report read; the caps on helpers working at once.

func crewEv(body oar.EventBody) oar.Event {
	return oar.Event{Envelope: oar.Envelope{SessionID: "s", AgentPath: []string{}}, Body: body}
}

var crewCtx = crewSessionContext{ID: "w1", Runtime: "pi", Cwd: "/work/clock-in", CnyPerUsd: 7}

func crewBase() protocol.Helper {
	project := "clock-in"
	return protocol.Helper{ID: "w1", Name: "老周", Agent: "zhou", Runtime: "pi", Task: "加接口", Project: &project, Phase: protocol.Phase{Value: protocol.PhaseArriving{}}}
}

func crewWorking(doing protocol.Doing) *protocol.Helper {
	h := crewBase()
	h.Phase = protocol.Phase{Value: protocol.PhaseWorking{Doing: doing}}
	return &h
}

var crewThinking = protocol.Doing{Action: protocol.WorkerActionThinking}

func crewF(v float64) *float64 { return &v }
func crewI(v int64) *int64     { return &v }

func TestCrewTurnStartsWithTheJobAndCountsFromWhatWasSpent(t *testing.T) {
	h := crewBase()
	h.Spent = &protocol.Spent{Tokens: 50, CNY: crewF(0.1)}
	r := crewSessionFacts(crewEv(oar.TurnStarted{RequestID: "r", Input: "你是老周" + JobBreak + "加一个查询接口"}), &h, crewTracking{}, crewCtx)
	farmtest.Eq(t, r.Facts, []protocol.FactValue{protocol.FactTurn{ID: "w1"}}, "facts")
	farmtest.Eq(t, r.Journal, []crewOp{{Type: "asked", Text: "加一个查询接口"}}, "journal")
	farmtest.Eq(t, *r.Tracking.TurnFrom, protocol.Spent{Tokens: 50, CNY: crewF(0.1)}, "turnFrom")
}

func TestCrewTurnRemindedOfMemories(t *testing.T) {
	block := RecallHead + "你以前记下的……\n- （这个项目）测试用 pnpm test"
	h := crewBase()
	r := crewSessionFacts(crewEv(oar.TurnStarted{RequestID: "r", Input: "你是老周" + JobBreak + crewWithRecall(block, "加一个查询接口")}), &h, crewTracking{}, crewCtx)
	farmtest.Eq(t, r.Journal, []crewOp{{Type: "asked", Text: "加一个查询接口"}, {Type: "note", Kind: protocol.StepKindRecalled, Text: "- （这个项目）测试用 pnpm test"}}, "journal")
}

func TestCrewCommandShowsFromItsFolder(t *testing.T) {
	input := `{"command":"cd /work/clock-in && pnpm test"}`
	started := crewSessionFacts(crewEv(oar.ToolCallStarted{CallID: "c1", Tool: "bash", Input: &input}), crewWorking(crewThinking), crewTracking{}, crewCtx)
	farmtest.Eq(t, started.Facts, []protocol.FactValue{protocol.FactDoing{ID: "w1", Action: protocol.WorkerActionRunCommand, Label: "pnpm test"}}, "started")
	farmtest.Eq(t, started.Journal[0].Type, "toolStarted", "op")
	farmtest.Eq(t, *started.Tracking.ShownCall, crewShownCall{ID: "c1", Tool: "bash"}, "shown")

	// Already doing just that: no fact, the bubble does not change.
	again := `{"command":"pnpm test"}`
	same := crewSessionFacts(crewEv(oar.ToolCallStarted{CallID: "c2", Tool: "bash", Input: &again}), crewWorking(protocol.Doing{Action: protocol.WorkerActionRunCommand, Label: "pnpm test"}), crewTracking{}, crewCtx)
	farmtest.Eq(t, len(same.Facts), 0, "again")

	failed := crewSessionFacts(crewEv(oar.ToolCallEnded{CallID: "c1", ExitCode: oar.IntOf(1), Content: []oar.ToolOutputPart{{Type: "text", Text: "1 failing"}}}),
		crewWorking(protocol.Doing{Action: protocol.WorkerActionRunCommand, Label: "pnpm test"}), started.Tracking, crewCtx)
	farmtest.Eq(t, failed.Journal, []crewOp{{Type: "toolEnded", CallID: "c1", Output: "1 failing", Ok: false}}, "ended")
	farmtest.Eq(t, failed.Facts, []protocol.FactValue{protocol.FactDoing{ID: "w1", Action: protocol.WorkerActionThinking, Label: ""}}, "back to thinking")
}

func TestCrewFullInputNamesTheTargetBetter(t *testing.T) {
	tracking := crewTracking{ShownCall: &crewShownCall{ID: "c1", Tool: "read"}}
	input := `{"path":"/work/clock-in/src/http.ts"}`
	r := crewSessionFacts(crewEv(oar.ToolCallInput{CallID: "c1", Input: input}), crewWorking(protocol.Doing{Action: protocol.WorkerActionReadFile, Label: "read"}), tracking, crewCtx)
	farmtest.Eq(t, r.Journal, []crewOp{{Type: "toolInput", CallID: "c1", Input: input, Text: "src/http.ts"}}, "journal")
	farmtest.Eq(t, r.Facts, []protocol.FactValue{protocol.FactDoing{ID: "w1", Action: protocol.WorkerActionReadFile, Label: "src/http.ts"}}, "facts")
}

func TestCrewReasoningIsAStepWhenShown(t *testing.T) {
	r := crewSessionFacts(crewEv(oar.Reasoning{Content: oar.ReasoningContent{Kind: "text", Text: "先看看路由在哪"}}), crewWorking(protocol.Doing{Action: protocol.WorkerActionReadFile, Label: "a.ts"}), crewTracking{}, crewCtx)
	farmtest.Eq(t, r.Journal, []crewOp{{Type: "thought", Text: "先看看路由在哪"}}, "journal")
	farmtest.Eq(t, r.Facts, []protocol.FactValue{protocol.FactDoing{ID: "w1", Action: protocol.WorkerActionThinking}}, "facts")
	farmtest.Eq(t, len(crewSessionFacts(crewEv(oar.Reasoning{Content: oar.ReasoningContent{Kind: "redacted"}}), crewWorking(crewThinking), crewTracking{}, crewCtx).Journal), 0, "redacted")
}

func TestCrewSubAgentStepsSayWhose(t *testing.T) {
	own := crewSessionFacts(crewEv(oar.TextDelta{Text: "好"}), crewWorking(crewThinking), crewTracking{}, crewCtx)
	farmtest.Eq(t, own.Journal, []crewOp{{Type: "said", Text: "好"}}, "own")
	input := "{}"
	event := crewEv(oar.ToolCallStarted{CallID: "c1", Tool: "bash", Input: &input})
	event.AgentPath = []string{"task-1"}
	sub := crewSessionFacts(event, crewWorking(crewThinking), crewTracking{}, crewCtx)
	farmtest.Eq(t, sub.Journal[0].From, base.From{"task-1"}, "from")
}

func TestCrewNotWorkingNoBubble(t *testing.T) {
	h := crewBase()
	h.Phase = protocol.Phase{Value: protocol.PhaseResting{}}
	for _, body := range []oar.EventBody{oar.Reasoning{Content: oar.ReasoningContent{Kind: "empty"}}, oar.TextDelta{Text: "好的"}} {
		farmtest.Eq(t, len(crewSessionFacts(crewEv(body), &h, crewTracking{}, crewCtx).Facts), 0, "facts")
	}
}

func TestCrewSpendingCountedFromTheLastTotal(t *testing.T) {
	price := base.Price{Input: 1, Output: 2, CacheRead: 0.1}
	usage := func(input, output int64) oar.EventBody {
		return oar.Usage{Usage: oar.UsageReport{Tokens: &oar.TokenTotals{Input: input, Output: output, CacheRead: crewI(0), CacheWrite: crewI(0)}}}
	}
	first := crewSessionFacts(crewEv(usage(1_000_000, 0)), crewWorking(crewThinking), crewTracking{Price: &price}, crewCtx)
	farmtest.Eq(t, first.SpentCny, 7.0, "first yuan")
	farmtest.Eq(t, first.Facts, []protocol.FactValue{protocol.FactSpent{ID: "w1", Spent: protocol.Spent{Tokens: 1_000_000, CNY: crewF(7)}}}, "first")

	// The next report is a running total: only what is new counts, on top of what the helper had spent.
	h := crewWorking(crewThinking)
	h.Spent = &protocol.Spent{Tokens: 1_000_000, CNY: crewF(7)}
	second := crewSessionFacts(crewEv(usage(1_000_000, 500_000)), h, first.Tracking, crewCtx)
	farmtest.Eq(t, second.SpentCny, 7.0, "second yuan")
	farmtest.Eq(t, second.Facts, []protocol.FactValue{protocol.FactSpent{ID: "w1", Spent: protocol.Spent{Tokens: 1_500_000, CNY: crewF(14)}}}, "second")

	// No price yet: tokens only.
	unpriced := crewSessionFacts(crewEv(oar.Usage{Usage: oar.UsageReport{Tokens: &oar.TokenTotals{Input: 10, Output: 5}}}), crewWorking(crewThinking), crewTracking{}, crewCtx)
	farmtest.Eq(t, unpriced.SpentCny, 0.0, "unpriced yuan")
	farmtest.Eq(t, unpriced.Facts, []protocol.FactValue{protocol.FactSpent{ID: "w1", Spent: protocol.Spent{Tokens: 15}}}, "unpriced")

	farmtest.Eq(t, crewDollars(oar.TokenTotals{Input: 1_000_000, CacheRead: crewI(400_000), CacheWrite: crewI(0)}, price), 0.64, "dollars")
	farmtest.Eq(t, *crewSince(protocol.Spent{Tokens: 30, CNY: crewF(3)}, &protocol.Spent{Tokens: 10, CNY: crewF(1)}), protocol.Spent{Tokens: 20, CNY: crewF(2)}, "since")
	if crewSince(protocol.Spent{Tokens: 30}, nil) != nil {
		t.Fatal("since nothing is nothing")
	}
}

func TestCrewQuietEndsWithAWordNotWithUsage(t *testing.T) {
	doing := protocol.Doing{Action: protocol.WorkerActionRunCommand, Label: "pnpm build"}
	usage := crewSessionFacts(crewEv(oar.Usage{}), crewWorking(doing), crewTracking{Quiet: true}, crewCtx)
	farmtest.Eq(t, usage.Tracking.Quiet, true, "usage keeps quiet")
	farmtest.Eq(t, len(usage.Facts), 0, "usage facts")
	word := crewSessionFacts(crewEv(oar.TextDelta{Text: "构建完了"}), crewWorking(doing), crewTracking{Quiet: true}, crewCtx)
	farmtest.Eq(t, word.Tracking.Quiet, false, "a word ends it")
	farmtest.Eq(t, word.Facts, []protocol.FactValue{
		protocol.FactDoing{ID: "w1", Action: doing.Action, Label: doing.Label},
		protocol.FactDoing{ID: "w1", Action: protocol.WorkerActionSpeakingText},
	}, "facts")
}

func TestCrewRetriesModelFailuresAndExitsAreSaid(t *testing.T) {
	maxAttempts, delay := 3, int64(1500)
	retry := crewSessionFacts(crewEv(oar.Retry{Attempt: 2, MaxAttempts: &maxAttempts, DelayMs: &delay, Reason: "429"}), crewWorking(crewThinking), crewTracking{}, crewCtx)
	farmtest.Eq(t, retry.Facts, []protocol.FactValue{protocol.FactRetry{ID: "w1", Attempt: 2, Of: crewI(3)}}, "retry fact")
	farmtest.Eq(t, retry.Journal, []crewOp{{Type: "note", Kind: protocol.StepKindRetry, Text: "调用模型没成功，第 2/3 次重试，2 秒后：429"}}, "retry step")

	farmtest.Eq(t, crewSessionFacts(crewEv(oar.Model{Model: "deepseek-flash"}), crewWorking(crewThinking), crewTracking{}, crewCtx).Model, "deepseek-flash", "model")

	failed := crewSessionFacts(crewEv(oar.TurnEnded{Outcome: oar.Failed(oar.FailureBilling, "Insufficient Balance")}), crewWorking(crewThinking), crewTracking{}, crewCtx)
	farmtest.Eq(t, failed.Journal[0].Type, "note", "failed step")
	farmtest.Match(t, failed.Journal[0].Text, `^余额不够了：Insufficient Balance`, "failed text")

	code := 137
	h := crewWorking(crewThinking)
	h.Turns = 2
	exited := crewSessionFacts(crewEv(oar.Exited{Code: &code}), h, crewTracking{}, crewCtx)
	farmtest.Eq(t, exited.Facts, []protocol.FactValue{protocol.FactReport{ID: "w1", Outcome: protocol.OutcomeFailed, Summary: "pi 进程退出了（退出码 137）", Turns: 2}}, "exited")
	farmtest.Eq(t, exited.Warn, "老周 的 pi 进程退出了（退出码 137）", "warn")
	// Exiting between turns is no news.
	ripe := crewBase()
	ripe.Phase = protocol.Phase{Value: protocol.PhaseRipe{}}
	zero := 0
	farmtest.Eq(t, len(crewSessionFacts(crewEv(oar.Exited{Code: &zero}), &ripe, crewTracking{}, crewCtx).Facts), 0, "between turns")
}

func TestCrewNear(t *testing.T) {
	farmtest.Eq(t, crewNear("/work/p", "/work/p/src/a.ts"), "src/a.ts", "inside")
	farmtest.Eq(t, crewNear("/work/p", "/work/p"), ".", "itself")
	farmtest.Eq(t, crewNear("/work/p", "/etc/hosts"), "/etc/hosts", "outside")
	farmtest.Eq(t, crewNear("/work/p", "cd /work/p && pnpm test"), "pnpm test", "cd")
	farmtest.Eq(t, crewNear("/work/p", "cat /work/p/README.md"), "cat README.md", "inside a command")
}

// ── report.test.ts ───────────────────────────────────────────────────────────

func TestCrewSummaryIsTheVerdict(t *testing.T) {
	text := strings.Join([]string{"读了 src/http.ts。", "**结论：** 两个路由，POST /api/clock-in 和 POST /api/clock-out。", "（另外可选：README 第 3 行可以补个链接。）"}, "\n\n")
	farmtest.Eq(t, SummaryOf(text), "两个路由，POST /api/clock-in 和 POST /api/clock-out。", "bold verdict")
	farmtest.Eq(t, SummaryOf("前面的话\n\n- 结论：做完了，commit abc123"), "做完了，commit abc123", "listed verdict")
	farmtest.Match(t, SummaryOf("开头在看代码。\n\n最后：一切正常，测试 28 个都过了。"), `测试 28 个都过了`, "no verdict")
}

func TestCrewCompletedTurnRead(t *testing.T) {
	read := crewReadReport(oar.Completed(), "  改了路由。\n\n结论：加好了，commit abc123  ")
	farmtest.Eq(t, read, crewRead{Outcome: protocol.OutcomeCompleted, Text: "改了路由。\n\n结论：加好了，commit abc123", Summary: "加好了，commit abc123"}, "read")
	farmtest.Eq(t, crewReadReport(oar.Completed(), "").Summary, "做完了", "empty completed")
	farmtest.Eq(t, crewReadReport(oar.AbortedOutcome(), "").Outcome, protocol.OutcomeInterrupted, "aborted")
	farmtest.Eq(t, crewReadReport(oar.AbortedOutcome(), "").Summary, "没做完", "aborted summary")
}

func TestCrewFailedTurnLeadsWithWhy(t *testing.T) {
	status := 402
	outcome := oar.Failed(oar.FailureBilling, "Insufficient Balance")
	outcome.Status = &status
	billing := crewReadReport(outcome, "先看了看代码")
	farmtest.Eq(t, billing.Outcome, protocol.OutcomeFailed, "outcome")
	farmtest.Eq(t, billing.NeedsYou, true, "needs you")
	farmtest.Match(t, billing.Failure, `^余额不够了（HTTP 402）：Insufficient Balance`, "failure")
	farmtest.Eq(t, billing.Summary, crewClip(billing.Failure, 160), "summary")
	farmtest.Eq(t, billing.Text, billing.Failure+"\n\n先看了看代码", "text")
	// A busy provider is not for a person to fix.
	farmtest.Eq(t, crewReadReport(oar.Failed(oar.FailureOverloaded, ""), "").NeedsYou, false, "overloaded")
}

func TestCrewClip(t *testing.T) {
	farmtest.Eq(t, crewClip("a\n  b", 10), "a b", "one line")
	farmtest.Eq(t, crewClip("abcdefghij", 5), "abcd…", "cut")
}

// ── limits.test.ts ───────────────────────────────────────────────────────────

func crewLimitHelper(id, runtime, project string, working bool) protocol.Helper {
	phase := protocol.Phase{Value: protocol.PhaseRipe{}}
	if working {
		phase = protocol.Phase{Value: protocol.PhaseWorking{Doing: crewThinking}}
	}
	return protocol.Helper{ID: id, Name: id, Agent: "zhou", Runtime: runtime, Project: &project, Phase: phase}
}

func TestCrewRoomOnTheFarm(t *testing.T) {
	limits := crewLimits{Farm: 3, PerRuntime: 2, PerProject: 2}
	h := crewLimitHelper
	farmtest.Eq(t, crewNoRoom(nil, "pi", "a", limits, ""), "", "empty farm")
	farmtest.Match(t, crewNoRoom([]protocol.Helper{h("w1", "pi", "a", true), h("w2", "claude", "b", true), h("w3", "codex", "c", true)}, "pi", "a", limits, ""), `已经有 3 个帮工在干活了`, "farm")
	farmtest.Match(t, crewNoRoom([]protocol.Helper{h("w1", "pi", "a", true), h("w2", "pi", "b", true)}, "pi", "c", limits, ""), `最多同时 2 个（在 Runtime 页面可以改）`, "runtime")
	farmtest.Match(t, crewNoRoom([]protocol.Helper{h("w1", "pi", "a", true), h("w2", "claude", "a", true)}, "codex", "a", limits, ""), `项目 a 里已经有 2 个帮工在干活`, "project")

	two := []protocol.Helper{h("w1", "pi", "a", true), h("w2", "pi", "a", true)}
	farmtest.Eq(t, crewNoRoom([]protocol.Helper{h("w1", "pi", "a", false), h("w2", "pi", "a", false)}, "pi", "a", limits, ""), "", "only working count")
	if crewNoRoom(two, "pi", "a", limits, "") == "" {
		t.Fatal("two working fill it")
	}
	farmtest.Eq(t, crewNoRoom(two, "pi", "a", crewLimits{Farm: 6}, ""), "", "0 is no cap")
	farmtest.Eq(t, crewNoRoom(two, "pi", "a", crewLimits{Farm: 3, PerRuntime: 3, PerProject: 3}, "w1"), "", "not against itself")
}

func TestCrewHelperName(t *testing.T) {
	h := crewLimitHelper
	farmtest.Eq(t, crewHelperName(nil, "zhou", "老周"), "老周", "first")
	farmtest.Eq(t, crewHelperName([]protocol.Helper{h("w1", "pi", "a", true)}, "zhou", "老周"), "老周 2", "second")
	farmtest.Eq(t, crewHelperName([]protocol.Helper{h("w1", "pi", "a", true), h("w2", "pi", "a", true)}, "zhou", "老周"), "老周 3", "third")
}

func TestCrewChooseAgent(t *testing.T) {
	a := protocol.AgentProfile{ID: "a", Name: "甲", Runtime: "pi", Tags: []string{"前端"}}
	b := protocol.AgentProfile{ID: "b", Name: "乙", Runtime: "claude", Tags: []string{"测试", "后端"}}
	candidates := []Candidate{{a, true}, {b, true}}
	farmtest.Eq(t, ChooseAgent(candidates, "随便", "乙", "").ID, "b", "by name")
	farmtest.Eq(t, ChooseAgent(candidates, "随便", "claude", "").ID, "b", "by runtime")
	farmtest.Eq(t, ChooseAgent(candidates, "随便", "", "b").ID, "b", "picked")
	farmtest.Eq(t, ChooseAgent(candidates, "补后端测试", "", "").ID, "b", "by tags")
	farmtest.Eq(t, ChooseAgent(candidates, "随便", "", "").ID, "a", "first of equals")
}

func TestCrewCommentOnlyFromItsMark(t *testing.T) {
	if crewCommentOn("随便说一句") != nil {
		t.Fatal("a plain message comments on nothing")
	}
	if on := crewCommentOn(CommentText(protocol.WorkStep{N: 3, Kind: protocol.StepKindSaid, Text: "好"}, "再想想")); on == nil || *on != 3 {
		t.Fatalf("a comment on step 3: %v", on)
	}
}
