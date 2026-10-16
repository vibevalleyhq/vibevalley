package protocol

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Times of day are read in Asia/Shanghai.
func TestPlayRulesGolden(t *testing.T) {
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	local := time.Local
	time.Local = shanghai
	defer func() { time.Local = local }()

	cases := readCases(t, "testdata/play.jsonl.gz")
	line := 0
	seen := map[string]int{}
	for _, body := range cases.lines {
		line++
		cases.begin(line)
		var row struct {
			Kind   string          `json:"kind"`
			Input  json.RawMessage `json:"input"`
			Output json.RawMessage `json:"output"`
		}
		if err := json.Unmarshal(body, &row); err != nil {
			t.Fatalf("line %d: %v", line, err)
		}
		seen[row.Kind]++
		var want map[string]json.RawMessage
		_ = json.Unmarshal(row.Output, &want)
		same := func(what string, got any) { playSame(t, line, row.Kind+" "+what, got, want[what], "output", what) }
		switch row.Kind {
		case "playbook":
			var in struct {
				PB     Playbook `json:"pb"`
				After  Playbook `json:"after"`
				Fresh  bool     `json:"fresh"`
				Edit   NodeEdit `json:"edit"`
				ID     string   `json:"id"`
				Output string   `json:"output"`
				Index  int      `json:"index"`
			}
			playDecode(t, line, row.Input, &in)
			pb := in.PB
			ids := func(nodes []PlaybookNode) []string { return rulesIDs(nodes) }
			same("problems", PlanProblems(pb.Nodes))
			same("layers", LayersOf(pb.Nodes))
			same("ready", ids(ReadyNodes(pb)))
			same("startable", ids(Startable(pb)))
			same("asks", AsksForYou(pb))
			same("settled", AllSettled(pb))
			same("spent", PlaybookSpent(pb))
			same("text", PlaybookText(pb))
			blocked := [][]string{}
			for _, n := range pb.Nodes {
				blocked = append(blocked, BlockedBy(pb, n))
			}
			same("blocked", blocked)
			if in.Index < len(pb.Nodes) {
				same("task", NodeTask(pb, pb.Nodes[in.Index]))
			} else {
				same("task", nil)
			}
			same("checkFailed", CheckFailedText("pnpm test", in.Output))
			checks, touched := [][]string{}, [][]string{}
			for _, n := range pb.Nodes {
				checks = append(checks, AcceptanceChecks(pb, n))
				touched = append(touched, FrozenTouched(pb, n, []string{"test/a_test.go", "src/x.ts", "README.md"}))
			}
			same("acceptanceChecks", checks)
			same("frozenTouched", touched)
			same("acceptancePassed", AcceptancePassedText(in.Output))
			same("frozenText", FrozenTouchedText([]string{"test/a_test.go", in.Output}))
			same("edited", playEdited(EditNode(pb, in.ID, in.Edit)))
			same("removed", playEdited(RemoveNode(pb, in.ID)))
			before := &pb
			if in.Fresh {
				before = nil
			}
			changes := PlaybookChanges(before, in.After)
			same("changes", changes)
			titles := map[string]string{}
			for _, n := range pb.Nodes {
				titles[n.ID] = "T" + n.Title
			}
			titleOf := func(id string) string {
				if title, ok := titles[id]; ok {
					return title
				}
				return id
			}
			texts := [][2]string{}
			for _, c := range changes {
				texts = append(texts, [2]string{PlaybookEventText(c, nil), PlaybookEventText(c, titleOf)})
			}
			same("eventTexts", texts)
		case "plan":
			var in struct {
				Text string `json:"text"`
			}
			playDecode(t, line, row.Input, &in)
			got := ParsePlan(in.Text)
			if *update {
				out := map[string]any{"ok": got.OK}
				if got.OK {
					if got.Title != nil {
						out["title"] = *got.Title
					}
					out["nodes"] = got.Nodes
				} else {
					out["problems"] = got.Problems
				}
				recorded(out, "output")
				break
			}
			var tsPlan struct {
				OK       bool              `json:"ok"`
				Title    *string           `json:"title"`
				Nodes    []json.RawMessage `json:"nodes"`
				Problems []string          `json:"problems"`
			}
			_ = json.Unmarshal(row.Output, &tsPlan)
			if got.OK != tsPlan.OK {
				t.Fatalf("line %d plan: ok %v, want %v (%q; %v)", line, got.OK, tsPlan.OK, in.Text, got.Problems)
			}
			if got.OK {
				same("title", got.Title)
				same("nodes", got.Nodes)
				break
			}
			// The words of a block that is not JSON, or not a plan, are each language's own.
			if len(tsPlan.Problems) == 1 && len(got.Problems) == 1 {
				for _, prefix := range []string{"json 读不了：", "计划的格式不对："} {
					if strings.HasPrefix(tsPlan.Problems[0], prefix) {
						if !strings.HasPrefix(got.Problems[0], prefix) {
							t.Fatalf("line %d plan: %q, want %q", line, got.Problems[0], tsPlan.Problems[0])
						}
						tsPlan.Problems[0], got.Problems[0] = prefix, prefix
					}
				}
			}
			playSame(t, line, "plan problems", got.Problems, mustJSON(tsPlan.Problems))
		case "nextId":
			var in struct {
				State playState `json:"state"`
			}
			playDecode(t, line, row.Input, &in)
			ids := []string{}
			for _, pb := range PlaybooksOf(in.State.FarmState) {
				ids = append(ids, pb.ID)
			}
			playSame(t, line, "nextId", NextPlaybookID(ids), row.Output, "output")
		case "ledger":
			var in struct {
				Entries []LedgerEntry `json:"entries"`
			}
			playDecode(t, line, row.Input, &in)
			var steps []json.RawMessage
			_ = json.Unmarshal(want["steps"], &steps)
			folded := EmptyFolded()
			for i, e := range in.Entries {
				var news ProgressNews
				folded, news = ProgressStep(folded, e)
				p := folded.Progress
				playSame(t, line, "ledger step", map[string]any{"coins": p.Coins, "streak": p.Streak, "title": p.Title, "news": news}, steps[i], "output", "steps", i)
			}
			same("progress", folded.Progress)
			same("seen", folded.Seen)
			standings := []AchievementStanding{}
			for _, a := range Achievements {
				standings = append(standings, Standing(folded.Progress, a))
			}
			same("standing", standings)
			playSame(t, line, "ledger fold", ProgressOf(in.Entries), want["progress"], "output", "progress")
		case "entries":
			var in struct {
				Before playState       `json:"before"`
				Fact   json.RawMessage `json:"fact"`
			}
			playDecode(t, line, row.Input, &in)
			before, fact := playFact(t, line, in.Before.FarmState, in.Fact)
			after, _ := Reduce(before, fact)
			same("entries", playWithoutAt(EntriesFor(before, fact, after)))
			same("catchUp", playWithoutAt(CatchUp(before)))
		case "schedule":
			var in struct {
				S   FarmSchedule    `json:"s"`
				Now int64           `json:"now"`
				Req ScheduleRequest `json:"req"`
			}
			playDecode(t, line, row.Input, &in)
			s := in.S
			if next, ok := NextRun(s); ok {
				same("next", next)
			} else {
				same("next", nil)
			}
			if !strings.Contains(string(want["nextText"]), `"thrown"`) {
				same("nextText", NextText(s))
			}
			if !strings.Contains(string(want["whenText"]), `"thrown"`) {
				same("whenText", WhenText(s.When, s.TZ))
			}
			same("missed", IsMissed(s, in.Now))
			same("due", len(DueSchedules([]FarmSchedule{s}, in.Now)))
			if problem := ScheduleProblem(in.Req, in.Now); problem != "" {
				same("problem", problem)
			} else {
				same("problem", nil)
			}
		case "patrol":
			var in struct {
				State playState `json:"state"`
			}
			playDecode(t, line, row.Input, &in)
			same("inbox", Inbox(in.State.FarmState))
			var rounds []struct {
				Now int64 `json:"now"`
			}
			var raw []json.RawMessage
			_ = json.Unmarshal(want["rounds"], &rounds)
			_ = json.Unmarshal(want["rounds"], &raw)
			memory := EmptyPatrol()
			for r, round := range rounds {
				state := in.State.FarmState
				if r%5 == 4 {
					state = EmptyFarm()
				}
				var report []PatrolNote
				report, memory = PatrolStep(state, round.Now, memory)
				playSame(t, line, "patrol round", map[string]any{"now": round.Now, "report": report, "firstSeen": memory.FirstSeen, "reported": memory.Reported}, raw[r], "output", "rounds", r)
			}
		default:
			t.Fatalf("line %d: no kind %q", line, row.Kind)
		}
		cases.end()
	}
	cases.close()
	for _, kind := range []string{"playbook", "plan", "nextId", "ledger", "entries", "schedule", "patrol"} {
		if seen[kind] < 20 {
			t.Fatalf("only %d %s cases", seen[kind], kind)
		}
	}
}

// playState is a recorded state, with the playbooks it was recorded with (when they were the state's own) put in as
// their issues.
type playState struct{ FarmState }

func (s *playState) UnmarshalJSON(body []byte) error {
	var legacy struct {
		Playbooks []Playbook `json:"playbooks"`
	}
	if err := json.Unmarshal(body, &s.FarmState); err != nil {
		return err
	}
	if err := json.Unmarshal(body, &legacy); err != nil {
		return err
	}
	s.FarmState = withPlaybooks(s.FarmState, legacy.Playbooks...)
	return nil
}

// playFact is a recorded fact on before. A playbook fact, recorded when a playbook was the state's own, is now its
// issues: the steps first, then the parent issue as the fact.
func playFact(t *testing.T, line int, before FarmState, raw json.RawMessage) (FarmState, Fact) {
	var legacy struct {
		Type     string   `json:"type"`
		At       int64    `json:"at"`
		Playbook Playbook `json:"playbook"`
	}
	playDecode(t, line, raw, &legacy)
	if legacy.Type != "playbook" {
		var fact Fact
		playDecode(t, line, raw, &fact)
		return before, fact
	}
	issues := PlaybookIssues(legacy.Playbook, before.Issues, legacy.At)
	for _, step := range issues[1:] {
		before, _ = Reduce(before, Fact{FactIssue{At: legacy.At, Issue: step}})
	}
	return before, Fact{FactIssue{At: legacy.At, Issue: issues[0]}}
}

func playDecode(t *testing.T, line int, raw json.RawMessage, v any) {
	t.Helper()
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("line %d: %v", line, err)
	}
}

func mustJSON(v any) json.RawMessage {
	body, _ := json.Marshal(v)
	return body
}

func playEdited(e Edited) map[string]any {
	if e.OK {
		return map[string]any{"ok": true, "playbook": e.Playbook}
	}
	return map[string]any{"ok": false, "problem": e.Problem}
}

func playWithoutAt(entries []LedgerEntry) []map[string]any {
	out := []map[string]any{}
	for _, e := range entries {
		var m map[string]any
		_ = json.Unmarshal(mustJSON(e), &m)
		delete(m, "at")
		out = append(out, m)
	}
	return out
}

func playSame(t *testing.T, line int, what string, got any, want json.RawMessage, path ...any) {
	t.Helper()
	if recorded(got, path...) {
		return
	}
	body, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("line %d %s: %v", line, what, err)
	}
	var a, b any
	_ = json.Unmarshal(body, &a)
	if len(want) == 0 {
		want = json.RawMessage("null")
	}
	_ = json.Unmarshal(want, &b)
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("line %d %s:\n got %s\nwant %s", line, what, body, want)
	}
}
