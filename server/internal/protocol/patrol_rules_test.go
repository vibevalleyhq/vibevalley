package protocol

import (
	"regexp"
	"testing"
)

const (
	patrolT   = int64(1_800_000_000_000)
	patrolMin = int64(60_000)
)

func patrolHelper(change func(*Helper)) Helper {
	h := Helper{ID: "w1", Name: "后端老周", Agent: "lab", Runtime: "pi", Task: "加个接口", HiredAt: patrolT, Turns: 1, Phase: Phase{PhaseResting{}}}
	change(&h)
	return h
}

func patrolMessage(change func(*ChatMessage)) ChatMessage {
	m := ChatMessage{Seq: 10, Conversation: 2, From: "w1", FromKind: SenderKindHelper, Name: "后端老周", Kind: MessageKindChat, Text: "@主人 接口要按月查吗？", Final: true, Mentions: []string{"user"}, At: patrolT}
	change(&m)
	return m
}

func patrolChat(messages ...ChatMessage) *Chat {
	return &Chat{
		Conversations: []Conversation{
			{ID: 1, Kind: ConversationKindSquare, Name: rulesPtr("田头"), At: patrolT},
			{ID: 5, Kind: ConversationKindChannel, Name: rulesPtr("ops"), At: patrolT},
			{ID: 2, Kind: ConversationKindThread, Parent: rulesPtr(int64(3)), Channel: rulesPtr(int64(5)), SubjectKind: rulesPtr(SubjectKindJob), SubjectID: rulesPtr("w1"), Replies: 1, At: patrolT},
		},
		Messages: messages,
	}
}

func patrolFarm(chat *Chat) FarmState {
	s := EmptyFarm()
	s.Chat = chat
	return s
}

func patrolMatch(t *testing.T, text, pattern string) {
	t.Helper()
	if !regexp.MustCompile(pattern).MatchString(text) {
		t.Fatalf("%q does not match %s", text, pattern)
	}
}

func patrolBriefs(state FarmState) []PatrolNote {
	_, memory := PatrolStep(state, patrolT, EmptyPatrol())
	notes, _ := PatrolStep(state, patrolT+24*60*patrolMin, memory)
	return notes
}

func TestPatrolAsk(t *testing.T) {
	asked := patrolFarm(patrolChat(patrolMessage(func(*ChatMessage) {})))
	found := patrolBriefs(asked)
	rulesEqual(t, len(found), 1)
	rulesEqual(t, found[0].Key, "m10")
	rulesEqual(t, *found[0].Channel, int64(5))
	patrolMatch(t, found[0].Text, `后端老周 在 #ops:3 问主人的话，24 小时没人回`)
	answered := patrolFarm(patrolChat(patrolMessage(func(*ChatMessage) {}), patrolMessage(func(m *ChatMessage) {
		m.Seq, m.From, m.FromKind, m.Name, m.Text, m.Mentions = 11, "user", SenderKindUser, "主人", "按月", []string{}
	})))
	rulesEqual(t, patrolBriefs(answered), []PatrolNote{})
	notAsked := patrolFarm(patrolChat(patrolMessage(func(m *ChatMessage) { m.Mentions = []string{"foreman"} })))
	rulesEqual(t, patrolBriefs(notAsked), []PatrolNote{})
}

func TestPatrolQuietRipeStep(t *testing.T) {
	pb := Playbook{ID: "p1", Title: "打卡", Project: "demo", State: PlaybookStateRunning, Parallel: 2, CreatedAt: patrolT,
		Nodes: []PlaybookNode{{ID: "api", Title: "接口", Needs: []string{}, State: NodeStateFailed, Tries: 1, Conclusion: rulesPtr("测试没过")}}}
	draft := Playbook{ID: "p2", Title: "导出", Project: "demo", State: PlaybookStateDraft, Parallel: 1, CreatedAt: patrolT}
	state := patrolFarm(patrolChat())
	state = withPlaybooks(state, pb, draft)
	state.Helpers = []Helper{
		patrolHelper(func(h *Helper) {
			h.Phase = Phase{PhaseWorking{Since: patrolT, Doing: Doing{Action: WorkerActionRunCommand, Label: "pnpm test"}, QuietSince: rulesPtr(patrolT + patrolMin)}}
		}),
		patrolHelper(func(h *Helper) {
			h.ID, h.Name, h.Channel, h.Phase = "w2", "前端小林", rulesPtr(int64(5)), Phase{PhaseRipe{}}
			h.Last = &LastTurn{Outcome: OutcomeCompleted, Summary: "好了", At: patrolT}
		}),
		patrolHelper(func(h *Helper) {
			h.ID, h.Phase = "w3", Phase{PhaseFailed{}}
			h.Last = &LastTurn{Outcome: OutcomeFailed, Summary: "测试没过", At: patrolT}
		}),
	}
	got := [][2]any{}
	for _, f := range patrolBriefs(state) {
		got = append(got, [2]any{f.Key, *f.Channel})
	}
	rulesEqual(t, got, [][2]any{{"w1:quiet:1800000060000", int64(1)}, {"w2:harvest:1", int64(5)}, {"p1:failed:api", int64(1)}})
	notes := patrolBriefs(state)
	patrolMatch(t, notes[0].Text, `^后端老周（w1）在干活，24 小时没动静了，最后在「pnpm test」$`)
	patrolMatch(t, notes[1].Text, `^前端小林（w2）的活做完 24 小时了还没收：「加个接口」$`)
	patrolMatch(t, notes[2].Text, `步骤 api「接口」没做成，.+没人管了：测试没过$`)
}

func TestPatrolGraceAndMemory(t *testing.T) {
	asked := patrolFarm(patrolChat(patrolMessage(func(*ChatMessage) {})))
	grace := PatrolGrace[InboxKindMention]
	early, memory := PatrolStep(asked, patrolT+grace-patrolMin, EmptyPatrol())
	rulesEqual(t, early, []PatrolNote{})
	due, memory := PatrolStep(asked, patrolT+grace, memory)
	rulesEqual(t, len(due), 1)
	patrolMatch(t, due[0].Text, `15 分钟没人回`)
	quiet, _ := PatrolStep(asked, patrolT+grace+30*patrolMin, memory)
	rulesEqual(t, quiet, []PatrolNote{})
	again, memory := PatrolStep(asked, patrolT+grace+ReportAgainMS, memory)
	rulesEqual(t, len(again), 1)
	patrolMatch(t, again[0].Text, `4 小时没人回`)
	_, gone := PatrolStep(EmptyFarm(), patrolT+grace+ReportAgainMS+patrolMin, memory)
	rulesEqual(t, len(gone.Reported), 0)
	rulesEqual(t, len(gone.FirstSeen), 0)
}

func TestPatrolCountsFromFirstSeen(t *testing.T) {
	// A failed step has no time of its own: its grace counts from when the patrol first saw it.
	pb := Playbook{ID: "p1", Title: "打卡", Project: "demo", State: PlaybookStatePaused, Parallel: 1, CreatedAt: patrolT,
		Nodes: []PlaybookNode{{ID: "api", Title: "接口", Needs: []string{}, State: NodeStateFailed}}}
	state := EmptyFarm()
	state = withPlaybooks(state, pb)
	first, memory := PatrolStep(state, patrolT, EmptyPatrol())
	rulesEqual(t, first, []PatrolNote{})
	early, _ := PatrolStep(state, patrolT+PatrolGrace[InboxKindPlanFailed]-patrolMin, memory)
	rulesEqual(t, early, []PatrolNote{})
	due, _ := PatrolStep(state, patrolT+PatrolGrace[InboxKindPlanFailed], memory)
	rulesEqual(t, len(due), 1)
}

func TestPatrolText(t *testing.T) {
	text := PatrolText("ops", []PatrolNote{{Key: "a", Text: "一"}, {Key: "b", Text: "二"}})
	rulesEqual(t, text, "【巡查】#ops 里有几件事放着没人管：\n- 一\n- 二\n\n看看要不要提醒主人（一两句，说在 #ops）、催帮工或者叫停；都不用管就什么也别说。")
}
