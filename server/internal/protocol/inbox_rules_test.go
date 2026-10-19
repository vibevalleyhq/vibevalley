package protocol

// TestReduceGolden compares the inbox only after whole facts; these go case by case.

import (
	"fmt"
	"strings"
	"testing"

	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

const callsT = int64(1_800_000_000_000)

var callsManager = InboxFrom{InboxFromManager{}}

func callsSession(id string, phase PhaseValue, change ...func(*Session)) Session {
	h := Session{
		ID: id, Name: "后端老周", Agent: "lab", Runtime: "pi", Brief: "加个打卡接口", HiredAt: callsT, Runs: 2, Phase: Phase{phase},
		LastRun: &LastRun{Outcome: OutcomeCompleted, Summary: "接口加好了", At: callsT + 10},
	}
	for _, c := range change {
		c(&h)
	}
	return h
}

func callsFailedRun(h *Session) {
	h.LastRun = &LastRun{Outcome: OutcomeFailed, Summary: "测试没过", At: callsT + 20}
}

func callsConflict(files ...string) func(*Session) {
	return func(h *Session) { h.Conflict = &Conflict{Base: "main", Files: files} }
}

func callsQuiet(since int64) PhaseWorking {
	return PhaseWorking{Since: callsT + 30, Doing: Doing{Action: SessionActionRunCommand, Label: "go test ./..."}, QuietSince: ptr.To(since)}
}

func callsState(sessions ...Session) CoreState {
	s := EmptyCoreState()
	s.Sessions = append(s.Sessions, sessions...)
	return s
}

func callsTask(id, title string, state TaskState) Task {
	return Task{ID: id, Title: title, Brief: "做" + title, Needs: []string{}, State: state}
}

func callsGraph(id, title string, state GraphState, tasks ...Task) TaskGraph {
	if tasks == nil {
		tasks = []Task{}
	}
	return TaskGraph{ID: id, Title: title, Goal: title, Project: "clock", State: state, Tasks: tasks, Parallel: 2, CreatedAt: callsT}
}

func callsWithGraphs(graphs ...TaskGraph) CoreState {
	return withGraphs(EmptyCoreState(), graphs...)
}

func callsMessage(seq int64, change ...func(*ChatMessage)) ChatMessage {
	m := ChatMessage{
		ID: fmt.Sprintf("m%d", seq), Number: seq, Conversation: "c1", From: ManagerAgent, FromKind: SenderKindManager, Name: "管家", Kind: MessageKindChat,
		Text: "@主人 这块地能收了", Final: true, Mentions: []string{"user"}, At: callsT + seq,
	}
	for _, c := range change {
		c(&m)
	}
	return m
}

func callsInThread(m *ChatMessage) { m.Conversation = "c2" }

func callsChat(generalRead, threadRead *int64, messages ...ChatMessage) *Chat {
	return &Chat{
		Conversations: []Conversation{
			{ID: "c1", Kind: ConversationKindGeneral, Name: ptr.To("田头"), Read: generalRead, At: callsT},
			{ID: "c2", Kind: ConversationKindThread, Parent: ptr.To("m1"), ParentNumber: ptr.To(int64(1)), SubjectKind: ptr.To(SubjectKindIssue), SubjectID: ptr.To("w1"), Read: threadRead, At: callsT},
		},
		Messages: append([]ChatMessage{}, messages...),
	}
}

func callsWithChat(chat *Chat) CoreState {
	s := EmptyCoreState()
	s.Chat = chat
	return s
}

func callsFromSession(id, name, agent string) InboxFrom {
	return InboxFrom{InboxFromSession{ID: id, Name: name, Agent: agent}}
}

func callsToSession(id string) InboxTarget { return InboxTarget{InboxTargetSession{ID: id}} }

func callsToGraphs(task string) InboxTarget {
	return InboxTarget{InboxTargetGraph{Graph: task}}
}

func callsToChat(conversation string) InboxTarget {
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
	testkit.Eq(t, Inbox(EmptyCoreState()), []InboxItem{})
	testkit.Eq(t, Inbox(callsWithChat(callsChat(nil, nil))), []InboxItem{})
}

func TestInboxRipeSessionCalls(t *testing.T) {
	testkit.Eq(t, Inbox(callsState(callsSession("w1", PhaseRipe{}))), []InboxItem{{
		ID: "w1:merge:2", Kind: InboxKindMerge, From: callsFromSession("w1", "后端老周", "lab"), Text: "接口加好了", At: callsT + 10, Target: callsToSession("w1"),
	}})
}

func TestInboxFailedSessionCalls(t *testing.T) {
	testkit.Eq(t, Inbox(callsState(callsSession("w1", PhaseFailed{}, callsFailedRun))), []InboxItem{{
		ID: "w1:fix:2", Kind: InboxKindFix, From: callsFromSession("w1", "后端老周", "lab"), Text: "测试没过", At: callsT + 20, Target: callsToSession("w1"),
	}})
}

func TestInboxConflictCalls(t *testing.T) {
	ripe := callsSession("w1", PhaseRipe{}, callsConflict("api/clock.go", "api/clock_test.go"))
	resting := callsSession("w2", PhaseResting{}, callsConflict("web/clock.tsx"), func(h *Session) {
		h.Name, h.Agent, h.Runs = "前端小林", "codex", 3
		h.LastRun = &LastRun{Outcome: OutcomeInterrupted, At: callsT + 5}
	})
	testkit.Eq(t, Inbox(callsState(ripe, resting)), []InboxItem{
		{ID: "w1:conflict:2", Kind: InboxKindConflict, From: callsFromSession("w1", "后端老周", "lab"), Text: "2 个文件和主分支冲突", At: callsT + 10, Target: callsToSession("w1")},
		{ID: "w2:conflict:3", Kind: InboxKindConflict, From: callsFromSession("w2", "前端小林", "codex"), Text: "1 个文件和主分支冲突", At: callsT + 5, Target: callsToSession("w2")},
	})
}

func TestInboxQuietSessionCalls(t *testing.T) {
	testkit.Eq(t, Inbox(callsState(callsSession("w1", callsQuiet(callsT+90)))), []InboxItem{{
		ID: "w1:quiet:1800000000090", Kind: InboxKindQuiet, From: callsFromSession("w1", "后端老周", "lab"), Text: "加个打卡接口", At: callsT + 90, Target: callsToSession("w1"),
	}})
}

func TestInboxMostPressingNeedOnly(t *testing.T) {
	quietRetrying := callsQuiet(callsT + 90)
	quietRetrying.Retry = &Retry{Attempt: 2, Of: ptr.To(int64(3))}
	for _, c := range []struct {
		name    string
		session Session
		want    [][4]any
	}{
		{"a conflict before the harvest", callsSession("w1", PhaseRipe{}, callsConflict("a.go")), [][4]any{{"w1:conflict:2", InboxKindConflict, "1 个文件和主分支冲突", callsT + 10}}},
		{"a failed turn before its conflict", callsSession("w1", PhaseFailed{}, callsFailedRun, callsConflict("a.go")), [][4]any{{"w1:fix:2", InboxKindFix, "测试没过", callsT + 20}}},
		{"quiet while retrying", callsSession("w1", quietRetrying), [][4]any{{"w1:quiet:1800000000090", InboxKindQuiet, "加个打卡接口", callsT + 90}}},
	} {
		t.Run(c.name, func(t *testing.T) { testkit.Eq(t, callsRows(Inbox(callsState(c.session))), c.want) })
	}
}

func TestInboxSessionsWithNothingToAskDoNotCall(t *testing.T) {
	for _, c := range []struct {
		name  string
		phase PhaseValue
	}{
		{"arriving", PhaseArriving{}},
		{"working", PhaseWorking{Since: callsT + 30, Doing: Doing{Action: SessionActionEditFile, Label: "api/clock.go"}}},
		{"retrying", PhaseWorking{Since: callsT + 30, Doing: Doing{Action: SessionActionThinking}, Retry: &Retry{Attempt: 2, Of: ptr.To(int64(3))}}},
		{"resting with nothing in the way", PhaseResting{}},
	} {
		t.Run(c.name, func(t *testing.T) {
			testkit.Eq(t, Inbox(callsState(callsSession("w1", c.phase))), []InboxItem{})
		})
	}
}

func TestInboxTaskSessionsLeaveItToTheTask(t *testing.T) {
	inGraph := func(h *Session) { h.Graph = &SessionGraph{ID: "p1", Task: ptr.To("api")} }
	for _, c := range []struct {
		name    string
		session Session
	}{
		{"ripe", callsSession("w1", PhaseRipe{}, inGraph)},
		{"failed", callsSession("w1", PhaseFailed{}, callsFailedRun, inGraph)},
		{"conflicted", callsSession("w1", PhaseResting{}, callsConflict("a.go"), inGraph)},
	} {
		t.Run(c.name, func(t *testing.T) { testkit.Eq(t, Inbox(callsState(c.session)), []InboxItem{}) })
	}
	testkit.Eq(t, callsIDs(Inbox(callsState(callsSession("w1", callsQuiet(callsT+90), inGraph)))), []string{"w1:quiet:1800000000090"})
	state := callsState(callsSession("w1", PhaseFailed{}, callsFailedRun, inGraph))
	state = withGraphs(state, callsGraph("p1", "打卡", GraphStateRunning, callsTask("api", "接口", TaskStateFailed)))
	testkit.Eq(t, Inbox(state), []InboxItem{{
		ID: "p1:failed:api", Kind: InboxKindTaskFailed, From: callsManager, Text: "打卡：接口", At: callsT, Target: callsToGraphs("p1"),
	}})
}

func TestInboxSessionTextAndTime(t *testing.T) {
	said := func(summary string) func(*Session) { return func(h *Session) { h.LastRun.Summary = summary } }
	noRun := func(h *Session) { h.LastRun = nil }
	for _, c := range []struct {
		name    string
		session Session
		want    [][4]any
	}{
		{"what the turn said", callsSession("w1", PhaseRipe{}), [][4]any{{"w1:merge:2", InboxKindMerge, "接口加好了", callsT + 10}}},
		{"the task when the turn said nothing", callsSession("w1", PhaseRipe{}, said("")), [][4]any{{"w1:merge:2", InboxKindMerge, "加个打卡接口", callsT + 10}}},
		{"the task and the hiring before any turn", callsSession("w1", PhaseRipe{}, noRun), [][4]any{{"w1:merge:2", InboxKindMerge, "加个打卡接口", callsT}}},
		{"a failed turn that said nothing", callsSession("w1", PhaseFailed{}, callsFailedRun, said("")), [][4]any{{"w1:fix:2", InboxKindFix, "加个打卡接口", callsT + 20}}},
		{"a conflict before any turn", callsSession("w1", PhaseResting{}, callsConflict("a.go"), noRun), [][4]any{{"w1:conflict:2", InboxKindConflict, "1 个文件和主分支冲突", callsT}}},
	} {
		t.Run(c.name, func(t *testing.T) { testkit.Eq(t, callsRows(Inbox(callsState(c.session))), c.want) })
	}
}

func TestInboxSessionCallIDs(t *testing.T) {
	idsOf := func(sessions ...Session) []string { return callsIDs(Inbox(callsState(sessions...))) }
	testkit.Eq(t, idsOf(callsSession("w1", PhaseRipe{})), []string{"w1:merge:2"})
	testkit.Eq(t, idsOf(callsSession("w1", PhaseRipe{}, func(h *Session) { h.LastRun.Summary, h.LastRun.At = "接口加好了，测试也补了", callsT+99 })), []string{"w1:merge:2"})
	nextRun := func(h *Session) { h.Runs = 3 }
	testkit.Eq(t, idsOf(callsSession("w1", PhaseRipe{}, nextRun)), []string{"w1:merge:3"})
	testkit.Eq(t, idsOf(callsSession("w1", PhaseFailed{}, callsFailedRun)), []string{"w1:fix:2"})
	testkit.Eq(t, idsOf(callsSession("w1", PhaseFailed{}, callsFailedRun, nextRun)), []string{"w1:fix:3"})
	testkit.Eq(t, idsOf(callsSession("w1", PhaseRipe{}, callsConflict("a.go"))), []string{"w1:conflict:2"})
	testkit.Eq(t, idsOf(callsSession("w1", PhaseRipe{}, callsConflict("a.go", "b.go", "c.go"))), []string{"w1:conflict:2"})
	testkit.Eq(t, idsOf(callsSession("w1", callsQuiet(callsT+90))), []string{"w1:quiet:1800000000090"})
	testkit.Eq(t, idsOf(callsSession("w1", callsQuiet(callsT+300))), []string{"w1:quiet:1800000000300"})
	testkit.Eq(t, idsOf(callsSession("w1", PhaseRipe{}), callsSession("w2", PhaseRipe{})), []string{"w1:merge:2", "w2:merge:2"})
}

func TestInboxTaskCalls(t *testing.T) {
	madeAt := func(graph TaskGraph, ms int64) TaskGraph {
		graph.CreatedAt = callsT + ms
		return graph
	}
	state := callsWithGraphs(
		madeAt(callsGraph("p1", "打卡", GraphStateDraft, callsTask("db", "建表", TaskStateWaiting)), 1),
		madeAt(callsGraph("p2", "导出", GraphStateRipe, callsTask("csv", "导出 CSV", TaskStateMerged), callsTask("pdf", "导出 PDF", TaskStateSkipped)), 2),
		madeAt(callsGraph("p3", "报表", GraphStateRunning,
			callsTask("db", "建表", TaskStateMerged),
			callsTask("api", "接口", TaskStateFailed),
			callsTask("job", "定时任务", TaskStateWorking),
			callsTask("ui", "页面", TaskStateFailed),
			callsTask("docs", "文档", TaskStateWaiting),
		), 3),
		madeAt(callsGraph("p4", "迁移", GraphStatePaused, callsTask("copy", "拷数据", TaskStateFailed), callsTask("drop", "删旧表", TaskStateSkipped)), 4),
	)
	testkit.Eq(t, Inbox(state), []InboxItem{
		{ID: "p4:failed:copy", Kind: InboxKindTaskFailed, From: callsManager, Text: "迁移：拷数据", At: callsT + 4, Target: callsToGraphs("p4")},
		{ID: "p3:failed:api", Kind: InboxKindTaskFailed, From: callsManager, Text: "报表：接口", At: callsT + 3, Target: callsToGraphs("p3")},
		{ID: "p3:failed:ui", Kind: InboxKindTaskFailed, From: callsManager, Text: "报表：页面", At: callsT + 3, Target: callsToGraphs("p3")},
		{ID: "p2:ripe", Kind: InboxKindGraphRipe, From: callsManager, Text: "导出", At: callsT + 2, Target: callsToGraphs("p2")},
		{ID: "p1:draft", Kind: InboxKindGraphDraft, From: callsManager, Text: "打卡", At: callsT + 1, Target: callsToGraphs("p1")},
	})
}

func TestInboxTasksThatDoNotCall(t *testing.T) {
	for _, c := range []struct {
		name string
		task TaskGraph
	}{
		{"still being split", callsGraph("p1", "打卡", GraphStateSplitting)},
		{"running with no step failed", callsGraph("p1", "打卡", GraphStateRunning,
			callsTask("db", "建表", TaskStateMerged), callsTask("api", "接口", TaskStateWorking), callsTask("ui", "页面", TaskStateWaiting), callsTask("docs", "文档", TaskStateSkipped))},
		{"paused with no step failed", callsGraph("p1", "打卡", GraphStatePaused, callsTask("api", "接口", TaskStateWaiting))},
		{"harvested", callsGraph("p1", "打卡", GraphStateDone, callsTask("api", "接口", TaskStateMerged))},
		{"abandoned with a step failed", callsGraph("p1", "打卡", GraphStateAbandoned, callsTask("api", "接口", TaskStateFailed))},
	} {
		t.Run(c.name, func(t *testing.T) { testkit.Eq(t, Inbox(callsWithGraphs(c.task)), []InboxItem{}) })
	}
}

func TestInboxTaskCallIDs(t *testing.T) {
	draft := callsGraph("p1", "打卡", GraphStateDraft, callsTask("api", "接口", TaskStateWaiting))
	edited := callsGraph("p1", "打卡和导出", GraphStateDraft, callsTask("api", "接口和导出", TaskStateWaiting), callsTask("csv", "导出", TaskStateWaiting))
	testkit.Eq(t, callsIDs(Inbox(callsWithGraphs(draft))), []string{"p1:draft"})
	testkit.Eq(t, callsIDs(Inbox(callsWithGraphs(edited))), []string{"p1:draft"})
	stuck := func(id string) TaskGraph {
		return callsGraph(id, "打卡", GraphStateRunning, callsTask("api", "接口", TaskStateFailed))
	}
	testkit.Eq(t, callsIDs(Inbox(callsWithGraphs(stuck("p1"), stuck("p2")))), []string{"p1:failed:api", "p2:failed:api"})
	again := stuck("p1")
	again.Tasks[0].Failures = 2
	testkit.Eq(t, callsIDs(Inbox(callsWithGraphs(again))), []string{"p1:failed:api:2"})
	once := stuck("p1")
	once.Tasks[0].Failures = 1
	testkit.Eq(t, callsIDs(Inbox(callsWithGraphs(once))), []string{"p1:failed:api"})
}

func TestInboxMentionCalls(t *testing.T) {
	state := callsWithChat(callsChat(nil, nil,
		callsMessage(4),
		callsMessage(5, callsInThread, func(m *ChatMessage) {
			m.From, m.FromKind, m.Name, m.Agent, m.Text = "w1", SenderKindAgent, "后端老周", ptr.To("lab"), "@主人 接口要按月查吗？"
		}),
		callsMessage(6, callsInThread, func(m *ChatMessage) {
			m.From, m.FromKind, m.Name, m.Text = "w2", SenderKindAgent, "前端小林", "@主人 页面缺设计稿"
		}),
	))
	testkit.Eq(t, Inbox(state), []InboxItem{
		{ID: "m6", Kind: InboxKindMention, From: callsFromSession("w2", "前端小林", ""), Text: "@主人 页面缺设计稿", At: callsT + 6, Target: callsToChat("c2")},
		{ID: "m5", Kind: InboxKindMention, From: callsFromSession("w1", "后端老周", "lab"), Text: "@主人 接口要按月查吗？", At: callsT + 5, Target: callsToChat("c2")},
		{ID: "m4", Kind: InboxKindMention, From: callsManager, Text: "@主人 这块地能收了", At: callsT + 4, Target: callsToChat("c1")},
	})
}

func TestInboxMessagesThatDoNotCall(t *testing.T) {
	farm := func(read *int64, m ChatMessage) CoreState { return callsWithChat(callsChat(read, nil, m)) }
	testkit.Eq(t, callsIDs(Inbox(farm(ptr.To(int64(4)), callsMessage(5)))), []string{"m5"})
	for _, c := range []struct {
		name   string
		read   *int64
		change func(*ChatMessage)
	}{
		{"still being said", nil, func(m *ChatMessage) { m.Final = false }},
		{"the owner's own, naming the owner", nil, func(m *ChatMessage) { m.From, m.FromKind, m.Name = "user", SenderKindUser, "主人" }},
		{"read", ptr.To(int64(5)), nil},
		{"read and more after it", ptr.To(int64(9)), nil},
		{"naming no one", nil, func(m *ChatMessage) { m.Mentions = nil }},
		{"naming others", nil, func(m *ChatMessage) { m.Mentions = []string{"w1", ManagerAgent} }},
		{"in a conversation the chat does not keep", nil, func(m *ChatMessage) { m.Conversation = "c9" }},
	} {
		t.Run(c.name, func(t *testing.T) {
			m := callsMessage(5)
			if c.change != nil {
				c.change(&m)
			}
			testkit.Eq(t, Inbox(farm(c.read, m)), []InboxItem{})
		})
	} // Answered, even unread: the person said something in that conversation after it.
	answer := callsMessage(6, func(m *ChatMessage) { m.From, m.FromKind, m.Name, m.Mentions = "user", SenderKindUser, "主人", nil })
	testkit.Eq(t, Inbox(callsWithChat(callsChat(nil, nil, callsMessage(5), answer))), []InboxItem{})
}

func TestInboxReadMarkerIsPerConversation(t *testing.T) {
	state := callsWithChat(callsChat(ptr.To(int64(7)), nil, callsMessage(3), callsMessage(4, callsInThread), callsMessage(7), callsMessage(8)))
	testkit.Eq(t, callsIDs(Inbox(state)), []string{"m8", "m4"})
}

func TestInboxClipTheirWords(t *testing.T) {
	// 40 UTF-16 units, as the page counts them.
	fits, long := strings.Repeat("改", 40), strings.Repeat("改", 41)
	clipped := fits + "…"
	said := func(summary string) func(*Session) { return func(h *Session) { h.LastRun.Summary = summary } }
	task := func(task string) func(*Session) { return func(h *Session) { h.Brief = task } }
	for _, c := range []struct {
		name  string
		state CoreState
		want  string
	}{
		{"a summary that fits", callsState(callsSession("w1", PhaseRipe{}, said(fits))), fits},
		{"a long summary", callsState(callsSession("w1", PhaseRipe{}, said(long))), clipped},
		{"a failed turn's long summary", callsState(callsSession("w1", PhaseFailed{}, callsFailedRun, said(long))), clipped},
		{"a long task, the turn saying nothing", callsState(callsSession("w1", PhaseRipe{}, said(""), task(long))), clipped},
		{"two-unit characters, 40 units", callsState(callsSession("w1", PhaseRipe{}, said(strings.Repeat("🌾", 20)))), strings.Repeat("🌾", 20)},
		{"two-unit characters, 42 units", callsState(callsSession("w1", PhaseRipe{}, said(strings.Repeat("🌾", 21)))), strings.Repeat("🌾", 20) + "…"},
		{"a quiet session's long task", callsState(callsSession("w1", callsQuiet(callsT+90), task(long))), clipped},
		{"a draft's long title", callsWithGraphs(callsGraph("p1", long, GraphStateDraft)), clipped},
		{"a ripe task's long title", callsWithGraphs(callsGraph("p1", long, GraphStateRipe)), clipped},
		{"a stuck step with its task's title", callsWithGraphs(callsGraph("p1", strings.Repeat("计", 30), GraphStateRunning,
			callsTask("api", strings.Repeat("步", 10), TaskStateFailed))), strings.Repeat("计", 30) + "：" + strings.Repeat("步", 9) + "…"},
		{"a long message", callsWithChat(callsChat(nil, nil, callsMessage(5, func(m *ChatMessage) { m.Text = long }))), clipped},
	} {
		t.Run(c.name, func(t *testing.T) {
			texts := []string{}
			for _, call := range Inbox(c.state) {
				texts = append(texts, call.Text)
			}
			testkit.Eq(t, texts, []string{c.want})
		})
	}
}

func TestInboxNewestFirst(t *testing.T) {
	endedAt := func(at int64) func(*Session) { return func(h *Session) { h.LastRun.At = at } }
	state := callsState(
		callsSession("w1", PhaseRipe{}, endedAt(callsT+30)),
		callsSession("w2", PhaseFailed{}, callsFailedRun),
		callsSession("w3", PhaseResting{}, callsConflict("a.go"), endedAt(callsT+10)),
		callsSession("w4", callsQuiet(callsT+40)),
		callsSession("w5", PhaseArriving{}),
	)
	draft := callsGraph("p1", "打卡", GraphStateDraft)
	draft.CreatedAt = callsT + 5
	stuck := callsGraph("p2", "导出", GraphStateRunning, callsTask("csv", "导出 CSV", TaskStateFailed))
	stuck.CreatedAt = callsT + 25
	state = withGraphs(state, draft, stuck)
	state.Chat = callsChat(nil, nil, callsMessage(50))
	timeline := [][2]any{}
	for _, c := range Inbox(state) {
		timeline = append(timeline, [2]any{c.ID, c.At})
	}
	testkit.Eq(t, timeline, [][2]any{
		{"m50", callsT + 50},
		{"w4:quiet:1800000000040", callsT + 40},
		{"w1:merge:2", callsT + 30},
		{"p2:failed:csv", callsT + 25},
		{"w2:fix:2", callsT + 20},
		{"w3:conflict:2", callsT + 10},
		{"p1:draft", callsT + 5},
	})
}

func TestInboxTiesKeepTheirOrder(t *testing.T) {
	endedNow := func(h *Session) { h.LastRun.At = callsT }
	saidNow := func(m *ChatMessage) { m.At = callsT }
	state := callsState(callsSession("w2", PhaseRipe{}, endedNow), callsSession("w1", PhaseFailed{}, callsFailedRun, endedNow))
	state = withGraphs(state,
		callsGraph("p2", "导出", GraphStateDraft),
		callsGraph("p1", "报表", GraphStateRunning, callsTask("b", "页面", TaskStateFailed), callsTask("a", "接口", TaskStateFailed)),
	)
	state.Chat = callsChat(nil, nil, callsMessage(3, callsInThread, saidNow), callsMessage(4, saidNow))
	testkit.Eq(t, callsIDs(Inbox(state)), []string{"w2:merge:2", "w1:fix:2", "p1:failed:b", "p1:failed:a", "p2:draft", "m4", "m3"})
}

func TestInboxSchedulesWaitingForTheOwnerCall(t *testing.T) {
	waiting := Schedule{ID: "s1", Name: "每天看测试", Channel: "c1", By: ScheduleByManager, Pending: true, Created: callsT}
	on := Schedule{ID: "s2", Name: "早会", Channel: "c1", By: ScheduleByManager, Enabled: true, Created: callsT + 1}
	testkit.Eq(t, Inbox(CoreState{Schedules: []Schedule{waiting, on}}), []InboxItem{
		{ID: "s1:ask", Kind: InboxKindScheduleAsk, From: callsManager, Text: "每天看测试", At: callsT, Target: callsToChat("c1")},
	})
}
