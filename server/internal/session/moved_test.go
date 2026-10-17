package session

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"vibevalley/internal/testkit"
)

// An old home's activities become events: each record's keys and type renamed, the head as it was, the old folder gone.
func TestActivitiesMoveToEvents(t *testing.T) {
	home := t.TempDir()
	old, now := filepath.Join(home, "activities"), filepath.Join(home, "events")
	os.MkdirAll(old, 0o755)
	os.WriteFile(filepath.Join(old, "w3.json"), []byte(`[{"n":1,"at":5,"kind":"prompt","text":"写打卡"},{"n":2,"at":6,"kind":"action","text":"跑测试","ok":true}]`), 0o644)
	os.WriteFile(filepath.Join(old, "w3.head.json"), []byte(`{"id":"w3","name":"阿郑","startedAt":5}`), 0o644)
	if err := moveActivities(old, now); err != nil {
		t.Fatal(err)
	}
	log, _ := os.ReadFile(filepath.Join(now, "w3.json"))
	head, _ := os.ReadFile(filepath.Join(now, "w3.head.json"))
	for _, want := range []string{`"seq":1`, `"time":5`, `"type":"user/message"`, `"type":"tool/call"`, `"ok":true`} {
		if !strings.Contains(string(log), want) {
			t.Fatalf("no %s in %s", want, log)
		}
	}
	if string(head) != `{"id":"w3","name":"阿郑","startedAt":5}` {
		t.Fatalf("head %s", head)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("activities/ is still there")
	}
	steps := readJournal(filepath.Join(now, "w3.json"))
	if len(steps) != 2 || steps[0].Seq != 1 || steps[1].Type != "tool/call" {
		t.Fatalf("read back %+v", steps)
	}
}

// A call that carried its output gets its result as an event of its own, and the log is numbered again with its references.
func TestResultsSplitFromTheirCalls(t *testing.T) {
	old := `[{"seq":0,"time":1,"type":"tool/call","text":"派个帮手","output":"看完了","ok":true},` +
		`{"seq":1,"time":2,"type":"tool/call","text":"ls","under":0,"output":"a.ts","ok":true},` +
		`{"seq":2,"time":3,"type":"user/message","text":"再看看","on":1}]`
	moved, ok := splitResults([]byte(old))
	if !ok {
		t.Fatal("not split")
	}
	var got []map[string]any
	json.Unmarshal(moved, &got)
	var lines []string
	for _, r := range got {
		lines = append(lines, fmt.Sprintf("%v %v %v %v %v %v", r["seq"], r["type"], r["output"], r["call"], r["under"], r["on"]))
	}
	testkit.Eq(t, lines, []string{
		"0 tool/call <nil> <nil> <nil> <nil>",
		"1 tool/result 看完了 0 <nil> <nil>",
		"2 tool/call <nil> <nil> 0 <nil>",
		"3 tool/result a.ts 2 0 <nil>",
		"4 user/message <nil> <nil> <nil> 2",
	}, "split and numbered again")
	if _, ok := splitResults(moved); ok {
		t.Fatal("split twice")
	}
}
