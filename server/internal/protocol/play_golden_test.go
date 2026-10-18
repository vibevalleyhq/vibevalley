package protocol

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibevalley/internal/golden"
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

	cases := golden.Read(t, "testdata/play.jsonl.gz")
	line := 0
	seen := map[string]int{}
	for _, body := range cases.Lines {
		line++
		cases.Begin(line)
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
		case "task":
			var in struct {
				TaskGraph TaskGraph `json:"task"`
				After     TaskGraph `json:"after"`
				Fresh     bool      `json:"fresh"`
			}
			playDecode(t, line, row.Input, &in)
			graph := in.TaskGraph
			ids := func(tasks []Task) []string { return rulesIDs(tasks) }
			same("problems", GraphProblems(graph.Tasks))
			same("layers", LayersOf(graph.Tasks))
			same("ready", ids(ReadyTasks(graph)))
			same("asks", AsksForYou(graph))
			same("spent", GraphSpent(graph))
			same("text", GraphText(graph))
			blocked := [][]string{}
			for _, n := range graph.Tasks {
				blocked = append(blocked, BlockedBy(graph, n))
			}
			same("blocked", blocked)
			checks := [][]string{}
			for _, n := range graph.Tasks {
				checks = append(checks, AcceptanceChecks(graph, n))
			}
			same("acceptanceChecks", checks)
			before := &graph
			if in.Fresh {
				before = nil
			}
			changes := GraphChanges(before, in.After)
			same("changes", changes)
			titles := map[string]string{}
			for _, n := range graph.Tasks {
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
				texts = append(texts, [2]string{GraphEventText(c, nil), GraphEventText(c, titleOf)})
			}
			same("eventTexts", texts)
		case "schedule":
			var in struct {
				S   Schedule        `json:"s"`
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
			if problem := ScheduleProblem(in.Req, in.Now); problem != "" {
				same("problem", problem)
			} else {
				same("problem", nil)
			}
		case "patrol":
			var in struct {
				State CoreState `json:"state"`
			}
			playDecode(t, line, row.Input, &in)
			same("inbox", Inbox(in.State))
		default:
			t.Fatalf("line %d: no kind %q", line, row.Kind)
		}
		cases.End()
	}
	cases.Close()
	for _, kind := range []string{"task", "schedule", "patrol"} {
		if seen[kind] < 20 {
			t.Fatalf("only %d %s cases", seen[kind], kind)
		}
	}
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

func playSame(t *testing.T, line int, what string, got any, want json.RawMessage, path ...any) {
	t.Helper()
	if golden.Recorded(got, path...) {
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
