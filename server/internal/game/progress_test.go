package game

import (
	"strings"
	"testing"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

// A weekday afternoon, so no secret is found by accident: Tuesday 2026-10-13, 14:00 local time.
var progressAt = time.Date(2026, 10, 13, 14, 0, 0, 0, time.Local).UnixMilli()

func progressHarvested(session string, change ...func(*protocol.LedgerEntryHarvested)) protocol.LedgerEntry {
	e := protocol.LedgerEntryHarvested{At: progressAt, Session: session, Project: "clock", Runtime: "pi", Commits: 2, Runs: 1}
	for _, c := range change {
		c(&e)
	}
	return protocol.LedgerEntry{Value: e}
}

func progressKind(kind protocol.LedgerEntryMomentKind) protocol.LedgerEntry {
	return protocol.LedgerEntry{Value: protocol.LedgerEntryMoment{Kind: kind, At: progressAt}}
}

func progressUnlockIDs(list []protocol.Unlock, prefix string) []string {
	out := []string{}
	for _, u := range list {
		if strings.HasPrefix(u.ID, prefix) {
			out = append(out, u.ID+"#"+string(rune('0'+u.Tier)))
		}
	}
	return out
}

func progressHas(p protocol.Progress, id string, tier int64) bool {
	for _, u := range p.Unlocked {
		if u.ID == id && (tier == 0 || u.Tier == tier) {
			return true
		}
	}
	return false
}

func TestLevels(t *testing.T) {
	for _, c := range [][3]int64{{0, 1, 0}, {9, 1, 9}, {10, 2, 0}, {100, 5, 0}, {280, 8, 0}, {660, 12, 0}} {
		level, xp := protocol.LevelForCommits(c[0])
		testkit.Eq(t, [2]int64{level, xp}, [2]int64{c[1], c[2]})
	}
	for _, level := range []int64{1, 2, 5, 12} {
		l, xp := protocol.LevelForCommits(commitsForLevel(level))
		testkit.Eq(t, [2]int64{l, xp}, [2]int64{level, 0})
	}
}

func TestHarvestPays(t *testing.T) {
	testkit.Eq(t, harvestCoins(2, 1), int64(40))
	testkit.Eq(t, harvestCoins(20, 1), int64(60))
	testkit.Eq(t, streakMultiplier(6), 1.5)
	testkit.Eq(t, streakMultiplier(30), 2.0)

	folded, news := progressStep(emptyFolded(), progressHarvested("w1"))
	testkit.Eq(t, news, protocol.ProgressNews{Coins: ptr.To(int64(60)), Session: ptr.To("w1"), Unlocked: []protocol.Unlock{{ID: "harvests", Tier: 1, At: progressAt}, {ID: "first_try", Tier: 1, At: progressAt}}})
	testkit.Eq(t, []int64{folded.Progress.Coins, folded.Progress.Streak, folded.Progress.Counts["harvests"]}, []int64{60, 1, 1})
}

func TestFailedEndsStreak(t *testing.T) {
	p := progressOf([]protocol.LedgerEntry{progressHarvested("w1"), progressHarvested("w2"), {Value: protocol.LedgerEntryFailed{At: progressAt, Session: "w3"}}, progressHarvested("w3", func(e *protocol.LedgerEntryHarvested) { e.Runs = 2 })})
	testkit.Eq(t, p.Streak, int64(1))
	testkit.Eq(t, p.BestStreak, int64(2))
	testkit.Eq(t, p.Counts["comeback"], int64(1))
	testkit.Eq(t, p.Counts["first_try"], int64(2))
}

func TestFirstTry(t *testing.T) {
	has := func(entries ...protocol.LedgerEntry) bool {
		_, ok := progressOf(entries).Counts["first_try"]
		return ok
	}
	if has(progressHarvested("w1", func(e *protocol.LedgerEntryHarvested) { e.Runs = 3 })) {
		t.Fatal("three turns")
	}
	if has(protocol.LedgerEntry{Value: protocol.LedgerEntryTold{At: progressAt, Session: "w1"}}, progressHarvested("w1")) {
		t.Fatal("told")
	}
	testkit.Eq(t, progressOf([]protocol.LedgerEntry{{Value: protocol.LedgerEntryTold{At: progressAt, Session: "w2"}}, progressHarvested("w1")}).Counts["first_try"], int64(1))
}

func TestConflictsCheapRuntimes(t *testing.T) {
	p := progressOf([]protocol.LedgerEntry{
		{Value: protocol.LedgerEntryConflicted{At: progressAt, Session: "w1"}},
		progressHarvested("w1", func(e *protocol.LedgerEntryHarvested) { e.CNY = ptr.To(0.01) }),
		progressHarvested("w2", func(e *protocol.LedgerEntryHarvested) { e.Runtime = "claude" }),
		progressHarvested("w3", func(e *protocol.LedgerEntryHarvested) { e.Runtime = "claude"; e.CNY = ptr.To(0.2) }),
	})
	testkit.Eq(t, p.Counts["untangle"], int64(1))
	testkit.Eq(t, p.Counts["thrifty"], int64(1))
	testkit.Eq(t, p.Counts["every_machine"], int64(2))
	if !progressHas(p, "every_machine", 1) {
		t.Fatal("every_machine")
	}
}

func TestStarterTasks(t *testing.T) {
	p := progressOf([]protocol.LedgerEntry{
		progressKind(protocol.LedgerEntryMomentKindOpened),
		progressKind(protocol.LedgerEntryMomentKindOpened),
		{Value: protocol.LedgerEntryHired{At: progressAt, Session: "w1"}},
		{Value: protocol.LedgerEntryReviewed{At: progressAt, Session: "w1"}},
		progressHarvested("w1"),
	})
	testkit.Eq(t, progressUnlockIDs(p.Unlocked, "s_"), []string{"s_open#1", "s_hire#1", "s_review#1"})
	testkit.Eq(t, p.Coins, int64(60+40+20))
	if _, ok := progressOf([]protocol.LedgerEntry{{Value: protocol.LedgerEntryReviewed{At: progressAt, Session: "w2"}}, progressHarvested("w1")}).Counts["s_review"]; ok {
		t.Fatal("s_review for another session")
	}
}

func TestPlaybookHarvested(t *testing.T) {
	p := progressOf([]protocol.LedgerEntry{{Value: protocol.LedgerEntryPlaybook{At: progressAt, Playbook: "p1", Merged: 5, Parallel: true}}})
	testkit.Eq(t, p.Counts["big_playbook"], int64(5))
	testkit.Eq(t, p.Counts["parallel_plan"], int64(1))
	testkit.Eq(t, progressUnlockIDs(p.Unlocked, ""), []string{"big_playbook#1", "big_playbook#2", "parallel_plan#1"})
	testkit.Eq(t, p.Coins, int64(80+40+10))
}

func TestTiersInOrder(t *testing.T) {
	var twenty []protocol.LedgerEntry
	for i := range 20 {
		twenty = append(twenty, progressHarvested("w"+string(rune('a'+i))))
	}
	p := progressOf(twenty)
	testkit.Eq(t, progressUnlockIDs(p.Unlocked, "harvests"), []string{"harvests#1", "harvests#2"})
	testkit.Eq(t, p.Counts["steady"], int64(20))
	if !progressHas(p, "steady", 2) {
		t.Fatal("steady#2")
	}
}

func TestSecrets(t *testing.T) {
	night := time.Date(2026, 10, 13, 3, 0, 0, 0, time.Local).UnixMilli()
	saturday := time.Date(2026, 10, 17, 14, 0, 0, 0, time.Local).UnixMilli()
	if !progressHas(progressOf([]protocol.LedgerEntry{progressHarvested("w1", func(e *protocol.LedgerEntryHarvested) { e.At = night })}), "night_owl", 0) {
		t.Fatal("night_owl")
	}
	if !progressHas(progressOf([]protocol.LedgerEntry{progressHarvested("w1", func(e *protocol.LedgerEntryHarvested) { e.At = saturday })}), "weekend", 0) {
		t.Fatal("weekend")
	}
	if !progressHas(progressOf([]protocol.LedgerEntry{progressKind(protocol.LedgerEntryMomentKindBusy6)}), "full_house", 0) {
		t.Fatal("full_house")
	}
}

func TestTitles(t *testing.T) {
	titled := func(id string, tier int64) protocol.LedgerEntry {
		if id == "" {
			return protocol.LedgerEntry{Value: protocol.LedgerEntryTitled{At: progressAt}}
		}
		return protocol.LedgerEntry{Value: protocol.LedgerEntryTitled{At: progressAt, Achievement: &id, Tier: &tier}}
	}
	twice := []protocol.LedgerEntry{progressHarvested("w1"), progressHarvested("w2")}
	of := func(more ...protocol.LedgerEntry) protocol.Progress {
		return progressOf(append(append([]protocol.LedgerEntry{}, twice...), more...))
	}
	testkit.Eq(t, of(titled("harvests", 2)).Title, (*protocol.ProgressTitle)(nil))
	testkit.Eq(t, of(titled("harvests", 1)).Title, &protocol.ProgressTitle{ID: "harvests", Tier: 1})
	testkit.Eq(t, of(titled("harvests", 1), titled("", 0)).Title, (*protocol.ProgressTitle)(nil))
	testkit.Eq(t, progressOf([]protocol.LedgerEntry{progressKind(protocol.LedgerEntryMomentKindOpened), titled("s_open", 1)}).Title, (*protocol.ProgressTitle)(nil))
}

func TestCarried(t *testing.T) {
}

func progressSession(id string, phase protocol.PhaseValue) protocol.Session {
	return protocol.Session{ID: id, Name: id, Agent: "lab", Runtime: "pi", Task: "…", HiredAt: 0, Runs: 0, Phase: protocol.Phase{Value: phase}}
}

var progressWorkingPhase = protocol.PhaseWorking{Since: 0, Doing: protocol.Doing{Action: protocol.SessionActionThinking, Label: ""}}

func progressTold(before protocol.CoreState, fact protocol.Fact) []string {
	after, _ := protocol.Reduce(before, fact)
	out := []string{}
	for _, e := range entriesFor(before, fact, after) {
		body, _ := e.MarshalJSON()
		kind := string(body)
		kind = kind[strings.Index(kind, `"kind":"`)+8:]
		out = append(out, kind[:strings.Index(kind, `"`)])
	}
	return out
}

func TestEntriesForFacts(t *testing.T) {
	farm := protocol.EmptyCoreState()
	farm.Sessions = []protocol.Session{progressSession("w1", progressWorkingPhase)}
	testkit.Eq(t, progressTold(farm, protocol.Fact{Value: protocol.FactReport{At: 1, ID: "w1", Outcome: protocol.OutcomeFailed, Runs: 1}}), []string{"failed"})
	testkit.Eq(t, progressTold(farm, protocol.Fact{Value: protocol.FactReport{At: 1, ID: "w1", Outcome: protocol.OutcomeCompleted, Runs: 1}}), []string{})
	testkit.Eq(t, progressTold(farm, protocol.Fact{Value: protocol.FactConflict{At: 1, ID: "w1", Conflict: &protocol.Conflict{Base: "main", Files: []string{"a.ts"}}}}), []string{"conflicted"})
	testkit.Eq(t, progressTold(farm, protocol.Fact{Value: protocol.FactCall{At: 1, State: protocol.CallStateLive}}), []string{"opened"})
	testkit.Eq(t, progressTold(farm, protocol.Fact{Value: protocol.FactHired{At: 1, Session: progressSession("w2", protocol.PhaseArriving{})}}), []string{"hired"})
}

func TestEntriesFromLeavingAndMessages(t *testing.T) {
	farm := protocol.EmptyCoreState()
	w1 := progressSession("w1", protocol.PhaseRipe{})
	w1.Project, w1.Runs, w1.Spent = ptr.To("clock"), 2, &protocol.Spent{Tokens: 900, CNY: ptr.To(0.5)}
	farm.Sessions = []protocol.Session{w1, progressSession("w2", progressWorkingPhase)}
	harvested, merged := protocol.IssueCloseMerged, int64(3)
	left := protocol.Fact{Value: protocol.FactLeft{At: 1, ID: "w1", Closed: &harvested, Merged: &merged}}
	after, _ := protocol.Reduce(farm, left)
	testkit.Eq(t, entriesFor(farm, left, after), []protocol.LedgerEntry{{Value: protocol.LedgerEntryHarvested{
		Session: "w1", Agent: ptr.To("lab"), Project: "clock", Runtime: "pi", Commits: 3, CNY: ptr.To(0.5), Runs: 2,
	}}})
	none := int64(0)
	testkit.Eq(t, progressTold(farm, protocol.Fact{Value: protocol.FactLeft{At: 1, ID: "w1", Closed: &harvested, Merged: &none}}), []string{})
	dismissed := protocol.IssueCloseDismissed
	testkit.Eq(t, progressTold(farm, protocol.Fact{Value: protocol.FactLeft{At: 1, ID: "w1", Closed: &dismissed}}), []string{})

	said := func(seq int64, from string, kind protocol.SenderKind, mentions ...string) protocol.ChatMessage {
		return protocol.ChatMessage{Seq: seq, Conversation: 7, From: from, FromKind: kind, Name: from, Kind: protocol.MessageKindChat, Text: "…", Final: true, Mentions: mentions, At: 1}
	}
	thread := ptr.To("w1")
	testkit.Eq(t, progressTold(farm, protocol.Fact{Value: protocol.FactMessage{At: 1, Message: said(1, "user", protocol.SenderKindUser), Thread: thread}}), []string{"told"})
	testkit.Eq(t, progressTold(farm, protocol.Fact{Value: protocol.FactMessage{At: 1, Message: said(2, "user", protocol.SenderKindUser, "w2", protocol.ManagerAgent, protocol.Everyone, "w9")}}), []string{"called"})
	testkit.Eq(t, progressTold(farm, protocol.Fact{Value: protocol.FactMessage{At: 1, Message: said(3, protocol.ManagerAgent, protocol.SenderKindManager, "w2"), Thread: thread}}), []string{})
	answered := protocol.Fact{Value: protocol.FactMessage{At: 1, Message: said(4, "w2", protocol.SenderKindAgent), Answers: ptr.To("w1")}}
	after, _ = protocol.Reduce(farm, answered)
	testkit.Eq(t, entriesFor(farm, answered, after), []protocol.LedgerEntry{{Value: protocol.LedgerEntryHandoff{Session: "w1", To: "w2"}}})
	streaming := protocol.Fact{Value: protocol.FactMessage{At: 1, Message: said(5, "user", protocol.SenderKindUser), Thread: thread}}
	seen, _ := protocol.Reduce(farm, streaming)
	testkit.Eq(t, progressTold(seen, streaming), []string{})
}

func TestAgentRecords(t *testing.T) {
	lab, zhou := ptr.To("lab"), ptr.To("zhou")
	p := progressOf([]protocol.LedgerEntry{
		{Value: protocol.LedgerEntryHired{At: progressAt, Session: "w1", Agent: lab}},
		{Value: protocol.LedgerEntryHired{At: progressAt, Session: "w2", Agent: lab}},
		{Value: protocol.LedgerEntryHired{At: progressAt, Session: "w3", Agent: zhou}},
		{Value: protocol.LedgerEntryFailed{At: progressAt, Session: "w1", Agent: lab}},
		progressHarvested("w1", func(e *protocol.LedgerEntryHarvested) { e.Agent = lab }),
		progressHarvested("w3", func(e *protocol.LedgerEntryHarvested) { e.Agent = zhou }),
		{Value: protocol.LedgerEntryHired{At: progressAt, Session: "w0"}},
		progressHarvested("w0"),
	})
	testkit.Eq(t, p.Agents, map[string]protocol.AgentTally{"lab": {Hired: 2, Harvested: 1, Failed: 1}, "zhou": {Hired: 1, Harvested: 1, Failed: 0}})
	testkit.Eq(t, progressOf([]protocol.LedgerEntry{progressKind(protocol.LedgerEntryMomentKindOpened)}).Agents, map[string]protocol.AgentTally(nil))
}

func TestEntriesWithAgent(t *testing.T) {
	farm := protocol.EmptyCoreState()
	farm.Sessions = []protocol.Session{progressSession("w1", progressWorkingPhase)}
	fact := protocol.Fact{Value: protocol.FactReport{At: 1, ID: "w1", Outcome: protocol.OutcomeFailed, Runs: 1}}
	after, _ := protocol.Reduce(farm, fact)
	testkit.Eq(t, entriesFor(farm, fact, after), []protocol.LedgerEntry{{Value: protocol.LedgerEntryFailed{Session: "w1", Agent: ptr.To("lab")}}})
	came := protocol.Fact{Value: protocol.FactHired{At: 1, Session: progressSession("w2", protocol.PhaseArriving{})}}
	after, _ = protocol.Reduce(farm, came)
	testkit.Eq(t, entriesFor(farm, came, after), []protocol.LedgerEntry{{Value: protocol.LedgerEntryHired{Session: "w2", Agent: ptr.To("lab")}}})
}

func TestEntriesPlaybooksLevelsBeds(t *testing.T) {
	pb := protocol.Playbook{ID: "p1", Title: "菱形", Goal: "", Project: "x", State: protocol.PlaybookStatePlanning, Parallel: 3, CreatedAt: 0, Nodes: []protocol.PlaybookNode{
		{ID: "a", Title: "a", Task: "a", Needs: []string{}, State: protocol.NodeStateMerged},
		{ID: "b", Title: "b", Task: "b", Needs: []string{}, State: protocol.NodeStateMerged},
	}}
	in := func(s protocol.PlaybookState) protocol.Playbook { p := pb; p.State = s; return p }
	parent := func(state protocol.CoreState, s protocol.PlaybookState) protocol.Fact {
		return protocol.Fact{Value: protocol.FactIssue{At: 2, Issue: protocol.PlaybookIssues(in(s), state.Issues, 2)[0]}}
	}
	planning := progressWithPlaybooks(protocol.EmptyCoreState(), pb)
	testkit.Eq(t, progressTold(planning, parent(planning, protocol.PlaybookStateDraft)), []string{"planned"})
	ripe := progressWithPlaybooks(protocol.EmptyCoreState(), in(protocol.PlaybookStateRipe))
	done := parent(ripe, protocol.PlaybookStateDone)
	after, _ := protocol.Reduce(ripe, done)
	testkit.Eq(t, entriesFor(ripe, done, after), []protocol.LedgerEntry{{Value: protocol.LedgerEntryPlaybook{Playbook: "p1", Merged: 2, Parallel: true}}})
	testkit.Eq(t, progressTold(after, done), []string{})

	counted, _ := protocol.Reduce(protocol.EmptyCoreState(), protocol.Fact{Value: protocol.FactCommits{At: 1, Commits: protocol.CommitCount{Total: 95}}})
	testkit.Eq(t, entriesFor(counted, protocol.Fact{Value: protocol.FactCommits{At: 2, Commits: protocol.CommitCount{Total: 100}}}, counted), []protocol.LedgerEntry{{Value: protocol.LedgerEntryLevel{Level: 5}}})
	testkit.Eq(t, progressTold(counted, protocol.Fact{Value: protocol.FactCommits{At: 2, Commits: protocol.CommitCount{Total: 99}}}), []string{})

	five := protocol.EmptyCoreState()
	for _, id := range []string{"w1", "w2", "w3", "w4", "w5"} {
		five.Sessions = append(five.Sessions, progressSession(id, progressWorkingPhase))
	}
	five.Sessions = append(five.Sessions, progressSession("w6", protocol.PhaseResting{}))
	testkit.Eq(t, progressTold(five, protocol.Fact{Value: protocol.FactRun{At: 1, ID: "w6"}}), []string{"busy6"})
}

func TestCatchUp(t *testing.T) {
	farm := protocol.EmptyCoreState()
	farm.Commits = &protocol.CommitCount{Total: 100}
	testkit.Eq(t, catchUp(farm), []protocol.LedgerEntry{{Value: protocol.LedgerEntryLevel{Level: 5}}})
	p := progressOf(nil)
	p.Counts = map[string]int64{"farm_level": 5}
	farm.Progress = &p
	testkit.Eq(t, catchUp(farm), []protocol.LedgerEntry{})
}

// The progress the entries fold to.
func progressOf(entries []protocol.LedgerEntry) protocol.Progress {
	return progressFold(entries, emptyFolded()).Progress
}

func commitsForLevel(level int64) int64 {
	var total int64
	for l := int64(1); l < level; l++ {
		total += protocol.XPToNext(l)
	}
	return total
}

// JavaScript's numbers, not a fused multiply-add's (arm64): the coins must not depend on the machine.
func TestStreakIsJavaScriptsNumber(t *testing.T) {
	for _, streak := range []int64{8} { // not a constant, which the compiler would fold exactly
		testkit.Eq(t, streakMultiplier(streak), 1.7000000000000002)
		testkit.Eq(t, harvestCoins(1, streak), int64(60), "35 × 1.7000000000000002 rounds up")
	}
}

func progressWithPlaybooks(state protocol.CoreState, playbooks ...protocol.Playbook) protocol.CoreState {
	for _, pb := range playbooks {
		for _, issue := range protocol.PlaybookIssues(pb, nil, pb.CreatedAt) {
			state, _ = protocol.Reduce(state, protocol.Fact{Value: protocol.FactIssue{Issue: issue}})
		}
	}
	return state
}
