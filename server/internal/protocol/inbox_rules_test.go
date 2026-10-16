package protocol

// TestReduceGolden compares the inbox only after whole facts; these go case by case.

import (
	"strings"
	"testing"
)

const callsT = int64(1_800_000_000_000)

var callsManager = InboxFrom{InboxFromManager{}}

func callsHelper(id string, phase PhaseValue, change ...func(*Helper)) Helper {
	h := Helper{
		ID: id, Name: "后端老周", Agent: "lab", Runtime: "pi", Task: "加个打卡接口", HiredAt: callsT, Turns: 2, Phase: Phase{phase},
		Last: &LastTurn{Outcome: OutcomeCompleted, Summary: "接口加好了", At: callsT + 10},
	}
	for _, c := range change {
		c(&h)
	}
	return h
}

func callsFailedTurn(h *Helper) {
	h.Last = &LastTurn{Outcome: OutcomeFailed, Summary: "测试没过", At: callsT + 20}
}

func callsConflict(files ...string) func(*Helper) {
	return func(h *Helper) { h.Conflict = &Conflict{Base: "main", Files: files} }
}

func callsQuiet(since int64) PhaseWorking {
	return PhaseWorking{Since: callsT + 30, Doing: Doing{Action: WorkerActionRunCommand, Label: "go test ./..."}, QuietSince: rulesPtr(since)}
}

func callsFarm(helpers ...Helper) FarmState {
	s := EmptyFarm()
	s.Helpers = append(s.Helpers, helpers...)
	return s
}

func callsStep(id, title string, state NodeState) PlaybookNode {
	return PlaybookNode{ID: id, Title: title, Task: "做" + title, Needs: []string{}, State: state}
}

func callsPlaybook(id, title string, state PlaybookState, steps ...PlaybookNode) Playbook {
	if steps == nil {
		steps = []PlaybookNode{}
	}
	return Playbook{ID: id, Title: title, Goal: title, Project: "clock", State: state, Nodes: steps, Parallel: 2, CreatedAt: callsT}
}

func callsWithPlaybooks(playbooks ...Playbook) FarmState {
	return withPlaybooks(EmptyFarm(), playbooks...)
}

func callsMessage(seq int64, change ...func(*ChatMessage)) ChatMessage {
	m := ChatMessage{
		Seq: seq, Conversation: 1, From: "foreman", FromKind: SenderKindForeman, Name: "管家", Kind: MessageKindChat,
		Text: "@主人 这块地能收了", Final: true, Mentions: []string{"user"}, At: callsT + seq,
	}
	for _, c := range change {
		c(&m)
	}
	return m
}

func callsInThread(m *ChatMessage) { m.Conversation = 2 }

func callsChat(squareRead, threadRead *int64, messages ...ChatMessage) *Chat {
	return &Chat{
		Conversations: []Conversation{
			{ID: 1, Kind: ConversationKindSquare, Name: rulesPtr("田头"), Read: squareRead, At: callsT},
			{ID: 2, Kind: ConversationKindThread, Parent: rulesPtr(int64(1)), SubjectKind: rulesPtr(SubjectKindJob), SubjectID: rulesPtr("w1"), Read: threadRead, At: callsT},
		},
		Messages: append([]ChatMessage{}, messages...),
	}
}

func callsWithChat(chat *Chat) FarmState {
	s := EmptyFarm()
	s.Chat = chat
	return s
}

func callsFromHelper(id, name, agent string) InboxFrom {
	return InboxFrom{InboxFromHelper{ID: id, Name: name, Agent: agent}}
}

func callsToWorker(id string) InboxTarget { return InboxTarget{InboxTargetWorker{ID: id}} }

func callsToPlans(playbook string) InboxTarget {
	return InboxTarget{InboxTargetPlans{Playbook: playbook}}
}

func callsToChat(conversation int64) InboxTarget {
	return InboxTarget{InboxTargetChat{Conversation: conversation}}
}

func callsIDs(calls []InboxItem) []string {
	out := []string{}
	for _, c := range calls {
		out = append(out, c.ID)
	}
	return out
}

func callsRows(calls []InboxItem) [][4]any {
	out := [][4]any{}
	for _, c := range calls {
		out = append(out, [4]any{c.ID, c.Kind, c.Text, c.At})
	}
	return out
}

func TestInboxEmptyFarm(t *testing.T) {
	// An empty list, not nil: the frame's calls go out as [], never null.
	rulesEqual(t, Inbox(EmptyFarm()), []InboxItem{})
	rulesEqual(t, Inbox(callsWithChat(callsChat(nil, nil))), []InboxItem{})
}

func TestInboxRipeHelperCalls(t *testing.T) {
	rulesEqual(t, Inbox(callsFarm(callsHelper("w1", PhaseRipe{}))), []InboxItem{{
		ID: "w1:harvest:2", Kind: InboxKindHarvest, From: callsFromHelper("w1", "后端老周", "lab"), Text: "接口加好了", At: callsT + 10, Target: callsToWorker("w1"),
	}})
}

func TestInboxFailedHelperCalls(t *testing.T) {
	rulesEqual(t, Inbox(callsFarm(callsHelper("w1", PhaseFailed{}, callsFailedTurn))), []InboxItem{{
		ID: "w1:fix:2", Kind: InboxKindFix, From: callsFromHelper("w1", "后端老周", "lab"), Text: "测试没过", At: callsT + 20, Target: callsToWorker("w1"),
	}})
}

func TestInboxConflictCalls(t *testing.T) {
	ripe := callsHelper("w1", PhaseRipe{}, callsConflict("api/clock.go", "api/clock_test.go"))
	resting := callsHelper("w2", PhaseResting{}, callsConflict("web/clock.tsx"), func(h *Helper) {
		h.Name, h.Agent, h.Turns = "前端小林", "codex", 3
		h.Last = &LastTurn{Outcome: OutcomeInterrupted, At: callsT + 5}
	})
	rulesEqual(t, Inbox(callsFarm(ripe, resting)), []InboxItem{
		{ID: "w1:conflict:2", Kind: InboxKindConflict, From: callsFromHelper("w1", "后端老周", "lab"), Text: "2 个文件和主分支冲突", At: callsT + 10, Target: callsToWorker("w1")},
		{ID: "w2:conflict:3", Kind: InboxKindConflict, From: callsFromHelper("w2", "前端小林", "codex"), Text: "1 个文件和主分支冲突", At: callsT + 5, Target: callsToWorker("w2")},
	})
}

func TestInboxQuietHelperCalls(t *testing.T) {
	rulesEqual(t, Inbox(callsFarm(callsHelper("w1", callsQuiet(callsT+90)))), []InboxItem{{
		ID: "w1:quiet:1800000000090", Kind: InboxKindQuiet, From: callsFromHelper("w1", "后端老周", "lab"), Text: "加个打卡接口", At: callsT + 90, Target: callsToWorker("w1"),
	}})
}

func TestInboxMostPressingNeedOnly(t *testing.T) {
	quietRetrying := callsQuiet(callsT + 90)
	quietRetrying.Retry = &Retry{Attempt: 2, Of: rulesPtr(int64(3))}
	for _, c := range []struct {
		name   string
		helper Helper
		want   [][4]any
	}{
		{"a conflict before the harvest", callsHelper("w1", PhaseRipe{}, callsConflict("a.go")), [][4]any{{"w1:conflict:2", InboxKindConflict, "1 个文件和主分支冲突", callsT + 10}}},
		{"a failed turn before its conflict", callsHelper("w1", PhaseFailed{}, callsFailedTurn, callsConflict("a.go")), [][4]any{{"w1:fix:2", InboxKindFix, "测试没过", callsT + 20}}},
		{"quiet while retrying", callsHelper("w1", quietRetrying), [][4]any{{"w1:quiet:1800000000090", InboxKindQuiet, "加个打卡接口", callsT + 90}}},
	} {
		t.Run(c.name, func(t *testing.T) { rulesEqual(t, callsRows(Inbox(callsFarm(c.helper))), c.want) })
	}
}

func TestInboxHelpersWithNothingToAskDoNotCall(t *testing.T) {
	for _, c := range []struct {
		name  string
		phase PhaseValue
	}{
		{"arriving", PhaseArriving{}},
		{"working", PhaseWorking{Since: callsT + 30, Doing: Doing{Action: WorkerActionEditFile, Label: "api/clock.go"}}},
		{"retrying", PhaseWorking{Since: callsT + 30, Doing: Doing{Action: WorkerActionThinking}, Retry: &Retry{Attempt: 2, Of: rulesPtr(int64(3))}}},
		{"resting with nothing in the way", PhaseResting{}},
	} {
		t.Run(c.name, func(t *testing.T) {
			rulesEqual(t, Inbox(callsFarm(callsHelper("w1", c.phase))), []InboxItem{})
		})
	}
}

func TestInboxPlaybookHelpersLeaveItToThePlaybook(t *testing.T) {
	inPlaybook := func(h *Helper) { h.Playbook = &HelperPlaybook{ID: "p1", Node: rulesPtr("api")} }
	for _, c := range []struct {
		name   string
		helper Helper
	}{
		{"ripe", callsHelper("w1", PhaseRipe{}, inPlaybook)},
		{"failed", callsHelper("w1", PhaseFailed{}, callsFailedTurn, inPlaybook)},
		{"conflicted", callsHelper("w1", PhaseResting{}, callsConflict("a.go"), inPlaybook)},
	} {
		t.Run(c.name, func(t *testing.T) { rulesEqual(t, Inbox(callsFarm(c.helper)), []InboxItem{}) })
	}
	rulesEqual(t, callsIDs(Inbox(callsFarm(callsHelper("w1", callsQuiet(callsT+90), inPlaybook)))), []string{"w1:quiet:1800000000090"})
	state := callsFarm(callsHelper("w1", PhaseFailed{}, callsFailedTurn, inPlaybook))
	state = withPlaybooks(state, callsPlaybook("p1", "打卡", PlaybookStateRunning, callsStep("api", "接口", NodeStateFailed)))
	rulesEqual(t, Inbox(state), []InboxItem{{
		ID: "p1:failed:api", Kind: InboxKindPlanFailed, From: callsManager, Text: "打卡：接口", At: callsT, Target: callsToPlans("p1"),
	}})
}

func TestInboxHelperTextAndTime(t *testing.T) {
	said := func(summary string) func(*Helper) { return func(h *Helper) { h.Last.Summary = summary } }
	noTurn := func(h *Helper) { h.Last = nil }
	for _, c := range []struct {
		name   string
		helper Helper
		want   [][4]any
	}{
		{"what the turn said", callsHelper("w1", PhaseRipe{}), [][4]any{{"w1:harvest:2", InboxKindHarvest, "接口加好了", callsT + 10}}},
		{"the task when the turn said nothing", callsHelper("w1", PhaseRipe{}, said("")), [][4]any{{"w1:harvest:2", InboxKindHarvest, "加个打卡接口", callsT + 10}}},
		{"the task and the hiring before any turn", callsHelper("w1", PhaseRipe{}, noTurn), [][4]any{{"w1:harvest:2", InboxKindHarvest, "加个打卡接口", callsT}}},
		{"a failed turn that said nothing", callsHelper("w1", PhaseFailed{}, callsFailedTurn, said("")), [][4]any{{"w1:fix:2", InboxKindFix, "加个打卡接口", callsT + 20}}},
		{"a conflict before any turn", callsHelper("w1", PhaseResting{}, callsConflict("a.go"), noTurn), [][4]any{{"w1:conflict:2", InboxKindConflict, "1 个文件和主分支冲突", callsT}}},
	} {
		t.Run(c.name, func(t *testing.T) { rulesEqual(t, callsRows(Inbox(callsFarm(c.helper))), c.want) })
	}
}

func TestInboxHelperCallIDs(t *testing.T) {
	idsOf := func(helpers ...Helper) []string { return callsIDs(Inbox(callsFarm(helpers...))) }
	rulesEqual(t, idsOf(callsHelper("w1", PhaseRipe{})), []string{"w1:harvest:2"})
	rulesEqual(t, idsOf(callsHelper("w1", PhaseRipe{}, func(h *Helper) { h.Last.Summary, h.Last.At = "接口加好了，测试也补了", callsT+99 })), []string{"w1:harvest:2"})
	nextTurn := func(h *Helper) { h.Turns = 3 }
	rulesEqual(t, idsOf(callsHelper("w1", PhaseRipe{}, nextTurn)), []string{"w1:harvest:3"})
	rulesEqual(t, idsOf(callsHelper("w1", PhaseFailed{}, callsFailedTurn)), []string{"w1:fix:2"})
	rulesEqual(t, idsOf(callsHelper("w1", PhaseFailed{}, callsFailedTurn, nextTurn)), []string{"w1:fix:3"})
	rulesEqual(t, idsOf(callsHelper("w1", PhaseRipe{}, callsConflict("a.go"))), []string{"w1:conflict:2"})
	rulesEqual(t, idsOf(callsHelper("w1", PhaseRipe{}, callsConflict("a.go", "b.go", "c.go"))), []string{"w1:conflict:2"})
	rulesEqual(t, idsOf(callsHelper("w1", callsQuiet(callsT+90))), []string{"w1:quiet:1800000000090"})
	rulesEqual(t, idsOf(callsHelper("w1", callsQuiet(callsT+300))), []string{"w1:quiet:1800000000300"})
	rulesEqual(t, idsOf(callsHelper("w1", PhaseRipe{}), callsHelper("w2", PhaseRipe{})), []string{"w1:harvest:2", "w2:harvest:2"})
}

func TestInboxPlaybookCalls(t *testing.T) {
	madeAt := func(pb Playbook, ms int64) Playbook {
		pb.CreatedAt = callsT + ms
		return pb
	}
	state := callsWithPlaybooks(
		madeAt(callsPlaybook("p1", "打卡", PlaybookStateDraft, callsStep("db", "建表", NodeStateWaiting)), 1),
		madeAt(callsPlaybook("p2", "导出", PlaybookStateRipe, callsStep("csv", "导出 CSV", NodeStateMerged), callsStep("pdf", "导出 PDF", NodeStateSkipped)), 2),
		madeAt(callsPlaybook("p3", "报表", PlaybookStateRunning,
			callsStep("db", "建表", NodeStateMerged),
			callsStep("api", "接口", NodeStateFailed),
			callsStep("job", "定时任务", NodeStateWorking),
			callsStep("ui", "页面", NodeStateFailed),
			callsStep("docs", "文档", NodeStateWaiting),
		), 3),
		madeAt(callsPlaybook("p4", "迁移", PlaybookStatePaused, callsStep("copy", "拷数据", NodeStateFailed), callsStep("drop", "删旧表", NodeStateSkipped)), 4),
	)
	rulesEqual(t, Inbox(state), []InboxItem{
		{ID: "p4:failed:copy", Kind: InboxKindPlanFailed, From: callsManager, Text: "迁移：拷数据", At: callsT + 4, Target: callsToPlans("p4")},
		{ID: "p3:failed:api", Kind: InboxKindPlanFailed, From: callsManager, Text: "报表：接口", At: callsT + 3, Target: callsToPlans("p3")},
		{ID: "p3:failed:ui", Kind: InboxKindPlanFailed, From: callsManager, Text: "报表：页面", At: callsT + 3, Target: callsToPlans("p3")},
		{ID: "p2:ripe", Kind: InboxKindPlanRipe, From: callsManager, Text: "导出", At: callsT + 2, Target: callsToPlans("p2")},
		{ID: "p1:draft", Kind: InboxKindPlanDraft, From: callsManager, Text: "打卡", At: callsT + 1, Target: callsToPlans("p1")},
	})
}

func TestInboxPlaybooksThatDoNotCall(t *testing.T) {
	for _, c := range []struct {
		name     string
		playbook Playbook
	}{
		{"still being planned", callsPlaybook("p1", "打卡", PlaybookStatePlanning)},
		{"running with no step failed", callsPlaybook("p1", "打卡", PlaybookStateRunning,
			callsStep("db", "建表", NodeStateMerged), callsStep("api", "接口", NodeStateWorking), callsStep("ui", "页面", NodeStateWaiting), callsStep("docs", "文档", NodeStateSkipped))},
		{"paused with no step failed", callsPlaybook("p1", "打卡", PlaybookStatePaused, callsStep("api", "接口", NodeStateWaiting))},
		{"harvested", callsPlaybook("p1", "打卡", PlaybookStateDone, callsStep("api", "接口", NodeStateMerged))},
		{"abandoned with a step failed", callsPlaybook("p1", "打卡", PlaybookStateAbandoned, callsStep("api", "接口", NodeStateFailed))},
	} {
		t.Run(c.name, func(t *testing.T) { rulesEqual(t, Inbox(callsWithPlaybooks(c.playbook)), []InboxItem{}) })
	}
}

func TestInboxPlaybookCallIDs(t *testing.T) {
	draft := callsPlaybook("p1", "打卡", PlaybookStateDraft, callsStep("api", "接口", NodeStateWaiting))
	edited := callsPlaybook("p1", "打卡和导出", PlaybookStateDraft, callsStep("api", "接口和导出", NodeStateWaiting), callsStep("csv", "导出", NodeStateWaiting))
	rulesEqual(t, callsIDs(Inbox(callsWithPlaybooks(draft))), []string{"p1:draft"})
	rulesEqual(t, callsIDs(Inbox(callsWithPlaybooks(edited))), []string{"p1:draft"})
	stuck := func(id string) Playbook {
		return callsPlaybook(id, "打卡", PlaybookStateRunning, callsStep("api", "接口", NodeStateFailed))
	}
	rulesEqual(t, callsIDs(Inbox(callsWithPlaybooks(stuck("p1"), stuck("p2")))), []string{"p1:failed:api", "p2:failed:api"})
	again := stuck("p1")
	again.Nodes[0].Failures = 2
	rulesEqual(t, callsIDs(Inbox(callsWithPlaybooks(again))), []string{"p1:failed:api:2"})
	once := stuck("p1")
	once.Nodes[0].Failures = 1
	rulesEqual(t, callsIDs(Inbox(callsWithPlaybooks(once))), []string{"p1:failed:api"})
}

func TestInboxMentionCalls(t *testing.T) {
	state := callsWithChat(callsChat(nil, nil,
		callsMessage(4),
		callsMessage(5, callsInThread, func(m *ChatMessage) {
			m.From, m.FromKind, m.Name, m.Agent, m.Text = "w1", SenderKindHelper, "后端老周", rulesPtr("lab"), "@主人 接口要按月查吗？"
		}),
		callsMessage(6, callsInThread, func(m *ChatMessage) {
			m.From, m.FromKind, m.Name, m.Text = "w2", SenderKindHelper, "前端小林", "@主人 页面缺设计稿"
		}),
	))
	rulesEqual(t, Inbox(state), []InboxItem{
		{ID: "m6", Kind: InboxKindMention, From: callsFromHelper("w2", "前端小林", ""), Text: "@主人 页面缺设计稿", At: callsT + 6, Target: callsToChat(2)},
		{ID: "m5", Kind: InboxKindMention, From: callsFromHelper("w1", "后端老周", "lab"), Text: "@主人 接口要按月查吗？", At: callsT + 5, Target: callsToChat(2)},
		{ID: "m4", Kind: InboxKindMention, From: callsManager, Text: "@主人 这块地能收了", At: callsT + 4, Target: callsToChat(1)},
	})
}

func TestInboxMessagesThatDoNotCall(t *testing.T) {
	farm := func(read *int64, m ChatMessage) FarmState { return callsWithChat(callsChat(read, nil, m)) }
	rulesEqual(t, callsIDs(Inbox(farm(rulesPtr(int64(4)), callsMessage(5)))), []string{"m5"})
	for _, c := range []struct {
		name   string
		read   *int64
		change func(*ChatMessage)
	}{
		{"still being said", nil, func(m *ChatMessage) { m.Final = false }},
		{"the owner's own, naming the owner", nil, func(m *ChatMessage) { m.From, m.FromKind, m.Name = "user", SenderKindUser, "主人" }},
		{"read", rulesPtr(int64(5)), nil},
		{"read and more after it", rulesPtr(int64(9)), nil},
		{"naming no one", nil, func(m *ChatMessage) { m.Mentions = nil }},
		{"naming others", nil, func(m *ChatMessage) { m.Mentions = []string{"w1", "foreman"} }},
		{"in a conversation the chat does not keep", nil, func(m *ChatMessage) { m.Conversation = 9 }},
	} {
		t.Run(c.name, func(t *testing.T) {
			m := callsMessage(5)
			if c.change != nil {
				c.change(&m)
			}
			rulesEqual(t, Inbox(farm(c.read, m)), []InboxItem{})
		})
	} // Answered, even unread: the person said something in that conversation after it.
	answer := callsMessage(6, func(m *ChatMessage) { m.From, m.FromKind, m.Name, m.Mentions = "user", SenderKindUser, "主人", nil })
	rulesEqual(t, Inbox(callsWithChat(callsChat(nil, nil, callsMessage(5), answer))), []InboxItem{})
}

func TestInboxReadMarkerIsPerConversation(t *testing.T) {
	state := callsWithChat(callsChat(rulesPtr(int64(7)), nil, callsMessage(3), callsMessage(4, callsInThread), callsMessage(7), callsMessage(8)))
	rulesEqual(t, callsIDs(Inbox(state)), []string{"m8", "m4"})
}

func TestInboxClipTheirWords(t *testing.T) {
	// 40 UTF-16 units, as the page counts them.
	fits, long := strings.Repeat("改", 40), strings.Repeat("改", 41)
	clipped := fits + "…"
	said := func(summary string) func(*Helper) { return func(h *Helper) { h.Last.Summary = summary } }
	task := func(task string) func(*Helper) { return func(h *Helper) { h.Task = task } }
	for _, c := range []struct {
		name  string
		state FarmState
		want  string
	}{
		{"a summary that fits", callsFarm(callsHelper("w1", PhaseRipe{}, said(fits))), fits},
		{"a long summary", callsFarm(callsHelper("w1", PhaseRipe{}, said(long))), clipped},
		{"a failed turn's long summary", callsFarm(callsHelper("w1", PhaseFailed{}, callsFailedTurn, said(long))), clipped},
		{"a long task, the turn saying nothing", callsFarm(callsHelper("w1", PhaseRipe{}, said(""), task(long))), clipped},
		{"two-unit characters, 40 units", callsFarm(callsHelper("w1", PhaseRipe{}, said(strings.Repeat("🌾", 20)))), strings.Repeat("🌾", 20)},
		{"two-unit characters, 42 units", callsFarm(callsHelper("w1", PhaseRipe{}, said(strings.Repeat("🌾", 21)))), strings.Repeat("🌾", 20) + "…"},
		{"a quiet helper's long task", callsFarm(callsHelper("w1", callsQuiet(callsT+90), task(long))), clipped},
		{"a draft's long title", callsWithPlaybooks(callsPlaybook("p1", long, PlaybookStateDraft)), clipped},
		{"a ripe playbook's long title", callsWithPlaybooks(callsPlaybook("p1", long, PlaybookStateRipe)), clipped},
		{"a stuck step with its playbook's title", callsWithPlaybooks(callsPlaybook("p1", strings.Repeat("计", 30), PlaybookStateRunning,
			callsStep("api", strings.Repeat("步", 10), NodeStateFailed))), strings.Repeat("计", 30) + "：" + strings.Repeat("步", 9) + "…"},
		{"a long message", callsWithChat(callsChat(nil, nil, callsMessage(5, func(m *ChatMessage) { m.Text = long }))), clipped},
	} {
		t.Run(c.name, func(t *testing.T) {
			texts := []string{}
			for _, call := range Inbox(c.state) {
				texts = append(texts, call.Text)
			}
			rulesEqual(t, texts, []string{c.want})
		})
	}
}

func TestInboxNewestFirst(t *testing.T) {
	endedAt := func(at int64) func(*Helper) { return func(h *Helper) { h.Last.At = at } }
	state := callsFarm(
		callsHelper("w1", PhaseRipe{}, endedAt(callsT+30)),
		callsHelper("w2", PhaseFailed{}, callsFailedTurn),
		callsHelper("w3", PhaseResting{}, callsConflict("a.go"), endedAt(callsT+10)),
		callsHelper("w4", callsQuiet(callsT+40)),
		callsHelper("w5", PhaseArriving{}),
	)
	draft := callsPlaybook("p1", "打卡", PlaybookStateDraft)
	draft.CreatedAt = callsT + 5
	stuck := callsPlaybook("p2", "导出", PlaybookStateRunning, callsStep("csv", "导出 CSV", NodeStateFailed))
	stuck.CreatedAt = callsT + 25
	state = withPlaybooks(state, draft, stuck)
	state.Chat = callsChat(nil, nil, callsMessage(50))
	timeline := [][2]any{}
	for _, c := range Inbox(state) {
		timeline = append(timeline, [2]any{c.ID, c.At})
	}
	rulesEqual(t, timeline, [][2]any{
		{"m50", callsT + 50},
		{"w4:quiet:1800000000040", callsT + 40},
		{"w1:harvest:2", callsT + 30},
		{"p2:failed:csv", callsT + 25},
		{"w2:fix:2", callsT + 20},
		{"w3:conflict:2", callsT + 10},
		{"p1:draft", callsT + 5},
	})
}

func TestInboxTiesKeepTheirOrder(t *testing.T) {
	endedNow := func(h *Helper) { h.Last.At = callsT }
	saidNow := func(m *ChatMessage) { m.At = callsT }
	state := callsFarm(callsHelper("w2", PhaseRipe{}, endedNow), callsHelper("w1", PhaseFailed{}, callsFailedTurn, endedNow))
	state = withPlaybooks(state,
		callsPlaybook("p2", "导出", PlaybookStateDraft),
		callsPlaybook("p1", "报表", PlaybookStateRunning, callsStep("b", "页面", NodeStateFailed), callsStep("a", "接口", NodeStateFailed)),
	)
	state.Chat = callsChat(nil, nil, callsMessage(3, callsInThread, saidNow), callsMessage(4, saidNow))
	rulesEqual(t, callsIDs(Inbox(state)), []string{"w2:harvest:2", "w1:fix:2", "p1:failed:b", "p1:failed:a", "p2:draft", "m4", "m3"})
}
