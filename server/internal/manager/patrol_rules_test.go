package manager

import (
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

const (
	patrolT   = int64(1_800_000_000_000)
	patrolMin = int64(60_000)
)

func patrolSession(change func(*protocol.Session)) protocol.Session {
	h := protocol.Session{ID: "w1", Name: "后端老周", Agent: "lab", Runtime: "pi", Brief: "加个接口", HiredAt: patrolT, Runs: 1, Phase: protocol.Phase{Value: protocol.PhaseResting{}}}
	change(&h)
	return h
}

func patrolMessage(change func(*protocol.ChatMessage)) protocol.ChatMessage {
	m := protocol.ChatMessage{ID: "m10", Number: 10, Conversation: "x2", From: "w1", FromKind: protocol.SenderKindAgent, Name: "后端老周", Kind: protocol.MessageKindChat, Text: "@主人 接口要按月查吗？", Final: true, Mentions: []string{"user"}, At: patrolT}
	change(&m)
	return m
}

func patrolChat(messages ...protocol.ChatMessage) *protocol.Chat {
	return &protocol.Chat{
		Conversations: []protocol.Conversation{
			{ID: "x1", Kind: protocol.ConversationKindGeneral, Name: ptr.To("田头"), At: patrolT},
			{ID: "x5", Kind: protocol.ConversationKindChannel, Name: ptr.To("ops"), At: patrolT},
			{ID: "x2", Kind: protocol.ConversationKindThread, Parent: ptr.To("m3"), ParentNumber: ptr.To[int64](3), Channel: ptr.To("x5"), SubjectKind: ptr.To(protocol.SubjectKindIssue), SubjectID: ptr.To("w1"), Replies: 1, At: patrolT},
		},
		Messages: messages,
	}
}

func patrolFarm(chat *protocol.Chat) protocol.CoreState {
	s := protocol.EmptyCoreState()
	s.Chat = chat
	return s
}

func patrolBriefs(state protocol.CoreState) []patrolNote {
	_, memory := patrolStep(state, patrolT, emptyPatrol())
	notes, _ := patrolStep(state, patrolT+24*60*patrolMin, memory)
	return notes
}

func TestPatrolAsk(t *testing.T) {
	asked := patrolFarm(patrolChat(patrolMessage(func(*protocol.ChatMessage) {})))
	found := patrolBriefs(asked)
	testkit.Eq(t, len(found), 1)
	testkit.Eq(t, found[0].Key, "m10")
	testkit.Eq(t, *found[0].Channel, "x5")
	testkit.Match(t, found[0].Text, `后端老周 在 #ops:3 问主人的话，24 小时没人回`)
	answered := patrolFarm(patrolChat(patrolMessage(func(*protocol.ChatMessage) {}), patrolMessage(func(m *protocol.ChatMessage) {
		m.ID, m.Number, m.From, m.FromKind, m.Name, m.Text, m.Mentions = "m11", 11, "user", protocol.SenderKindUser, "主人", "按月", []string{}
	})))
	testkit.Eq(t, patrolBriefs(answered), []patrolNote{})
	notAsked := patrolFarm(patrolChat(patrolMessage(func(m *protocol.ChatMessage) { m.Mentions = []string{protocol.ManagerAgent} })))
	testkit.Eq(t, patrolBriefs(notAsked), []patrolNote{})
}

func TestPatrolQuietRipeStep(t *testing.T) {
	graph := protocol.TaskGraph{ID: "p1", Title: "打卡", Project: "demo", State: protocol.GraphStateRunning, Parallel: 2, CreatedAt: patrolT,
		Tasks: []protocol.Task{{ID: "api", Title: "接口", Needs: []string{}, State: protocol.TaskStateFailed, Tries: 1, Conclusion: ptr.To("测试没过")}}}
	draft := protocol.TaskGraph{ID: "p2", Title: "导出", Project: "demo", State: protocol.GraphStateDraft, Parallel: 1, CreatedAt: patrolT}
	state := patrolFarm(patrolChat())
	state = patrolWithTasks(state, graph, draft)
	state.Sessions = []protocol.Session{
		patrolSession(func(h *protocol.Session) {
			h.Phase = protocol.Phase{Value: protocol.PhaseWorking{Since: patrolT, Doing: protocol.Doing{Action: protocol.SessionActionRunCommand, Label: "pnpm test"}, QuietSince: ptr.To(patrolT + patrolMin)}}
		}),
		patrolSession(func(h *protocol.Session) {
			h.ID, h.Name, h.Channel, h.Phase = "w2", "前端小林", ptr.To("x5"), protocol.Phase{Value: protocol.PhaseRipe{}}
			h.LastRun = &protocol.LastRun{Outcome: protocol.OutcomeCompleted, Summary: "好了", At: patrolT}
		}),
		patrolSession(func(h *protocol.Session) {
			h.ID, h.Phase = "w3", protocol.Phase{Value: protocol.PhaseFailed{}}
			h.LastRun = &protocol.LastRun{Outcome: protocol.OutcomeFailed, Summary: "测试没过", At: patrolT}
		}),
	}
	got := [][2]any{}
	for _, f := range patrolBriefs(state) {
		got = append(got, [2]any{f.Key, *f.Channel})
	}
	testkit.Eq(t, got, [][2]any{{"w1:quiet:1800000060000", "x1"}, {"w2:merge:1", "x5"}, {"p1:failed:api", "x1"}})
	notes := patrolBriefs(state)
	testkit.Match(t, notes[0].Text, `^后端老周（w1）在干活，24 小时没动静了，最后在「pnpm test」$`)
	testkit.Match(t, notes[1].Text, `^前端小林（w2）的活做完 24 小时了还没收：「加个接口」$`)
	testkit.Match(t, notes[2].Text, `步骤 api「接口」没做成，.+没人管了：测试没过$`)
}

func TestPatrolGraceAndMemory(t *testing.T) {
	asked := patrolFarm(patrolChat(patrolMessage(func(*protocol.ChatMessage) {})))
	grace := patrolGrace[protocol.InboxKindMention]
	early, memory := patrolStep(asked, patrolT+grace-patrolMin, emptyPatrol())
	testkit.Eq(t, early, []patrolNote{})
	due, memory := patrolStep(asked, patrolT+grace, memory)
	testkit.Eq(t, len(due), 1)
	testkit.Match(t, due[0].Text, `15 分钟没人回`)
	quiet, _ := patrolStep(asked, patrolT+grace+30*patrolMin, memory)
	testkit.Eq(t, quiet, []patrolNote{})
	again, memory := patrolStep(asked, patrolT+grace+reportAgainMs, memory)
	testkit.Eq(t, len(again), 1)
	testkit.Match(t, again[0].Text, `4 小时没人回`)
	_, gone := patrolStep(protocol.EmptyCoreState(), patrolT+grace+reportAgainMs+patrolMin, memory)
	testkit.Eq(t, len(gone.Reported), 0)
	testkit.Eq(t, len(gone.FirstSeen), 0)
}

func TestPatrolCountsFromFirstSeen(t *testing.T) {
	// A failed step has no time of its own: its grace counts from when the patrol first saw it.
	graph := protocol.TaskGraph{ID: "p1", Title: "打卡", Project: "demo", State: protocol.GraphStatePaused, Parallel: 1, CreatedAt: patrolT,
		Tasks: []protocol.Task{{ID: "api", Title: "接口", Needs: []string{}, State: protocol.TaskStateFailed}}}
	state := protocol.EmptyCoreState()
	state = patrolWithTasks(state, graph)
	first, memory := patrolStep(state, patrolT, emptyPatrol())
	testkit.Eq(t, first, []patrolNote{})
	early, _ := patrolStep(state, patrolT+patrolGrace[protocol.InboxKindTaskFailed]-patrolMin, memory)
	testkit.Eq(t, early, []patrolNote{})
	due, _ := patrolStep(state, patrolT+patrolGrace[protocol.InboxKindTaskFailed], memory)
	testkit.Eq(t, len(due), 1)
}

func TestPatrolText(t *testing.T) {
	text := patrolText("ops", []patrolNote{{Key: "a", Text: "一"}, {Key: "b", Text: "二"}})
	testkit.Eq(t, text, "【巡查】#ops 里有几件事放着没人管：\n- 一\n- 二\n\n看看要不要提醒主人（一两句，说在 #ops）、催帮工或者叫停；都不用管就什么也别说。")
}

func patrolWithTasks(state protocol.CoreState, graphs ...protocol.TaskGraph) protocol.CoreState {
	for _, graph := range graphs {
		for _, issue := range protocol.GraphIssues(graph, nil, graph.CreatedAt) {
			state, _ = protocol.Reduce(state, protocol.Fact{Value: protocol.FactIssue{Issue: issue}})
		}
	}
	return state
}
