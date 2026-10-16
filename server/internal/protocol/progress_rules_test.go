package protocol

import (
	"strings"
	"testing"
	"time"
)

// A weekday afternoon, so no secret is found by accident: Tuesday 2026-10-13, 14:00 local time.
var progressAt = time.Date(2026, 10, 13, 14, 0, 0, 0, time.Local).UnixMilli()

func progressHarvested(helper string, change ...func(*LedgerEntryHarvested)) LedgerEntry {
	e := LedgerEntryHarvested{At: progressAt, Helper: helper, Project: "clock", Runtime: "pi", Commits: 2, Turns: 1}
	for _, c := range change {
		c(&e)
	}
	return LedgerEntry{e}
}

func progressKind(kind LedgerEntryOpenedPlannedVoiceBusy6Kind) LedgerEntry {
	return LedgerEntry{LedgerEntryOpenedPlannedVoiceBusy6{Kind: kind, At: progressAt}}
}

func progressUnlockIDs(list []Unlock, prefix string) []string {
	out := []string{}
	for _, u := range list {
		if strings.HasPrefix(u.ID, prefix) {
			out = append(out, u.ID+"#"+string(rune('0'+u.Tier)))
		}
	}
	return out
}

func progressHas(p Progress, id string, tier int64) bool {
	for _, u := range p.Unlocked {
		if u.ID == id && (tier == 0 || u.Tier == tier) {
			return true
		}
	}
	return false
}

func TestLevels(t *testing.T) {
	for _, c := range [][3]int64{{0, 1, 0}, {9, 1, 9}, {10, 2, 0}, {100, 5, 0}, {280, 8, 0}, {660, 12, 0}} {
		level, xp := LevelForCommits(c[0])
		rulesEqual(t, [2]int64{level, xp}, [2]int64{c[1], c[2]})
	}
	for _, level := range []int64{1, 2, 5, 12} {
		l, xp := LevelForCommits(CommitsForLevel(level))
		rulesEqual(t, [2]int64{l, xp}, [2]int64{level, 0})
	}
}

func TestHarvestPays(t *testing.T) {
	rulesEqual(t, HarvestCoins(2, 1), int64(40))
	rulesEqual(t, HarvestCoins(20, 1), int64(60))
	rulesEqual(t, StreakMultiplier(6), 1.5)
	rulesEqual(t, StreakMultiplier(30), 2.0)

	folded, news := ProgressStep(EmptyFolded(), progressHarvested("w1"))
	rulesEqual(t, news, ProgressNews{Coins: rulesPtr(int64(60)), Helper: rulesPtr("w1"), Unlocked: []Unlock{{ID: "harvests", Tier: 1, At: progressAt}, {ID: "first_try", Tier: 1, At: progressAt}}})
	rulesEqual(t, []int64{folded.Progress.Coins, folded.Progress.Streak, folded.Progress.Counts["harvests"]}, []int64{60, 1, 1})
	rulesEqual(t, TierTitle(*AchievementOf("harvests"), 1), "开张大吉")
	rulesEqual(t, TierTitle(*AchievementOf("steady"), 3), "金牌稳如老农")
}

func TestFailedEndsStreak(t *testing.T) {
	p := ProgressOf([]LedgerEntry{progressHarvested("w1"), progressHarvested("w2"), {LedgerEntryFailed{At: progressAt, Helper: "w3"}}, progressHarvested("w3", func(e *LedgerEntryHarvested) { e.Turns = 2 })})
	rulesEqual(t, p.Streak, int64(1))
	rulesEqual(t, p.BestStreak, int64(2))
	rulesEqual(t, p.Counts["comeback"], int64(1))
	rulesEqual(t, p.Counts["first_try"], int64(2))
}

func TestFirstTry(t *testing.T) {
	has := func(entries ...LedgerEntry) bool { _, ok := ProgressOf(entries).Counts["first_try"]; return ok }
	if has(progressHarvested("w1", func(e *LedgerEntryHarvested) { e.Turns = 3 })) {
		t.Fatal("three turns")
	}
	if has(LedgerEntry{LedgerEntryTold{At: progressAt, Helper: "w1"}}, progressHarvested("w1")) {
		t.Fatal("told")
	}
	rulesEqual(t, ProgressOf([]LedgerEntry{{LedgerEntryTold{At: progressAt, Helper: "w2"}}, progressHarvested("w1")}).Counts["first_try"], int64(1))
}

func TestConflictsCheapRuntimes(t *testing.T) {
	p := ProgressOf([]LedgerEntry{
		{LedgerEntryConflicted{At: progressAt, Helper: "w1"}},
		progressHarvested("w1", func(e *LedgerEntryHarvested) { e.CNY = rulesPtr(0.01) }),
		progressHarvested("w2", func(e *LedgerEntryHarvested) { e.Runtime = "claude" }),
		progressHarvested("w3", func(e *LedgerEntryHarvested) { e.Runtime = "claude"; e.CNY = rulesPtr(0.2) }),
	})
	rulesEqual(t, p.Counts["untangle"], int64(1))
	rulesEqual(t, p.Counts["thrifty"], int64(1))
	rulesEqual(t, p.Counts["every_machine"], int64(2))
	if !progressHas(p, "every_machine", 1) {
		t.Fatal("every_machine")
	}
}

func TestStarterTasks(t *testing.T) {
	p := ProgressOf([]LedgerEntry{
		progressKind(LedgerEntryOpenedPlannedVoiceBusy6KindOpened),
		progressKind(LedgerEntryOpenedPlannedVoiceBusy6KindOpened),
		{LedgerEntryHired{At: progressAt, Helper: "w1"}},
		{LedgerEntryReviewed{At: progressAt, Helper: "w1"}},
		progressHarvested("w1"),
	})
	rulesEqual(t, progressUnlockIDs(p.Unlocked, "s_"), []string{"s_open#1", "s_hire#1", "s_review#1"})
	rulesEqual(t, p.Coins, int64(60+40+20))
	if _, ok := ProgressOf([]LedgerEntry{{LedgerEntryReviewed{At: progressAt, Helper: "w2"}}, progressHarvested("w1")}).Counts["s_review"]; ok {
		t.Fatal("s_review for another helper")
	}
}

func TestPlaybookHarvested(t *testing.T) {
	p := ProgressOf([]LedgerEntry{{LedgerEntryPlaybook{At: progressAt, Playbook: "p1", Merged: 5, Parallel: true}}})
	rulesEqual(t, p.Counts["big_playbook"], int64(5))
	rulesEqual(t, p.Counts["parallel_plan"], int64(1))
	rulesEqual(t, progressUnlockIDs(p.Unlocked, ""), []string{"big_playbook#1", "big_playbook#2", "parallel_plan#1"})
	rulesEqual(t, p.Coins, int64(80+40+10))
}

func TestTiersInOrder(t *testing.T) {
	var twenty []LedgerEntry
	for i := range 20 {
		twenty = append(twenty, progressHarvested("w"+string(rune('a'+i))))
	}
	p := ProgressOf(twenty)
	rulesEqual(t, progressUnlockIDs(p.Unlocked, "harvests"), []string{"harvests#1", "harvests#2"})
	rulesEqual(t, Standing(p, *AchievementOf("harvests")), AchievementStanding{Tier: 2, Count: 20, Next: rulesPtr(int64(100))})
	rulesEqual(t, p.Counts["steady"], int64(20))
	if !progressHas(p, "steady", 2) {
		t.Fatal("steady#2")
	}
}

func TestSecrets(t *testing.T) {
	night := time.Date(2026, 10, 13, 3, 0, 0, 0, time.Local).UnixMilli()
	saturday := time.Date(2026, 10, 17, 14, 0, 0, 0, time.Local).UnixMilli()
	if !progressHas(ProgressOf([]LedgerEntry{progressHarvested("w1", func(e *LedgerEntryHarvested) { e.At = night })}), "night_owl", 0) {
		t.Fatal("night_owl")
	}
	if !progressHas(ProgressOf([]LedgerEntry{progressHarvested("w1", func(e *LedgerEntryHarvested) { e.At = saturday })}), "weekend", 0) {
		t.Fatal("weekend")
	}
	if !progressHas(ProgressOf([]LedgerEntry{progressKind(LedgerEntryOpenedPlannedVoiceBusy6KindBusy6)}), "full_house", 0) {
		t.Fatal("full_house")
	}
}

func TestTitles(t *testing.T) {
	titled := func(id string, tier int64) LedgerEntry {
		if id == "" {
			return LedgerEntry{LedgerEntryTitled{At: progressAt}}
		}
		return LedgerEntry{LedgerEntryTitled{At: progressAt, Achievement: &id, Tier: &tier}}
	}
	twice := []LedgerEntry{progressHarvested("w1"), progressHarvested("w2")}
	of := func(more ...LedgerEntry) Progress {
		return ProgressOf(append(append([]LedgerEntry{}, twice...), more...))
	}
	rulesEqual(t, of(titled("harvests", 2)).Title, (*ProgressTitle)(nil))
	rulesEqual(t, of(titled("harvests", 1)).Title, &ProgressTitle{ID: "harvests", Tier: 1})
	rulesEqual(t, of(titled("harvests", 1), titled("", 0)).Title, (*ProgressTitle)(nil))
	rulesEqual(t, ProgressOf([]LedgerEntry{progressKind(LedgerEntryOpenedPlannedVoiceBusy6KindOpened), titled("s_open", 1)}).Title, (*ProgressTitle)(nil))
}

func TestCarried(t *testing.T) {
	rulesEqual(t, ProgressOf([]LedgerEntry{{LedgerEntryCarried{At: progressAt, Coins: 420}}}).Coins, int64(420))
}

func progressHelper(id string, phase PhaseValue) Helper {
	return Helper{ID: id, Name: id, Agent: "lab", Runtime: "pi", Task: "…", HiredAt: 0, Turns: 0, Phase: Phase{phase}}
}

var progressWorkingPhase = PhaseWorking{Since: 0, Doing: Doing{Action: WorkerActionThinking, Label: ""}}

func progressTold(before FarmState, fact Fact) []string {
	after, _ := Reduce(before, fact)
	out := []string{}
	for _, e := range EntriesFor(before, fact, after) {
		body, _ := e.MarshalJSON()
		kind := string(body)
		kind = kind[strings.Index(kind, `"kind":"`)+8:]
		out = append(out, kind[:strings.Index(kind, `"`)])
	}
	return out
}

func TestEntriesForFacts(t *testing.T) {
	farm := EmptyFarm()
	farm.Helpers = []Helper{progressHelper("w1", progressWorkingPhase)}
	rulesEqual(t, progressTold(farm, Fact{FactReport{At: 1, ID: "w1", Outcome: OutcomeFailed, Turns: 1}}), []string{"failed"})
	rulesEqual(t, progressTold(farm, Fact{FactReport{At: 1, ID: "w1", Outcome: OutcomeCompleted, Turns: 1}}), []string{})
	rulesEqual(t, progressTold(farm, Fact{FactConflict{At: 1, ID: "w1", Conflict: &Conflict{Base: "main", Files: []string{"a.ts"}}}}), []string{"conflicted"})
	rulesEqual(t, progressTold(farm, Fact{FactCall{At: 1, State: CallStateLive}}), []string{"opened"})
	rulesEqual(t, progressTold(farm, Fact{FactHired{At: 1, Helper: progressHelper("w2", PhaseArriving{})}}), []string{"hired"})
}

func TestEntriesFromLeavingAndMessages(t *testing.T) {
	farm := EmptyFarm()
	w1 := progressHelper("w1", PhaseRipe{})
	w1.Project, w1.Turns, w1.Spent = rulesPtr("clock"), 2, &Spent{Tokens: 900, CNY: rulesPtr(0.5)}
	farm.Helpers = []Helper{w1, progressHelper("w2", progressWorkingPhase)}
	harvested, merged := IssueCloseHarvested, int64(3)
	left := Fact{FactLeft{At: 1, ID: "w1", Closed: &harvested, Merged: &merged}}
	after, _ := Reduce(farm, left)
	rulesEqual(t, EntriesFor(farm, left, after), []LedgerEntry{{LedgerEntryHarvested{
		Helper: "w1", Agent: rulesPtr("lab"), Project: "clock", Runtime: "pi", Commits: 3, CNY: rulesPtr(0.5), Turns: 2,
	}}})
	none := int64(0)
	rulesEqual(t, progressTold(farm, Fact{FactLeft{At: 1, ID: "w1", Closed: &harvested, Merged: &none}}), []string{})
	dismissed := IssueCloseDismissed
	rulesEqual(t, progressTold(farm, Fact{FactLeft{At: 1, ID: "w1", Closed: &dismissed}}), []string{})

	said := func(seq int64, from string, kind SenderKind, mentions ...string) ChatMessage {
		return ChatMessage{Seq: seq, Conversation: 7, From: from, FromKind: kind, Name: from, Kind: MessageKindChat, Text: "…", Final: true, Mentions: mentions, At: 1}
	}
	thread := rulesPtr("w1")
	rulesEqual(t, progressTold(farm, Fact{FactMessage{At: 1, Message: said(1, "user", SenderKindUser), Thread: thread}}), []string{"told"})
	rulesEqual(t, progressTold(farm, Fact{FactMessage{At: 1, Message: said(2, "user", SenderKindUser, "w2", "foreman", Everyone, "w9")}}), []string{"called"})
	rulesEqual(t, progressTold(farm, Fact{FactMessage{At: 1, Message: said(3, "foreman", SenderKindForeman, "w2"), Thread: thread}}), []string{})
	answered := Fact{FactMessage{At: 1, Message: said(4, "w2", SenderKindHelper), Answers: rulesPtr("w1")}}
	after, _ = Reduce(farm, answered)
	rulesEqual(t, EntriesFor(farm, answered, after), []LedgerEntry{{LedgerEntryHandoff{Helper: "w1", To: "w2"}}})
	streaming := Fact{FactMessage{At: 1, Message: said(5, "user", SenderKindUser), Thread: thread}}
	seen, _ := Reduce(farm, streaming)
	rulesEqual(t, progressTold(seen, streaming), []string{})
}

func TestAgentRecords(t *testing.T) {
	lab, zhou := rulesPtr("lab"), rulesPtr("zhou")
	p := ProgressOf([]LedgerEntry{
		{LedgerEntryHired{At: progressAt, Helper: "w1", Agent: lab}},
		{LedgerEntryHired{At: progressAt, Helper: "w2", Agent: lab}},
		{LedgerEntryHired{At: progressAt, Helper: "w3", Agent: zhou}},
		{LedgerEntryFailed{At: progressAt, Helper: "w1", Agent: lab}},
		progressHarvested("w1", func(e *LedgerEntryHarvested) { e.Agent = lab }),
		progressHarvested("w3", func(e *LedgerEntryHarvested) { e.Agent = zhou }),
		{LedgerEntryHired{At: progressAt, Helper: "w0"}},
		progressHarvested("w0"),
	})
	rulesEqual(t, p.Agents, map[string]AgentTally{"lab": {Hired: 2, Harvested: 1, Failed: 1}, "zhou": {Hired: 1, Harvested: 1, Failed: 0}})
	rulesEqual(t, ProgressOf([]LedgerEntry{progressKind(LedgerEntryOpenedPlannedVoiceBusy6KindOpened)}).Agents, map[string]AgentTally(nil))
}

func TestEntriesWithAgent(t *testing.T) {
	farm := EmptyFarm()
	farm.Helpers = []Helper{progressHelper("w1", progressWorkingPhase)}
	fact := Fact{FactReport{At: 1, ID: "w1", Outcome: OutcomeFailed, Turns: 1}}
	after, _ := Reduce(farm, fact)
	rulesEqual(t, EntriesFor(farm, fact, after), []LedgerEntry{{LedgerEntryFailed{Helper: "w1", Agent: rulesPtr("lab")}}})
	came := Fact{FactHired{At: 1, Helper: progressHelper("w2", PhaseArriving{})}}
	after, _ = Reduce(farm, came)
	rulesEqual(t, EntriesFor(farm, came, after), []LedgerEntry{{LedgerEntryHired{Helper: "w2", Agent: rulesPtr("lab")}}})
}

func TestEntriesPlaybooksLevelsBeds(t *testing.T) {
	pb := Playbook{ID: "p1", Title: "菱形", Goal: "", Project: "x", State: PlaybookStatePlanning, Parallel: 3, CreatedAt: 0, Nodes: []PlaybookNode{
		{ID: "a", Title: "a", Task: "a", Needs: []string{}, State: NodeStateMerged},
		{ID: "b", Title: "b", Task: "b", Needs: []string{}, State: NodeStateMerged},
	}}
	in := func(s PlaybookState) Playbook { p := pb; p.State = s; return p }
	parent := func(state FarmState, s PlaybookState) Fact {
		return Fact{FactIssue{At: 2, Issue: PlaybookIssues(in(s), state.Issues, 2)[0]}}
	}
	planning := withPlaybooks(EmptyFarm(), pb)
	rulesEqual(t, progressTold(planning, parent(planning, PlaybookStateDraft)), []string{"planned"})
	ripe := withPlaybooks(EmptyFarm(), in(PlaybookStateRipe))
	done := parent(ripe, PlaybookStateDone)
	after, _ := Reduce(ripe, done)
	rulesEqual(t, EntriesFor(ripe, done, after), []LedgerEntry{{LedgerEntryPlaybook{Playbook: "p1", Merged: 2, Parallel: true}}})
	rulesEqual(t, progressTold(after, done), []string{})

	counted, _ := Reduce(EmptyFarm(), Fact{FactCommits{At: 1, Commits: CommitCount{Total: 95}}})
	rulesEqual(t, EntriesFor(counted, Fact{FactCommits{At: 2, Commits: CommitCount{Total: 100}}}, counted), []LedgerEntry{{LedgerEntryLevel{Level: 5}}})
	rulesEqual(t, progressTold(counted, Fact{FactCommits{At: 2, Commits: CommitCount{Total: 99}}}), []string{})

	five := EmptyFarm()
	for _, id := range []string{"w1", "w2", "w3", "w4", "w5"} {
		five.Helpers = append(five.Helpers, progressHelper(id, progressWorkingPhase))
	}
	five.Helpers = append(five.Helpers, progressHelper("w6", PhaseResting{}))
	rulesEqual(t, progressTold(five, Fact{FactTurn{At: 1, ID: "w6"}}), []string{"busy6"})
}

func TestCatchUp(t *testing.T) {
	farm := EmptyFarm()
	farm.Commits = &CommitCount{Total: 100}
	rulesEqual(t, CatchUp(farm), []LedgerEntry{{LedgerEntryLevel{Level: 5}}})
	p := ProgressOf(nil)
	p.Counts = map[string]int64{"farm_level": 5}
	farm.Progress = &p
	rulesEqual(t, CatchUp(farm), []LedgerEntry{})
}
